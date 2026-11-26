# Requirements: WEAVE, an Offline-First Application Foundation

## 1. Introduction

WEAVE is an open-source, reusable TypeScript library for building offline-first applications. Devices keep working with no connection, record changes independently, exchange those changes later, and end up with the same shared state.

Core idea: independent devices and records -> exchanged changes -> reconciled shared state.

WEAVE is built for the Kiroween 2026 Hackathon (Skeleton Crew category). It is shown through two small applications that both run on the real WEAVE engine and a real WEAVE relay server:

- **GHOSTLINE**: community coordination (announcements, requests, local information).
- **FIELDNOTE**: field operations (inspection records, observations, concurrent edits by field workers).

### 1.1 Repository state (inspected)

- `C:\Users\ashwi\Desktop\WEAVE` holds only a `.kiro` directory. There is no source code, no `package.json` and no tooling.
- The folder sits inside a Git repository rooted at the user's home directory (`C:\Users\ashwi`). That repository's current branch `main` has no commits. WEAVE must get its own Git repository at its root before any commit.
- No pre-existing project code exists, so nothing needs hackathon disclosure today. The final README must still state this, and must list any third-party code or templates added later.

### 1.2 Glossary

| Term | Meaning |
|---|---|
| Replica | One device's copy of the data, with a unique replica ID |
| Operation (op) | One recorded change to a record, immutable once written |
| Op log | The set of operations a replica holds |
| Collection | A named set of records of one schema (like a table) |
| Record | One item in a collection, with a stable ID |
| Sync | Exchanging missing operations between two replicas, or between a replica and the relay |
| Relay | The WEAVE relay server: a durable store-and-forward peer that every replica in the demos syncs through |
| Version vector | A map from replica ID to the highest contiguous sequence number held from that replica |
| Causal context | The accepted version vector a replica had when it wrote an op |
| Concurrent | Two ops where neither is in the other's causal context |
| Frontier (of a field) | The ops that set that field and that no other op setting that field causally follows |
| Conflict | A field whose frontier holds more than one op, or a delete with concurrent sets (R6.7) |
| Conflict ID | A hash that names a conflict by its sorted frontier op IDs (D8) |
| Resolver | A pure rule that turns a field's frontier into one value |
| Rank map | An ordered list of allowed values used by the max-rank resolver |
| Blocked origin | A replica whose ops stop being delivered to a receiver at the first op the receiver cannot read (R4.10) |
| Sync result | `complete`; `partial` with exactly one reason code, either `PEER_SCHEMA_OLDER` (at least one blocked origin, with the `seq` and required schema version of each) or `NOT_SETTLED` (the vectors still differed after the maximum number of rounds and nothing was blocked, R4.2); or `failed` (an error after retries, or a rejected origin). Reason priority: `failed`, then `PEER_SCHEMA_OLDER`, then `NOT_SETTLED`. |
| Accepted op | An op that is in the op log and the version vector (D1). An op waiting in the pending buffer for a sequence gap is **not** accepted. |
| Peer registry | The durable list of peers a replica knows, with what each has acknowledged |
| Stable horizon | The version vector that every registered member has acknowledged |
| Tombstone | The record of a delete that keeps the delete effective |
| Canonical encoding | The one byte sequence that represents a value or op (D7) |
| Adapter | A plug-in for storage or transport |
| Convergence | All replicas that hold the same op set hold the same state |

### 1.3 Scope

In scope: the WEAVE core library, storage and transport adapters, the relay server, the sync protocol, conflict handling, schema migrations, diagnostics, GHOSTLINE, FIELDNOTE, tests, docs, ADRs and hackathon packaging.

Out of scope: user accounts and login servers, end-to-end encryption, real-time collaborative text editing inside one field, native mobile apps, and large binary file sync (apps may store small binary data as base64 strings).

### 1.4 Sync assumptions (stated so the guarantees are testable)

- A1: Every replica has a unique ID. Replica IDs are never reused for a different replica.
- A2: Ops are never lost once written to local storage, apart from storage failure.
- A3: Transports may drop, delay, duplicate or reorder messages. They do not alter contents undetected (WEAVE checks integrity).
- A4: Any two replicas that can eventually reach each other, directly or through the relay, can exchange ops. A sync is complete only when both parties can read every schema version present (A7).
- A5: Replica wall clocks may be wrong or jump. WEAVE never uses wall-clock time for ordering, conflict resolution, deletion, expiry of correctness data or compaction. Wall-clock time may be stored only as display information.
- A6: A replica that is offline for a long time is still a known peer until it is explicitly removed (see R3).
- A7: Convergence is guaranteed among replicas that support every schema version present in the op sets and have exchanged the complete op sets. Replicas that deliberately hold different readable prefixes because of schema support (R4.10) are not claimed to hold the same op set or the same state until the older replica is upgraded and sync resumes.

### 1.5 Priority tiers

Every requirement and every acceptance criterion carries a tier tag.

- **[MVP]**: must be delivered, tested and demonstrated for the hackathon. The core engine, the relay, both apps and every engineering guarantee below are MVP.
- **[ADV]**: advanced capability. It is designed into the interfaces from the start so it can be added without breaking the API, but it ships only after all MVP gates pass. An [ADV] item that is not delivered is listed as "not implemented" in the README and is never presented as complete. In the MVP, any [ADV] feature that is requested at runtime (for example a `restore` op) SHALL fail with a typed `NOT_SUPPORTED` error and never behave in an undefined way.

No convergence, idempotency, determinism, integrity or crash-safety guarantee is [ADV]. Scope is reduced only by dropping extra features, never by weakening those guarantees.

### 1.6 Formal definitions (normative)

These definitions bind R2 to R8 and R14a.

**D1: Operation identity.** An op has an ID `(replicaId, seq)`. `seq` starts at 1 and increases by exactly 1 for each op written by that replica. A replica accepts a remote op from replica X only when it holds all earlier ops from X (contiguous). Out-of-order remote ops wait in a pending buffer and are not part of state until the gap is filled. Sequence numbers are global per replica, not per collection. Schema-aware delivery (R4.10) may stop delivery from one origin at its first unreadable op, so a receiver always holds a contiguous prefix of each origin's ops and never skips an op to deliver a later one.

**D2: Causal metadata.** Each op carries:
- `lamport`: an integer. When writing, a replica sets `lamport = 1 + max(lamport of every accepted op)` (1 if it has accepted none). Only **accepted** ops count: an op in the pending buffer does not contribute until it is promoted into the accepted log (D1).
- `context`: the writer's **accepted** version vector at write time, in full, covering every accepted op and no buffered op (a buffered op is not in the version vector until it is promoted, D1). **In the MVP the full vector is stored and transmitted as part of every op** (one representation, no reconstruction step). A compact storage encoding (only the entries that differ from the previous op by the same replica) is an optional later optimization: an implementation that uses it SHALL reconstruct the full vector before validation, hashing, transmission and ordering, and SHALL expose only the full form, because the hash always covers the full form (below).
- `collection`, `recordId`, `schemaVersion`.
- `kind`: `set` or `delete` in the MVP. The kind `restore` is reserved for [ADV] (D6). A `restore` op is rejected with `NOT_SUPPORTED` in the MVP.
- `fields`: for `set`, a map from field name to new value. Empty for `delete`.
- `hash`: SHA-256 over the canonical encoding (D7) of the complete immutable op payload, which is the object `{replicaId, seq, lamport, context, collection, recordId, kind, schemaVersion, fields}`. The `hash` field itself and the optional `wallTime` are excluded. The same definition is used when an op is created, when it is received and validated (R16.2), and by the relay (R4a.3). `context` is hashed in its full form (the complete version vector), not in the compact stored form.
- Optionally `wallTime`, for display only (A5). It is not covered by `hash`, is unauthenticated, and is never read by the engine.

**D3: Causal order.** Op A happens-before op B when A's ID is covered by B's `context`. Ops that do not happen-before each other in either direction are concurrent. A happens-before B implies `A.lamport < B.lamport`.

**D4: Total order.** The canonical total order on ops is ascending `(lamport, replicaId, seq)`, with `replicaId` compared as UTF-8 bytes. This order extends the causal order and is the same on every replica. It is the only tie-breaker WEAVE uses.

**D5: State as a function of the op set.** The state of a field is `resolve(frontier(field))`. `frontier(field)` is the set of ops that set that field and are not happens-before any other op that sets that field. The state of a record also depends on D6. State depends only on the set of ops held, never on arrival order or on any earlier computed result. When a late op changes a frontier, the field is recomputed from the full relevant set.

**D6: Record existence.**
- MVP: a record is deleted if and only if at least one `delete` op for it exists. A delete is permanent. A concurrent `set` does not keep the record live (delete wins, R6.7).
- [ADV] extension: a `restore` op names the delete ops it cancels: a delete D is cancelled by restore R when D happens-before R. A record is deleted if and only if at least one delete is not cancelled. Under the optional `update-wins` collection policy, a delete D is also ignored when some `set` op on the record is concurrent with D. Both are functions of the op set only. A restore concurrent with a new delete does not cancel that new delete.

**D7: Canonical encoding.** Ops, state and hashes use one deterministic encoding:
- Format: JSON text encoded as UTF-8, following RFC 8785 (JSON Canonicalization Scheme) strictly, with the additional restrictions below. As RFC 8785 requires, object property names are sorted by UTF-16 code units (not by UTF-8 bytes), numbers use the ECMAScript number-to-string form, and there is no whitespace. Strings are valid Unicode (no lone surrogates) and are not normalized.
- Two orderings exist and are never mixed: (a) property-name order inside canonical JSON is UTF-16 code unit order, as above; (b) every ordering that WEAVE itself defines uses UTF-8 byte order of the string: replica IDs in D4, the `(collection, recordId)` sort in the state hash, set-union elements (below), string `min` and `max`, and sorted op-ID lists. For example the property names U+E000 and U+10000 sort as U+10000 first in canonical JSON (UTF-16: D800 DC00 before E000), while as WEAVE-defined strings U+E000 sorts first (UTF-8: EE 80 80 before F0 90 80 80).
- Supported value types: `null`, booleans, strings, finite numbers, arrays and plain objects (objects with only string keys and supported values). Numbers must be finite and integers must be within the safe integer range. The value `-0` is written as `0` before encoding. Arrays keep their order.
- Unsupported values are rejected at write time (R8.2) and at receipt (R16.1) with a `UNSUPPORTED_VALUE` validation error: `undefined`, `NaN`, `Infinity`, `bigint`, symbols, functions, `Date`, `Map`, `Set`, typed arrays, class instances and cyclic structures. Applications convert these (for example dates to ISO strings, binary to base64) before writing. Depth and size limits are configurable and enforced.
- Set-union output: the value of a set-union field is an array with no duplicates, sorted by the UTF-8 bytes of each element's canonical encoding. Two elements are equal when their canonical encodings are equal.
- State hash: SHA-256 over the canonical encoding of an array of entries `[collection, recordId, deleted, fields]`, sorted by `(collection, recordId)` in UTF-8 byte order, where `fields` is the object of resolved field values (an empty object for deleted records). Op-set hash: SHA-256 over the canonical encoding of the sorted list of op hashes. Conflict-view hash: SHA-256 over the canonical encoding of the sorted list of conflict IDs of open conflicts with their resolved values.
- Hashing uses the platform crypto API (Node.js and browsers), adding no runtime dependency.

**D8: Conflict identity and conflict records.** A conflict record is derived data, never a source of truth.
- Field conflict: `conflictId = SHA-256(canonical([collection, recordId, "field", fieldName, sortedFrontierOpIds]))` where the frontier has two or more ops. Delete conflict: `conflictId = SHA-256(canonical([collection, recordId, "delete", sortedOpIds]))` where the op IDs are the delete op plus every `set` op concurrent with it, and there is at least one such `set` op. Op IDs are sorted by D4 order.
- **Current conflict view**: the set of conflicts computed from the current op set. A field conflict is *open* while the frontier of that field has two or more ops. It leaves the view as soon as the frontier shrinks to one op, which happens when an op that happens-after every frontier op is written (for example a user's explicit resolution). A delete conflict stays in the view for as long as its ops are retained.
- **Conflict history log**: the conflict records obtained by replaying the op set in D4 order and noting every frontier of two or more ops that appears. It is a function of the op set, so every replica with the same op set derives the same log. Each record has a status `open` (its frontier is the field's current frontier) or `superseded`.
- **Live notifications**: events sent to subscribers as ops arrive. Each carries the `conflictId`. Delivery is **at-most-once per conflict ID per replica**. It is not exactly-once. The order of steps is: (1) the ops commit durably (R1.3); (2) the conflict IDs that newly appear are written to the durable notified-conflict set; (3) the events are emitted. A crash between (2) and (3) loses that live notification and never repeats it. A crash between (1) and (2) is repaired at startup: the replica derives the conflict IDs of its committed ops from the conflict history log (so conflicts that were created and already superseded before their marker was written are included, not only the current view), and any ID not in the notified set goes through steps (2) and (3). A notification for an already superseded conflict carries status `superseded`. Retries, replays and rebuilds therefore never notify an ID twice. A missed notification is recovered by reading the current conflict view or the conflict history log, which hold the same conflicts. Notification timing and intermediate frontiers can differ between replicas because arrival order differs. For replicas that hold the same op set, the current conflict view and the conflict history log never differ.

## 2. Requirements

Each requirement has a user story and acceptance criteria. Format: "WHEN / THE SYSTEM SHALL". Tier tags show delivery priority.

### R1: Offline-first local persistence [MVP]

**User story:** As an app developer, I want all reads and writes to work against local storage with no network, so that my app never blocks on connectivity.

1. [MVP] WHEN a developer opens a WEAVE database THE SYSTEM SHALL provide create, read, update, delete and query operations that complete using only local storage.
2. [MVP] WHEN the process restarts THE SYSTEM SHALL restore all committed records, the op log, the pending buffer, the peer registry and the notified-conflict set from storage.
3. [MVP] WHEN a write is committed THE SYSTEM SHALL store the op, the updated sequence number and the derived state atomically, so either all exist or none do.
4. [MVP] WHEN the device has no connectivity THE SYSTEM SHALL accept writes and queue their ops for later sync without error.
5. [MVP] WHEN a developer queries a collection THE SYSTEM SHALL support filtering by field equality and ordering by a field, and SHALL exclude deleted records by default.

### R2: Record identity, causal metadata and operation ordering [MVP]

**User story:** As an app developer, I want every record and change to have a unique identity and a precise order, so that independent devices never collide and always agree on order.

1. [MVP] WHEN a record is created THE SYSTEM SHALL assign it an ID unique across replicas with no coordination.
2. [MVP] WHEN an op is created THE SYSTEM SHALL populate every field defined in D2, with `seq` contiguous per replica (D1).
3. [MVP] THE SYSTEM SHALL compute `lamport` and `context` only from the replica's **accepted** ops and its accepted version vector, excluding every op in the pending buffer until the gap is filled and the op is promoted into the accepted log, and SHALL NOT read the wall clock for any value used in ordering (A5).
4. [MVP] THE SYSTEM SHALL order ops by D4 on every replica, and a test SHALL show that a replica whose clock is set years ahead or behind produces the same order, state and hashes as the others.
5. [MVP] WHEN an application requests a record's history THE SYSTEM SHALL return all accepted ops of that record (including those of a deleted record and ops that lost a conflict) in D4 order through a collection-level call (`collection.history(recordId)`), each entry carrying the IDs of the other ops of that record that are concurrent with it (D3). Buffered, not yet accepted ops SHALL NOT appear, and equal op sets SHALL give equal histories.
6. [MVP] WHEN a remote op arrives with a `seq` gap THE SYSTEM SHALL hold it in the pending buffer, ask the sender for the missing range, and apply nothing from the gap onward until the gap is filled. WHEN the gap is filled THE SYSTEM SHALL accept the buffered ops that become contiguous, in sequence order, together with the op that filled it, in one atomic step, so that an op is never in both the accepted log and the buffer and is never lost; buffered ops are counted separately from accepted ops (R12.3), and a promoted op is not a duplicate.
7. [MVP] WHEN an op is received THE SYSTEM SHALL check that its ID does not already exist with different content, looking at both the accepted ops and the pending (buffered) ops. An op with the same ID and the same hash in either place is an idempotent duplicate. Within one incoming batch, THE SYSTEM SHALL first reject the batch if any ID appears with two different hashes, and then reduce identical copies of an ID to one representative, so that a previously unseen op delivered several times in one batch is accepted (or buffered) exactly once and is never lost. The same rule applies to a relay push. An op with the same ID and a different hash SHALL be rejected and reported as an integrity error (`INTEGRITY_CONFLICT`), and an existing pending entry SHALL never be overwritten with different content, including when several incoming batches are processed concurrently. WHEN this shows that two different ops claim one `(replicaId, seq)`, the status SHALL also report `REPLICA_ID_REUSE`, since A1 was violated (for example by copying a replica's storage to a second device).
8. [MVP] WHEN an op contains a value that D7 does not support THE SYSTEM SHALL reject it with `UNSUPPORTED_VALUE` and store nothing.

### R3: Change tracking, peer registry, tombstones and safe compaction [MVP core, ADV compaction]

**User story:** As an app developer, I want every change recorded immutably and old data removed only when it is provably safe.

1. [MVP] WHEN a record is created, updated or deleted THE SYSTEM SHALL append exactly one op for that change.
2. [MVP] THE SYSTEM SHALL NOT modify or delete an op after it is written, except through the compaction call in criteria 6 to 10. Schema upgrades (R8.3) leave stored ops unchanged.
3. [MVP] WHEN a developer subscribes to changes THE SYSTEM SHALL notify them of local writes and of changes applied by sync, labelled by source.
4. [MVP] THE SYSTEM SHALL keep a durable peer registry. A peer, including the relay, enters the registry the first time the replica exchanges ops with it, and stays until removed by an explicit `removePeer` call.
5. [MVP] THE SYSTEM SHALL record, for each registered peer, the highest version vector that the peer has acknowledged holding. A peer writes an acknowledgement only after it has durably stored the ops. Acknowledgements are monotone and safe to repeat.
6. [ADV] THE SYSTEM SHALL compute the stable horizon as the pointwise minimum of the acknowledged vectors of every member known to the relay, where a replica becomes a member only by registering with the relay before it receives any data. A replica may compact only ops covered by the horizon published by the relay. Without a relay, compaction is disabled unless the developer declares the replica set closed and lists every member.
7. [ADV] WHEN any member is offline, has never acknowledged, or has acknowledged an older vector THE SYSTEM SHALL treat the missing acknowledgements as zero for the horizon, so those ops are kept.
8. [ADV] WHEN compaction runs THE SYSTEM SHALL discard only ops that are covered by the horizon and superseded in every field they set (not in any open field frontier), and SHALL keep the current state, every tombstone, the version vector, and a `compactedThrough` vector.
9. [ADV] WHEN a peer asks for ops below `compactedThrough` THE SYSTEM SHALL answer with a typed `NEEDS_SNAPSHOT` error and never send partial history. The peer is then brought up to date by snapshot bootstrap (R4.8).
10. [ADV] WHEN a developer calls `removePeer` THE SYSTEM SHALL drop that member from horizon calculations, SHALL record its replica ID in a durable removed list that syncs through the relay, and SHALL refuse later ops from it. A removed device rejoins only with a fresh replica ID through snapshot bootstrap. A peer is never removed by elapsed time (A5, A6).
11. [MVP] THE SYSTEM SHALL keep every op and every tombstone indefinitely unless compaction is run.
12. [MVP] THE SYSTEM SHALL ship with compaction off by default.
13. [ADV] WHEN compaction is enabled THE SYSTEM SHALL keep a full tombstone until its delete op is covered by the horizon, and a compact tombstone (record ID plus delete op ID) afterwards. After the horizon covers a delete, every member has acknowledged it, so a member cannot write an op concurrent with it, and removed or new replicas are admitted only by snapshot, which already contains the tombstone. A compact tombstone is kept for as long as the replica exists.
14. [ADV] THE SYSTEM SHALL state in its documentation and in the compaction ADR that the compaction guarantee assumes registered members follow the acknowledgement protocol (R3.5): the relay can only record, not verify, what a member claims to hold. Compaction SHALL NOT be described as safe against a member that deliberately or through a bug over-claims (it is not Byzantine-safe), and it remains off by default (R3.12).

### R4: Synchronization between replicas [MVP, direct network and snapshot are ADV]

**User story:** As a user, I want my device to catch up with others when connectivity returns, so that everyone sees the same data.

1. [MVP] WHEN two parties sync (replica and relay, or replica and replica) THE SYSTEM SHALL exchange version vectors and transfer exactly the ops each side is missing and is allowed to receive under R4.10.
2. [MVP] THE SYSTEM SHALL report a sync as `complete` only after a final vector exchange (a verification step after the last transfer) shows that the endpoint's durable vector equals the replica's vector read immediately before the endpoint was asked and also equals the replica's vector read immediately after the reply (a stable double read), with no origin blocked or rejected. IF the vectors differ, because ops were written locally or arrived from a third party during the sync, THE SYSTEM SHALL repeat the synchronization, up to a configurable maximum number of rounds (default 5). IF the vectors still differ and nothing is blocked after the last round, the result SHALL be `partial` with code `NOT_SETTLED`, and every committed op is kept. WHEN a sync finishes with result `complete` (no op was withheld for schema reasons and no error occurred) THE SYSTEM SHALL leave both parties holding the same set of ops as of that verification point. WHEN any op was withheld under R4.10 THE SYSTEM SHALL report result `partial` with code `PEER_SCHEMA_OLDER` and the blocked origins, and SHALL NOT report `complete`. Both parties keep every op they accepted.
3. [MVP] THE SYSTEM SHALL support sync through the relay (R4a) and directly between two replicas in one process, using the same protocol.
4. [ADV] THE SYSTEM SHALL support direct peer-to-peer sync over a network transport using the same protocol.
5. [MVP] WHEN a sync is interrupted THE SYSTEM SHALL keep every op already applied, and the next sync SHALL resume from the remaining difference.
6. [MVP] WHEN a party has many pending ops THE SYSTEM SHALL send them in bounded batches in per-replica `seq` order.
7. [MVP] WHEN received data fails validation or integrity checks (structure, canonical form, value rules, hash, application schema, identity) THE SYSTEM SHALL reject the whole received batch, leave the op log, derived state, version vector and pending buffer unchanged, and report a typed error. The only partial outcomes are the schema prefix rule (R4.10) and the sequence-gap buffer (R2.6). To keep one faulty origin from blocking others, THE SYSTEM SHALL (a) send pushes as batches that each contain the ops of one origin, and (b) after a rejected pull batch, repeat the pull once per origin. Each attempted batch remains atomic. Origins whose batches are still rejected SHALL be listed in `rejectedOrigins` of the sync result (origin, error code, direction `pull` or `push`), and the result SHALL be `failed`. Origins that passed keep their applied ops.
8. [ADV] WHEN a replica is new, or was removed and rejoined, THE SYSTEM SHALL support bootstrapping from a snapshot (state, tombstones and version vector) and then continue with normal sync.
9. [MVP] THE SYSTEM SHALL NOT treat any transport or the relay as authoritative: the relay stores and forwards ops and runs no conflict logic (R4a).
10. [MVP] **Schema-aware delivery.** WHEN two parties meet during a sync THE SYSTEM SHALL exchange the highest schema version each supports per collection (a collection the receiver does not define counts as unsupported). For each originating replica, the sender SHALL deliver only the longest contiguous prefix (by `seq`) of that origin's ops whose collection and `schemaVersion` the receiver supports. At the first unsupported op from an origin the sender SHALL stop delivering that origin, and SHALL NOT skip the op to deliver later ops from the same origin, even when those later ops belong to a collection the receiver supports. The withheld ops stay stored at the sender or relay. Other origins are unaffected. The sync result is `partial` with code `PEER_SCHEMA_OLDER`, listing each blocked origin, the `seq` where it is blocked, and the schema version required. WHEN the older replica is upgraded THE SYSTEM SHALL resume normal sync from the blocked point with no special step. The receiver SHALL also enforce the rule: an op it cannot read is rejected with `SCHEMA_TOO_NEW`, it and every later op from that origin in the batch are not stored, and ops before it in the batch are kept.

### R4a: Relay server [MVP]

**User story:** As an operator, I want a small durable server that devices sync through, so that devices that are never online together still exchange changes.

1. [MVP] THE SYSTEM SHALL ship the relay as its own package (`relay`) with a runnable server entry point and one documented start command. It is not only an HTTP adapter: the HTTP transport adapter (R9.2) is the client of this server.
2. [MVP] THE SYSTEM SHALL store relay data through the same storage adapter interface (R9.1), with the file-based adapter as the default, so ops and registry survive restarts.
3. [MVP] WHEN a replica pushes a batch THE SYSTEM SHALL verify the structure and size limits of the full op, the D7 value rules, and each op's hash recomputed over the complete D2 payload (R16.1, R16.2; the relay does not apply application schemas), enforce contiguous `seq` per replica (D1), commit the accepted ops to durable storage in one atomic transaction, and only then acknowledge them. It SHALL NOT acknowledge any op that is not durable.
4. [MVP] WHEN a replica connects THE SYSTEM SHALL support the missing-operation exchange of R4.1: the replica sends its version vector, the relay answers with the ops the replica lacks (in bounded batches, per R4.6 and R4.10) and the replica sends the ops the relay lacks.
5. [MVP] THE SYSTEM SHALL track, per registered replica, the highest version vector that replica has acknowledged, update it only after the replica reports durable storage, and keep it durably (R3.5).
6. [MVP] THE SYSTEM SHALL forward ops unchanged. It SHALL NOT apply conflict resolution, run schema migrations, rewrite ops or change their order. The relay is semantically opaque: it SHALL NOT interpret application field values, and SHALL treat `fields` as data that is validated and hashed but never acted on. It SHALL read the complete immutable payload (D2) as far as needed to validate its structure and D7 value rules and to recompute and verify the D2 hash (R4a.3, R16.1, R16.2). It SHALL use the envelope (op ID, `collection`, `schemaVersion`, `context`, size, hash) for routing, sequence validation (D1) and schema-aware delivery (R4.10). It SHALL store each accepted op byte-for-byte unchanged and forward it unchanged. It stores every op it accepts whatever its schema version, withholds from each client only the ops that client cannot read (stopping each origin at its first unreadable op), and returns the blocked origins so the client reports a `partial` result.
7. [MVP] THE SYSTEM SHALL treat repeated pushes and pulls as safe: a re-pushed op that already exists is ignored and acknowledged again (R5.1).
8. [MVP] WHEN the relay is killed and restarted at any point THE SYSTEM SHALL recover all acknowledged ops and registry entries, lose nothing it has acknowledged, and accept clients' retries of anything unacknowledged.
9. [MVP] THE SYSTEM SHALL accept connections only with a bearer token configured through an environment variable when one is set, and SHALL never write the token to logs.
10. [MVP] THE SYSTEM SHALL be tested with the shipped HTTP transport against a real relay process, including a kill-and-restart test.

### R5: Idempotency and duplicate prevention [MVP]

**User story:** As an app developer, I want repeated or duplicated delivery to be harmless, so that retries are always safe.

1. [MVP] WHEN an op that already exists is received again THE SYSTEM SHALL ignore it and leave state unchanged.
2. [MVP] WHEN the same batch is applied any number of times THE SYSTEM SHALL produce the same state as applying it once.
3. [MVP] WHEN ops arrive in any order THE SYSTEM SHALL end with the same op set and the same state as when they arrive in causal order (D1, D5).
4. [MVP] **Mandatory `mutationId`.** THE SYSTEM SHALL require a caller-supplied `mutationId` (a string of 1 to 128 characters from `[A-Za-z0-9_.:-]`) on every `create`, `update` and `delete` call, in the type signature and at runtime; a call without a valid one SHALL fail with `VALIDATION_FAILED` and write nothing. The caller SHALL choose the ID once per user intent, persist it with that intent before the first attempt, and reuse the same ID on every retry. THE SYSTEM SHALL store the mapping from `mutationId` to the resulting op (with a hash of the call's payload) in the same atomic transaction as the op (R1.3). WHEN a call arrives with a `mutationId` that is already stored and the payload is identical, THE SYSTEM SHALL create no new op and SHALL return the original result (`recordId`, op ID) marked `replayed`. WHEN the `mutationId` is stored and the payload differs, THE SYSTEM SHALL fail with `MUTATION_ID_REUSED` and change nothing. This holds after a crash at any point, including a crash after commit and before the result reached the caller. Apps, the quick start and tests SHALL use and reuse stable IDs this way. To make IDs easy to create without hidden randomness, THE SYSTEM SHALL export `newMutationId(random)`, which takes an explicit injectable `Random` source and has no default, and `replica.newMutationId()`, which uses the `Random` that the replica was created with, so a replica built with a seeded source gives reproducible IDs.
5. [MVP] WHEN conflict notifications are replayed, retried, rebuilt or interrupted by a crash THE SYSTEM SHALL emit each conflict ID at most once per replica, using the mark-then-emit order in D8. THE SYSTEM SHALL NOT claim exactly-once delivery.

### R6: Conflict detection and resolution [MVP, with ADV extensions]

**User story:** As a user, I want concurrent edits handled predictably, so that no data silently disappears and all devices agree.

1. [MVP] THE SYSTEM SHALL define the resolved value of every field as a pure function of the complete field frontier (D5), and SHALL NOT use arrival order, local clock, current time, or the order of earlier resolutions.
2. [MVP] A current field conflict SHALL exist exactly when the current frontier of that field (D5) contains at least two ops. WHEN a later op happens-after every op in that frontier THE SYSTEM SHALL reduce the frontier to that one op and close the current conflict, even though the earlier ops were concurrent. The earlier conflict stays in the history log with status `superseded` (D8, R6.12). WHEN ops set different fields of one record THE SYSTEM SHALL merge them with no conflict.
3. [MVP] THE SYSTEM SHALL provide a default resolver, last-writer-wins, that picks the frontier op with the greatest `(lamport, replicaId, seq)` (D4), reading those values from each entry's metadata and not from its position in the input list.
4. [MVP] THE SYSTEM SHALL provide these built-in resolvers, each declared per field in the schema: `last-writer-wins`, `max` and `min` (numbers or strings, ordered numerically or by UTF-8 bytes), `set-union` (D7 output rules), and `max-rank`.
5. [MVP] The `max-rank` resolver SHALL be configured with an explicit rank map, an ordered list of distinct allowed values, for example `['open','in_review','closed']`. It SHALL return the frontier value with the highest rank. The schema SHALL reject a `max-rank` field whose type is not a string or number enumeration matching the rank map, and any write whose value is not in the rank map, with a validation error. Because the allowed values are distinct, two different values never have equal rank, so the result never depends on order.
6. [MVP] Every resolver SHALL be a pure function of the frontier entries (value, `lamport`, `replicaId`, `seq`, op ID) and SHALL return the same value for every ordering of the same entries. The engine passes the entries in D4 order for convenience, but resolvers SHALL NOT depend on that order. WHEN a late op joins an existing frontier THE SYSTEM SHALL recompute the field from the whole frontier, not from the previous result.
7. [MVP] WHEN a record has a `delete` op and a concurrent `set` op (neither happens-before the other) THE SYSTEM SHALL treat the record as deleted on every replica (D6, delete wins). The concurrent `set` ops stay in history and in a delete conflict record (D8), and are not applied to visible state.
8. [MVP] WHEN a local write happens-after a `delete` op that the replica holds THE SYSTEM SHALL reject it with a typed `RECORD_DELETED` error. IF such an op arrives from a faulty peer THE SYSTEM SHALL keep it in history and treat the record as deleted.
9. [ADV] THE SYSTEM SHALL support the `restore` op kind and the `update-wins` collection policy defined in D6.
10. [ADV] THE SYSTEM SHALL provide a counter resolver (sum of per-replica deltas) and SHALL allow custom resolvers. A custom resolver SHALL be pure, SHALL satisfy R6.6, and SHALL be checked by an exported `assertResolverDeterministic` helper before use in tests.
11. [MVP] THE SYSTEM SHALL expose the current conflict view, the conflict history log and live conflict notifications as defined in D8. Each conflict record holds its `conflictId`, kind, record, field, the sorted frontier op IDs with their values, the resolved value and its status (`open` or `superseded`). Because live notifications are at-most-once (D8), apps SHALL build their conflict UI from the current view and the history log, and use notifications only as hints.
12. [MVP] WHEN a conflict is resolved because a later op supersedes the whole frontier THE SYSTEM SHALL remove it from the current view and keep it in the history log with status `superseded`.
13. [MVP] WHEN a replica is rebuilt from its op log THE SYSTEM SHALL reproduce the same current conflict view and history log, and SHALL NOT create duplicate conflict records.

### R7: Deterministic reconciliation and convergence [MVP]

**User story:** As a user, I want every device to reach the same state, regardless of who synced with whom or in what order.

1. [MVP] WHEN two replicas hold the same op set THE SYSTEM SHALL compute byte-identical record state and the same state hash on both (D7).
2. [MVP] THE SYSTEM SHALL compute state as a function of the op set only (D5), and a test SHALL apply the same ops in many random orders and compare hashes.
3. [MVP] WHEN three or more replicas sync in any order and any topology under assumptions A1 to A7 THE SYSTEM SHALL converge to one state once all ops have propagated to replicas that support every schema version present in the op sets (A7).
4. [MVP] WHEN a replica is rebuilt from the op log THE SYSTEM SHALL reproduce the same state as the live replica.
5. [MVP] WHEN two replicas hold the same op set THE SYSTEM SHALL derive the same current conflict view, the same conflict history log and the same conflict-view hash (D8).
6. [MVP] WHEN replicas hold different op sets because schema support stopped delivery (R4.10) THE SYSTEM SHALL NOT claim they are converged. Their op-set hashes differ and the sync result is `partial`. They converge under R7.3 after the older replica upgrades and sync resumes.

### R8: Schema definition and evolution [MVP basics, ADV mixed-version holding]

**User story:** As an app developer, I want to change my data shape over time without breaking devices running older versions.

1. [MVP] WHEN a developer defines a collection THE SYSTEM SHALL accept a typed schema with field types, required fields and a resolver per field.
2. [MVP] WHEN a local write does not match the schema or contains an unsupported value (D7) THE SYSTEM SHALL reject it with a validation error before it is stored.
3. [MVP] WHEN the schema version increases THE SYSTEM SHALL run developer-supplied, versioned migrations, in order, as pure functions that turn the `fields` of an older-version op into the `fields` of the next version. Stored ops are never rewritten (R3.2): the engine applies the migration chain when it derives state (D5), so the state of an op is its migrated fields. The engine records the version reached.
4. [MVP] WHEN a migration throws or produces a value that fails the new schema THE SYSTEM SHALL roll back, leave the replica at the prior schema version, and report a typed `MIGRATION_FAILED` error.
5. [MVP] **Migration contract.** Every migration SHALL be a deterministic, total function of one op's content alone: its input is a deep-frozen copy of the op's `fields` plus its `collection`, `recordId` and source version, and its output is the `fields` of the next version. A migration SHALL NOT use wall clocks, randomness, global or external state, I/O, network, other records or other ops. The engine passes no handle that gives such access. Purity cannot be proved by testing, so the tests are only evidence: (a) repeatability (the same input gives equal canonical output across repeated calls and across fresh engine instances); (b) chain tests (v1 to v2 to v3 gives the expected result, and the result does not depend on whether intermediate versions were computed earlier); (c) cross-replica tests (two replicas produce equal state hashes from the same ops); (d) a mutation test (writing to the frozen input throws). The migration guide states the contract and the prohibited sources.
6. [MVP] THE SYSTEM SHALL support this exact MVP scenario: replicas that wrote ops under schema v1 are upgraded to the app version with schema v2, each replica derives v2 state from its v1 ops and any v1 ops it receives, new writes use v2, and upgraded replicas then sync with each other, with the same convergence guarantees as R7. In addition, WHEN a replica that supports only v1 syncs with a v2 replica THE SYSTEM SHALL apply the contiguous-prefix rule of R4.10: for each origin it receives the longest contiguous prefix of ops it can read and nothing after the first op it cannot read, including later ops that belong to collections it does support. The sync result is `partial` with code `PEER_SCHEMA_OLDER`, never `complete`. The v1 replica and the v2 replica are not claimed to be converged (A7, R7.6). After the v1 replica is upgraded, sync resumes and they converge. The global per-replica sequence (D1) is kept, with no per-collection sequence numbers.
7. [ADV] THE SYSTEM SHALL hold ops with a newer schema version than the replica supports, store them durably but exclude them from visible state, report that an app update is needed, and apply them after the update, whatever peer delivered them. When this is enabled the prefix rule of R4.10 is replaced by holding, and the replica keeps the contiguity of D1 because held ops are stored. Fully mixed-version operation, with old and new replicas both writing at the same time, is out of the MVP.
8. [MVP] WHEN a replica is opened with code whose schema version for a collection is lower than the version recorded in its storage THE SYSTEM SHALL refuse to open with `SCHEMA_DOWNGRADE` and change nothing.

### R9: Pluggable storage and transport adapters [MVP]

**User story:** As an app developer, I want to choose where data lives and how devices talk, without changing app code.

1. [MVP] THE SYSTEM SHALL define a storage adapter interface with atomic multi-key transactions, and ship an in-memory adapter (tests), an IndexedDB adapter (browser) and a file-based adapter (Node.js, also used by the relay).
2. [MVP] THE SYSTEM SHALL define a transport adapter interface and ship an in-process adapter (tests) and an HTTP adapter that is the client of the relay server (R4a).
3. [MVP] WHEN a custom adapter is supplied THE SYSTEM SHALL verify it by running a published adapter conformance test suite, and every shipped adapter SHALL pass it.
4. [MVP] WHEN the core engine is built THE SYSTEM SHALL contain no import of a specific storage or network library.
5. [ADV] THE SYSTEM SHALL ship a WebSocket transport adapter.
6. [MVP] THE SYSTEM SHALL require every shipped durable storage adapter to commit a transaction atomically and durably, and to fail closed on damage. The file-based adapter SHALL: (a) protect each journal record with a checksum over the whole record, and give each record header its own independent checksum so that a damaged length field is detected as corruption and is never mistaken for an incomplete append; (b) truncate automatically only an incomplete final append whose header verifies and declares more bytes than remain, and treat every other defect as corruption that fails with `STORAGE_CORRUPT` and leaves every data file byte-for-byte unchanged: a trailing fragment shorter than a header (whose length cannot be verified), a damaged header or length field (upward or downward), a bad payload checksum, a damaged final record, and damage anywhere earlier in the log; only a trailing fragment shorter than a header, or a complete final record with a verified header and a bad payload checksum, may be removed, and only when the operator explicitly requests it with the offset reported in the error; (c) never replay a journal over a snapshot of a different generation; (d) refuse to open a data directory held by a live process (`STORAGE_LOCKED`), taking over a lock only when its holder is provably dead on the same host, boot and PID namespace, and only under a recovery guard that serializes competing recoveries and revalidates the observed lock identity before replacing it (while holding the recovery guard, the recoverer SHALL proceed with replacement only if the current `LOCK` nonce equals the nonce recorded in its original observation and in the guard's `observedLockNonce`; if they differ, it SHALL remove only its own guard and restart the open procedure, and it SHALL NOT replace a changed lock using the previous observation) (and refusing with `STORAGE_LOCKED` whenever reliable identity for any of the three cannot be established, never falling back to hostname and boot ID alone), and offering no option, flag or API that overrides a lock (manual recovery is an offline, documented, destructive procedure outside the adapter); (e) fail closed with `STORAGE_LOCK_LOST` when it detects it no longer owns the lock; (f) ship a documented manual offline recovery procedure that covers every lock artifact it can leave behind (`LOCK`, the recovery guard `LOCK.recovery` and `LOCK.new-*`) or that an earlier version left behind (`LOCK.stale-*`, from WEAVE 0.1.0): stop all processes, confirm no holder or recovery process runs, back up the whole directory, inspect the artifacts, keep the existing recovery guard (or create a maintenance guard by exclusive creation if none exists) for the whole cleanup, re-read `LOCK` under the guard, remove abandoned `LOCK.new-*` and `LOCK.stale-*` files and `LOCK` (never the data files) while the guard remains, remove the guard last, then reopen and validate the journal before normal use.

### R10: Error handling, retries and recovery [MVP, peer ban is ADV]

**User story:** As an app developer, I want failures to be understandable and recoverable.

1. [MVP] THE SYSTEM SHALL expose typed errors with these stable codes: `VALIDATION_FAILED`, `UNSUPPORTED_VALUE`, `INTEGRITY_CONFLICT`, `REPLICA_ID_REUSE`, `MUTATION_ID_REUSED`, `RECORD_DELETED`, `MIGRATION_FAILED`, `SCHEMA_TOO_NEW`, `SCHEMA_DOWNGRADE`, `NOT_SUPPORTED`, `NEEDS_SNAPSHOT` (reserved for [ADV]), `RESOLVER_ERROR`, `TRANSPORT_ERROR`, and the storage codes `STORAGE_ERROR`, `STORAGE_CONFLICT` (a concurrent writer changed the data a transaction read), `STORAGE_CORRUPT` (damaged data detected), `STORAGE_LOCKED` (the data directory is in use, or its lock cannot be safely acquired or taken over right now) and `STORAGE_LOCK_LOST` (this process no longer owns the lock). THE SYSTEM SHALL report `PEER_SCHEMA_OLDER` and `NOT_SETTLED` as codes of a `partial` sync result (R4.10, R4.2). They are statuses, not failures.
2. [MVP] WHEN a transport call fails with a transient error THE SYSTEM SHALL retry with exponential backoff and jitter, within configurable limits. Backoff timing uses a monotonic timer and affects no stored data. The jitter SHALL be derived from the injectable random source (a value in the interval [0, 1) computed deterministically from its bytes), never from `Math.random`, so tests with a seeded source reproduce exact delays.
3. [MVP] WHEN retry limits are reached THE SYSTEM SHALL stop, keep all queued ops, report the failure, and allow a manual or later automatic retry.
4. [MVP] WHEN the process is killed during a write or sync THE SYSTEM SHALL start again with no corrupted state and no lost committed ops.
5. [ADV] WHEN a peer repeatedly sends invalid data THE SYSTEM SHALL stop accepting from that peer for a configurable period.

### R11: Developer-friendly public API [MVP]

**User story:** As a developer new to WEAVE, I want a small, typed API, so that I can add sync in minutes.

1. [MVP] THE SYSTEM SHALL export a public API in TypeScript with strict types, and record types SHALL be inferred from schemas.
2. [MVP] WHEN a developer follows the quick start THE SYSTEM SHALL let them create a database, define a collection, write a record (with a stable `mutationId`, R5.4) and sync two replicas in under 30 lines of code.
3. [MVP] THE SYSTEM SHALL generate API documentation for every exported symbol.
4. [MVP] THE SYSTEM SHALL keep internal modules unexported, and list public API changes in a changelog.
5. [MVP] THE SYSTEM SHALL have no more runtime dependencies than needed, and justify each one in the design document or an ADR.

### R12: Logging, diagnostics and observability [MVP]

**User story:** As a developer or tester, I want to see what sync is doing.

1. [MVP] THE SYSTEM SHALL emit structured events for sync start, batch sent, batch received, ops applied, ops ignored as duplicates, ops buffered for gaps, conflicts (carrying the `conflictId`), retries and errors.
2. [MVP] WHEN a developer supplies a logger THE SYSTEM SHALL send events to it, and WHEN none is supplied THE SYSTEM SHALL log nothing.
3. [MVP] WHEN a developer asks for sync status THE SYSTEM SHALL report, per peer, the count of accepted ops the peer has not acknowledged (`pendingOps`), separately the count of buffered ops that are waiting for a sequence gap and are not accepted (`pendingBuffer`), the acknowledged vector per registered peer, last successful sync per peer (informational wall time, set only when a sync ends `complete`; a `partial` or `failed` sync never overwrites it), the last sync result per peer (`complete`; `partial` with its single reason code, which is `PEER_SCHEMA_OLDER` together with the blocked origins and the schema version each needs, or `NOT_SETTLED` together with the last endpoint and local vectors and no blocked origins; or `failed` with its error code and any rejected origins). The result type SHALL make the reason code mandatory for every `partial` result, so that a partial result without a reason cannot be built and current state (idle, syncing, failed).
4. [MVP] THE SYSTEM SHALL provide calls that return the state hash, the op-set hash and the conflict-view hash (D7), so two replicas can be compared.

### R13: GHOSTLINE application (community coordination) [MVP]

**User story:** As a community member, I want to post and read announcements and requests with no signal, and see everyone's posts when I reconnect.

GHOSTLINE's workflow is **publish and claim**: mostly additive posts from many authors, a draft-to-published lifecycle for announcements, and requests that people volunteer for. The app stays small: an announcements list, a requests list with a claim button, and a notices panel. It has no other features.

1. [MVP] WHEN offline THE SYSTEM SHALL let a user create announcement drafts, publish them, create requests (for example "need a ride"), tag them, and mark requests fulfilled.
2. [MVP] WHEN two devices both claim the same request independently THE SYSTEM SHALL show one claimant, chosen by the `claimedBy` field's `last-writer-wins` resolver, and SHALL show the other user a "someone else was chosen" notice read from the conflict view or history log (D8), so the notice appears even if a live notification was missed.
3. [MVP] WHEN two devices tag the same request THE SYSTEM SHALL keep all tags (set-union on `tags`).
4. [MVP] WHEN an announcement is deleted on one device and edited on another THE SYSTEM SHALL show it deleted on both and SHALL show the editor a notice that their edit was not applied (R6.7), derived from the delete conflict record.
5. [MVP] THE SYSTEM SHALL store GHOSTLINE data only through WEAVE's public API and sync only through the relay, with no separate sync code in the app.
6. [MVP] THE SYSTEM SHALL run with one documented command (which starts the relay and the app) and include a scripted demo with at least three devices.
7. [ADV] THE SYSTEM SHALL include a "me too" counter on requests using the counter resolver.

### R14: FIELDNOTE application (field operations) [MVP]

**User story:** As a field worker, I want to create and edit inspection records offline, so that several workers can work on one dataset.

FIELDNOTE's workflow is **structured record review**: a few long-lived inspection records edited by several assigned workers, with a status lifecycle, numeric readings and a schema that changes between app versions. The app stays small: an inspections list, an inspection detail view with observations, and a conflict history view. It has no other features.

1. [MVP] WHEN offline THE SYSTEM SHALL let a worker create inspection records (site, assigned workers, status), add observations (severity, notes, reading) as separate records linked to an inspection, and edit them.
2. [MVP] WHEN two workers edit different fields of an inspection THE SYSTEM SHALL merge both edits with no conflict.
3. [MVP] WHEN two workers set the inspection status concurrently THE SYSTEM SHALL pick the more advanced status using the `max-rank` resolver with the rank map `['open','in_review','closed']` (R6.5), and SHALL show the conflict history view built from the conflict history log (D8).
4. [MVP] WHEN two workers record different severity values for the same observation THE SYSTEM SHALL keep the higher severity (`max` resolver, severity values 1 to 5), and SHALL show both values in the conflict history.
5. [MVP] WHEN the inspection schema changes from version 1 to version 2 (a `location` string split into `site` and `zone`) THE SYSTEM SHALL demonstrate the R8.6 scenario: replicas that hold v1 inspections are upgraded to v2, derive the same v2 state from the v1 ops, and then synchronize through the relay and converge, with a test comparing state hashes. A second step SHALL show a v1-only replica receiving only the contiguous readable prefix of each origin, the sync reporting `partial` with `PEER_SCHEMA_OLDER`, and the replicas converging after that replica is upgraded. Fully mixed-version writing is not demonstrated.
6. [MVP] THE SYSTEM SHALL use a data model, resolvers and workflow clearly different from GHOSTLINE, and SHALL use no sync code outside WEAVE.
7. [MVP] THE SYSTEM SHALL run with one documented command (which starts the relay and the app) and include a scripted demo with at least three workers, one of whom stays offline for a long time and then syncs.

### R14a: Shared-engine and difference guarantees for both apps [MVP]

1. [MVP] THE SYSTEM SHALL have both apps depend only on WEAVE's public package entry points, and a CI check SHALL fail if either app imports a WEAVE internal module or contains its own sync, versioning, conflict-resolution or canonical-encoding code.
2. [MVP] THE SYSTEM SHALL run both apps' demos against the same unmodified core and relay package builds. Both apps SHALL create one stable `mutationId` per user action, persist it with the pending action before the first attempt, and reuse it on any retry (R5.4).
3. [MVP] THE SYSTEM SHALL document the following differences in the README, and each row SHALL be shown by a runnable demo step:

| Aspect | GHOSTLINE | FIELDNOTE |
|---|---|---|
| Shape of data | Many small independent posts | Few linked records (inspection plus observations) |
| Main workflow | Draft, publish, claim, fulfil | Create, assign, observe, review, close |
| Typical conflict | Two claims on one request | Two status or severity values on one field |
| Resolvers used | last-writer-wins, set-union, delete-wins notice | max-rank, max, set-union, last-writer-wins |
| Schema evolution | Not demonstrated | v1 to v2 upgrade, then sync |
| Demo shape | Devices join and leave a relay | Three workers, one offline for a long time |

### R15: Testing and quality gates [MVP]

**User story:** As a maintainer, I want proof that the core guarantees hold.

1. [MVP] THE SYSTEM SHALL include unit tests for each core module and integration tests for sync across at least three replicas and a real relay process.
2. [MVP] THE SYSTEM SHALL include property-based tests for: idempotency (apply twice equals apply once), order independence (any order gives the same state and hash), convergence (random sync schedules over random topologies end with equal state hashes), clock independence (changing wall clocks changes no state), canonical encoding (equal values give equal bytes in any key order, unsupported values are rejected) and conflict-view equality (same op set gives the same view and history log regardless of arrival order, retries and rebuilds).
3. [MVP] Resolver property tests SHALL call each resolver function directly, bypassing the engine's sorting, with randomly generated frontiers and every permutation of the same entries (random shuffles when there are more than six entries), including adversarial orderings (reverse D4 order, interleaved replicas), and SHALL assert equal output. They SHALL cover every built-in resolver, including `max-rank` with its rank map and `set-union` output order. A separate engine-level test checks that the same op set yields the same state when ops are delivered in different orders.
4. [MVP] THE SYSTEM SHALL include tests for offline operation, concurrent writes, delete versus update, duplicate delivery, dropped and reordered messages, sequence gaps, interrupted sync, crash recovery (storage killed mid-write), relay kill-and-restart, and the R8.6 migration scenario.
5. [MVP] THE SYSTEM SHALL run the adapter conformance suite against every shipped adapter.
6. [MVP] WHEN code is merged THE SYSTEM SHALL pass type checking, linting, formatting checks, all tests and a reproducible build in CI.
7. [MVP] WHEN a workstream finishes THE SYSTEM SHALL require an independent reviewer check of the actual code against these requirements before merge.
8. [MVP] THE SYSTEM SHALL state its test coverage and SHALL NOT mark any feature complete that is not implemented and tested.
9. [ADV] THE SYSTEM SHALL include compaction tests: an offline member, a never-acknowledging member and a removed member each behave as defined in R3.6 to R3.10 and R3.13, and a rejoining peer never resurrects a deleted record. It SHALL also include tests for `restore`, `update-wins`, the counter resolver and custom resolvers via `assertResolverDeterministic`.
10. [MVP] THE SYSTEM SHALL include fixed canonical-encoding test vectors, checked into the repository with their expected bytes and SHA-256 hashes. They SHALL include objects with non-ASCII property names that distinguish UTF-16 code unit order from UTF-8 byte order (for example U+E000 and U+10000), `-0`, nested objects and set-union output. CI SHALL run the vectors in Node.js and in a real browser engine and require identical bytes and hashes in both. A test SHALL also confirm that an op hash covers exactly the D2 payload: changing any payload field changes the hash, and changing `wallTime` does not.
11. [MVP] THE SYSTEM SHALL include a schema-aware delivery test with ops from several collections. Replica X writes op 1 in collection A (readable), op 2 in collection B at a schema version the receiver does not support, and op 3 in collection A (readable). The receiver, through both direct sync and the real relay, SHALL receive op 1 only. Op 3 SHALL be withheld, not skipped. The sync result SHALL be `partial` with `PEER_SCHEMA_OLDER`, blocked at `seq` 2. Ops from other origins SHALL still be delivered. After the receiver is upgraded, ops 2 and 3 SHALL arrive and both replicas SHALL have equal op-set and state hashes. The same test SHALL also cover three non-compliant direct pushes to a receiver that does not support op 2's schema version (R4.10 receiver rule, D1, R2.6): (a) a push of op 2 alone SHALL be rejected with `SCHEMA_TOO_NEW` and op 2 SHALL NOT be stored; (b) a push of ops 2 and 3 together SHALL reject op 2 with `SCHEMA_TOO_NEW` and SHALL NOT store op 3 from that origin in that batch, with op 1 (if in the batch) kept; (c) a push of op 3 alone, without op 2, SHALL follow the sequence-gap rule: op 3 is held in the pending buffer, the missing range (seq 2) is requested, op 3 is not applied to state and is not part of the op-set hash, and the error `SCHEMA_TOO_NEW` SHALL NOT be reported for op 3. WHEN the requested op 2 is then received it is rejected as in (a) and op 3 stays unapplied. In all three cases a rejected op 2 and a blocked op 3 SHALL NOT change the derived application state or the op-set hash. In case (b) a valid preceding op 1 in the batch MAY be stored and applied, and that is the only permitted change to the op log and state. In case (c) the persisted pending buffer MAY change and a missing-range request MAY be sent, but op 3 SHALL NOT enter the op log or affect the derived application state or the op-set hash.
12. [MVP] THE SYSTEM SHALL include migration tests for the contract in R8.5: repeatability, chain, cross-replica and frozen-input mutation tests.
13. [MVP] THE SYSTEM SHALL include a crash test for live conflict notifications: a crash after the ops commit and before the notified set is written, and a crash after the notified set is written and before the event is emitted. After restart each conflict ID is emitted at most once, no ID is emitted twice, and every conflict is present in the current view and the history log. The test SHALL include a case where a conflict is created and superseded (A and B concurrent, then C's op follows both) within one committed batch, with a crash before the notified set is written: after restart the superseded conflict SHALL be recovered from the history log, marked, and emitted exactly once with status `superseded`, and a second restart SHALL emit nothing.
14. [MVP] THE SYSTEM SHALL include a conflict-supersession test. Replicas A and B concurrently set the same field (frontier of two ops, one open conflict). Replica C, having received both, then writes the same field, so its op happens-after both. After sync, on every replica the current conflict view SHALL no longer contain that conflict, the history log SHALL contain it with status `superseded`, the field SHALL have the single frontier op and the resolved value of C's write, and the state hash, op-set hash, conflict-view hash and history log SHALL be identical on all replicas, regardless of delivery order. A variant SHALL deliver C's op to a replica before one of the concurrent ops arrives, and SHALL give the same results once all three ops are present.
15. [MVP] THE SYSTEM SHALL include write-idempotency tests (R5.4): a crash after commit and before the result is returned, followed by a retry with the same `mutationId` (same result, `replayed`, no new op, equal hashes); a retry with the same `mutationId` and a different payload (`MUTATION_ID_REUSED`, no change); a call without `mutationId` (`VALIDATION_FAILED`, no change); and a compile-time test that omitting `mutationId` is a type error.
16. [MVP] THE SYSTEM SHALL include a direct-replica integration test for push-side isolation (R4.7): a replica holds valid ops from origin X and an application-schema-invalid op from origin Y; syncing it to a peer applies the X ops, rejects the Y push atomically, reports `rejectedOrigins` with direction `push` and result `failed`, and a later sync still delivers new X ops while Y stays rejected.
17. [MVP] THE SYSTEM SHALL include file-adapter failure tests (R9.6): a final append cut at every byte offset (cut inside the header fails with `STORAGE_CORRUPT` and truncates nothing; cut after a verified header is truncated and recovered), a complete final record with a corrupted length field (upward and downward), payload, checksum, header or magic (each fails with `STORAGE_CORRUPT`, nothing truncated, every data file byte-for-byte unchanged), a flipped byte mid-log, forced process termination followed by restart on the same directory, interrupted snapshot rotation at every step, an old journal beside a newer snapshot (ignored), a lock held by a live process (refused whatever its age), a lock left by a dead process (taken over automatically **only on platforms with reliable host, boot and PID-namespace identity, which in the MVP means Linux with a readable `/proc`; on Windows and macOS the leftover lock of a killed holder SHALL be refused with `STORAGE_LOCKED` until the documented manual offline recovery is performed**; where takeover runs, at most one of several racing openers SHALL own the directory at any time; an individual takeover attempt whose guarded replacement of `LOCK` succeeds makes that opener the only owner, and every other opener of that race fails with `STORAGE_LOCKED`; an individual attempt whose replacement fails SHALL NOT take ownership, SHALL leave the observed `LOCK` and every data file unchanged, and SHALL fail with a typed error carrying the underlying system error code; if it cannot prove that the state before the attempt was restored it SHALL keep the recovery guard, so that every later open fails with `STORAGE_LOCKED` until the documented manual offline recovery; after a clean back-out, another racing or later opener MAY take the lock over, so a race ends with exactly one owner when some attempt succeeds and with no owner when every attempt fails), plus a takeover race test (several competing openers and a pause between observing and replacing the lock: at most one writer at any time, the later opener fails with `STORAGE_LOCKED`), a test in which one attempt fails, backs out and a second opener then takes over (exactly one final owner), and a test in which every attempt fails (no owner, data unchanged) and a check that no public option or CLI flag overrides a lock.
18. [MVP] THE SYSTEM SHALL include pending-identity tests (R2.7): while an op is pending, the same op delivered again (duplicate, buffer unchanged), the same ID with a different hash (`INTEGRITY_CONFLICT`, buffer unchanged), the same ID against an accepted op, both versions in one batch, and concurrent delivery of identical and of conflicting versions through different paths (one buffer entry survives, the conflicting one is rejected, under permuted interleavings). It SHALL also test several identical copies of a previously unseen op in one batch, with and without a sequence gap (exactly one op accepted or buffered), conflicting copies in one batch, and, against a real relay process, two concurrent pushes of the same `(replicaId, seq)` with identical hashes (stored and acknowledged once) and with different hashes (the first committed version stays unchanged and the other request fails with `INTEGRITY_CONFLICT`).
19. [MVP] THE SYSTEM SHALL include pending-promotion tests (R2.6): an op arriving before its predecessor and then the predecessor (both accepted, buffer empty, vector advanced); several buffered ops promoted in order by one gap-filling op; repeated delivery of the buffered ops before and after promotion; conflicting identity or content during promotion; and a crash and restart around the gap-filling transaction proving that promotion is atomic. After each scenario the tests SHALL assert the accepted log, the buffer, the record index, derived state, version vector, hashes and `pendingBuffer`.
20. [MVP] THE SYSTEM SHALL include tests that a directory left with a recovery guard (and any combination of `LOCK`, `LOCK.new-*` and `LOCK.stale-*`) is refused with `STORAGE_LOCKED`, can be recovered by following the documented manual procedure literally (journal validated, state equal to the state before the interruption, new writes accepted), and is still refused when only `LOCK` is removed (R9.6). A concurrency test SHALL show that ordinary openers receive `STORAGE_LOCKED` throughout the manual cleanup and cannot acquire a lock before the guard is removed, and that exactly one of them wins afterwards.
21. [MVP] THE SYSTEM SHALL include tests of the deterministic randomness contract: the `[0, 1)` derivation from fixed bytes, a seeded source reproducing exact retry delays, and a static check that no `Math.random` is used in engine, sync or adapter code (R10.2).

### R16: Security and data integrity [MVP basics, ADV authorization]

**User story:** As a maintainer, I want WEAVE to treat incoming data as untrusted.

1. [MVP] WHEN ops arrive from a peer or the relay THE SYSTEM SHALL validate structure, size limits and D7 value rules before storing them, and replicas SHALL additionally validate them against the application schema before applying them. The relay does not hold application schemas, so it performs only the structural, size, D7 and hash checks.
2. [MVP] WHEN an op arrives THE SYSTEM SHALL recompute its hash over the exact payload defined in D2 (every payload field, excluding `hash` and `wallTime`) and SHALL reject any op that does not match.
3. [ADV] THE SYSTEM SHALL reject ops that claim a replica ID the sender is not allowed to write as, when the transport provides an authenticated identity.
4. [ADV] THE SYSTEM SHALL provide an optional authorization hook, called before applying or sending ops.
5. [MVP] THE SYSTEM SHALL keep secrets out of source and logs, and SHALL document its threat model and known limits (no encryption by default, a shared relay token only).
6. [MVP] WHEN dependencies are added THE SYSTEM SHALL scan them for known vulnerabilities in CI.

### R17: Architecture records and decisions [MVP]

**User story:** As a reviewer, I want to see why the design was chosen.

1. [MVP] THE SYSTEM SHALL include a written comparison of at least these approaches: state-based CRDTs, operation-based CRDTs, event sourcing with an op log, last-writer-wins by timestamp, central-server-authoritative sync, and peer-to-peer versus relay topologies.
2. [MVP] THE SYSTEM SHALL record each important decision as an ADR (context, options, decision, consequences) in `docs/adr/`. ADRs SHALL cover at least: operation ordering and causal metadata (D1 to D4), canonical encoding (D7), conflict resolution as a function of the frontier, conflict identity (D8), delete semantics and tombstone retention, compaction safety, the relay design, schema upgrade on read, storage and transport choices, and runtime dependencies.
3. [MVP] THE SYSTEM SHALL include architecture diagrams for components, data flow and the sync protocol.
4. [MVP] THE SYSTEM SHALL evaluate and compare CRDTs, event sourcing, peer-to-peer replication and central-server architectures against the requirements, and SHALL document and justify the selected architecture in an architecture-selection ADR. That ADR SHALL state which concepts WEAVE adopts and which it does not, and why. At minimum it SHALL cover: the immutable operation log with state derived from it (adopted, as the basis of D1 to D5); version vectors and causal contexts (adopted); CRDT-style deterministic merge by resolver over the field frontier (adopted in form, without a general-purpose CRDT library or per-type CRDT data structures); a durable relay that stores and forwards ops (adopted, R4a); direct peer-to-peer sync (in-process in the MVP, over a network [ADV]); central-server authority over conflict outcomes (not adopted, R4.9); and timestamp-based last-writer-wins (not adopted, A5).

### R18: Documentation and developer experience [MVP]

1. [MVP] THE SYSTEM SHALL include a root README with the purpose, install steps, quick start, architecture summary and links to the demos.
2. [MVP] THE SYSTEM SHALL include a README in each package (including the relay) and each application directory.
3. [MVP] THE SYSTEM SHALL include a guide for writing a custom storage adapter, transport adapter and resolver.
4. [MVP] WHEN a new developer runs the documented setup commands on a clean machine with the stated Node.js version THE SYSTEM SHALL install, build, test and start the relay and both apps.

### R19: Hackathon packaging [MVP]

1. [MVP] THE SYSTEM SHALL have its own Git repository at the WEAVE root, with public-ready source and an MIT `LICENSE` file at the root (decision recorded by the user).
2. [MVP] THE SYSTEM SHALL include the `.kiro` directory at the repository root, containing specs, steering documents and hooks, and SHALL NOT list `.kiro` in `.gitignore`.
3. [MVP] THE SYSTEM SHALL keep GHOSTLINE and FIELDNOTE in two separate application directories.
4. [MVP] THE SYSTEM SHALL include a document explaining how Kiro Crew and its agents were used, with the workstream list, ownership, dependency graph and review gates.
5. [MVP] THE SYSTEM SHALL include a demonstration plan with steps, expected results and a recorded-demo script.
6. [MVP] THE SYSTEM SHALL include a disclosure section stating that no code existed before this project started (or listing what did).

### R20: Build and project engineering [MVP]

1. [MVP] THE SYSTEM SHALL be a TypeScript monorepo with strict compiler settings, with packages for core, storage adapters, transport adapters, the relay, and one for each application.
2. [MVP] THE SYSTEM SHALL build reproducibly from a lockfile, with a pinned Node.js version.
3. [MVP] THE SYSTEM SHALL support Windows, macOS and Linux for development.
4. [MVP] THE SYSTEM SHALL keep file and module ownership explicit per workstream (an `OWNERS` file), so parallel agents never edit the same files.
5. [MVP] THE SYSTEM SHALL meet these targets on a typical laptop: apply 10,000 ops in under 5 seconds, and sync a 1,000-op difference between two replicas in under 2 seconds on the in-process transport.

## 3. Delivery order (so MVP fits the hackathon)

1. MVP core: R1, R2 (with D1 to D8), R3 (criteria 1 to 5, 11, 12), R5, R6 (MVP items), R7, R9 (MVP), R10 (MVP), R11, R12, R16 (MVP).
2. MVP relay and sync: R4 (MVP), R4a.
3. MVP schema evolution and applications: R8 (criteria 1 to 6 and 8), R13, R14, R14a.
4. MVP proof and packaging: R15 (MVP), R17 to R20.
5. ADV, in this order, only after every MVP gate passes: compaction and `removePeer` (R3.6 to R3.10, R3.13), snapshot bootstrap (R4.8), `restore` and `update-wins` (R6.9), counter and custom resolvers (R6.10), mixed-version holding (R8.7), authorization (R16.3, R16.4), peer ban (R10.5), WebSocket and direct network sync (R4.4, R9.5), and the GHOSTLINE counter (R13.7).

## 4. Definition of done for the whole mission

- Every [MVP] criterion has a passing automated check. Every [ADV] criterion is either passing or listed as "not implemented" in the README.
- Both applications run from a clean checkout and show real sync across at least three devices through the real relay, using the same core and relay builds.
- Convergence, idempotency, order-independence, determinism, canonical-encoding, conflict-view and clock-independence property tests pass in CI.
- ADRs, diagrams, README files, the Kiro Crew explanation and the demo plan are in the repository.
- An independent reviewer has signed off each workstream against these requirements.
