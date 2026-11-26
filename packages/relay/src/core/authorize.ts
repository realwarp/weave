/**
 * [ADV] Relay side of the authorization hook and authenticated identity (R16.3, R16.4, task
 * T5.6). The relay stays semantically opaque: decisions see op envelopes only, through the shared
 * helpers of `@weave/core/protocol`, so the relay and every replica apply the same rules.
 *
 * Every check here runs BEFORE the relay writes anything (membership, ops, acknowledgements), so a
 * denied request leaves durable relay state unchanged.
 */
import {
  assertIdentity,
  runAuthorize,
  summarize,
  type AuthContext,
  type AuthorizeHook,
  type OpSummary,
  type ReplicaId,
} from '@weave/core/protocol';

/**
 * Before a push is stored: the claimed `replicaId` and the origin of every op must be ones the
 * authenticated caller may act as, and the hook must allow the batch (`direction: 'apply'`).
 * Lines that do not parse are left to the normal validation, which rejects the push anyway.
 */
export async function authorizePush(
  hook: AuthorizeHook | undefined,
  claimed: ReplicaId,
  lines: readonly string[],
  auth: AuthContext | undefined,
): Promise<void> {
  assertIdentity(auth, claimed);
  if (lines.length === 0 || (auth === undefined && hook === undefined)) return;
  let ops: OpSummary[];
  try {
    ops = summarize(lines);
  } catch {
    return;
  }
  assertIdentity(
    auth,
    claimed,
    ops.map((o) => o.replicaId),
  );
  await runAuthorize(hook, {
    direction: 'apply',
    peer: claimed,
    ...(auth === undefined ? {} : { auth }),
    ops,
  });
}

/**
 * Before a pull is answered: the hook must allow the selected ops (`direction: 'send'`). It is
 * not called when no op would be sent (a vector-only pull).
 */
export async function authorizePullSend(
  hook: AuthorizeHook | undefined,
  claimed: ReplicaId,
  lines: readonly string[],
  auth: AuthContext | undefined,
): Promise<void> {
  await runAuthorize(hook, {
    direction: 'send',
    peer: claimed,
    ...(auth === undefined ? {} : { auth }),
    ops: summarize(lines),
  });
}

export { assertIdentity };
