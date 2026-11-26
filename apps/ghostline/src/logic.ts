/**
 * GHOSTLINE user actions and views (R13.1 to R13.5). Every action is one intent with one stable
 * `mutationId` (see `pending.ts`). Views read only public replica APIs.
 */
import type { RecordView, Replica, WriteResult } from '@weave/core';
import { announcements, requests, type Announcement, type HelpRequest } from './model.js';
import { runAction, type PendingStore } from './pending.js';

export interface Session {
  readonly replica: Replica;
  readonly pending: PendingStore;
  /** Display name of the person using this device. */
  readonly user: string;
}

const ann = (s: Session) => s.replica.collection(announcements);
const req = (s: Session) => s.replica.collection(requests);

// ---------------------------------------------------------------- announcements

/** `intent` names this draft so a retry after a crash reuses the same mutationId. */
export function draftAnnouncement(
  s: Session,
  intent: string,
  title: string,
  body: string,
): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `draft:${intent}`, (mutationId) =>
    ann(s).create({ title, body, status: 'draft', author: s.user }, { mutationId }),
  );
}

export function editAnnouncement(
  s: Session,
  id: string,
  patch: Partial<Pick<Announcement, 'title' | 'body'>>,
): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `edit:${id}:${JSON.stringify(patch)}`, (mutationId) =>
    ann(s).update(id, patch, { mutationId }),
  );
}

export function publishAnnouncement(s: Session, id: string): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `publish:${id}`, (mutationId) =>
    ann(s).update(id, { status: 'published' }, { mutationId }),
  );
}

export function deleteAnnouncement(s: Session, id: string): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `delete:${id}`, (mutationId) =>
    ann(s).delete(id, { mutationId }),
  );
}

export async function listAnnouncements(s: Session): Promise<Array<RecordView<Announcement>>> {
  return ann(s).query({ orderBy: 'title' });
}

// ---------------------------------------------------------------- requests

export function createRequest(
  s: Session,
  intent: string,
  title: string,
  details: string,
  tags: string[] = [],
): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `request:${intent}`, (mutationId) =>
    req(s).create(
      { title, details, tags: [...new Set(tags)].sort(), state: 'open' },
      { mutationId },
    ),
  );
}

/** Claims a request for the current user. Concurrent claims resolve to one claimant (lww). */
export function claimRequest(s: Session, id: string): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `claim:${id}`, (mutationId) =>
    req(s).update(id, { claimedBy: s.user }, { mutationId }),
  );
}

/** Adds tags. Concurrent tag edits merge (set-union), so no tag is lost. */
export async function tagRequest(s: Session, id: string, add: string[]): Promise<WriteResult> {
  const current = (await req(s).get(id))?.value.tags ?? [];
  const tags = [...new Set([...current, ...add])].sort();
  return runAction(s.replica, s.pending, `tag:${id}:${add.join(',')}`, (mutationId) =>
    req(s).update(id, { tags }, { mutationId }),
  );
}

/**
 * Adds one "me too" to a request (R13.7). Taps on several devices at the same time all count:
 * the field uses the counter resolver. A retry of the same unfinished tap reuses its mutationId,
 * so a crash never counts a tap twice.
 */
export function meToo(s: Session, id: string): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `metoo:${id}`, (mutationId) =>
    req(s).update(id, { meToo: 1 }, { mutationId }),
  );
}

/** The number of "me too" taps on a request (0 when nobody tapped). */
export function meTooCount(r: RecordView<HelpRequest>): number {
  return r.value.meToo ?? 0;
}

export function fulfilRequest(s: Session, id: string): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `fulfil:${id}`, (mutationId) =>
    req(s).update(id, { state: 'fulfilled' }, { mutationId }),
  );
}

export async function listRequests(s: Session): Promise<Array<RecordView<HelpRequest>>> {
  return req(s).query({ orderBy: 'title' });
}

// ---------------------------------------------------------------- notices (R13.2, R13.4)

export interface Notice {
  readonly conflictId: string;
  readonly kind: 'claim-lost' | 'claim-conflict' | 'edit-not-applied' | 'delete-conflict';
  readonly collection: string;
  readonly recordId: string;
  readonly message: string;
  readonly open: boolean;
}

/**
 * Notices are built from the conflict views, not from live events, so a notice missed while the
 * app was closed still shows (design 13.1).
 */
export async function notices(s: Session): Promise<Notice[]> {
  const open = new Set((await s.replica.conflicts.current()).map((c) => c.conflictId));
  const out: Notice[] = [];
  for (const c of await s.replica.conflicts.history()) {
    const col = c.collection === 'requests' ? req(s) : ann(s);
    // Only this device's ops IN the conflict frontier count: an earlier op that was causally
    // superseded before the conflict happened is not part of it.
    const inFrontier = new Set(
      c.frontier
        .filter((e) => e.opId.replicaId === s.replica.id)
        .map((e) => `${e.opId.replicaId}:${e.opId.seq}`),
    );
    const mine = (await col.history(c.recordId)).filter((h) =>
      inFrontier.has(`${h.opId.replicaId}:${h.opId.seq}`),
    );
    const base = {
      conflictId: c.conflictId,
      collection: c.collection,
      recordId: c.recordId,
      open: open.has(c.conflictId),
    };
    if (c.kind === 'field' && c.field === 'claimedBy') {
      const iClaimed = c.frontier.some(
        (e) => e.opId.replicaId === s.replica.id && e.value === s.user,
      );
      const winner = typeof c.resolved === 'string' ? c.resolved : 'someone';
      out.push(
        iClaimed && c.resolved !== s.user
          ? {
              ...base,
              kind: 'claim-lost',
              message: `Someone else was chosen: ${winner} has this request.`,
            }
          : {
              ...base,
              kind: 'claim-conflict',
              message: `Several people claimed this request; ${winner} has it.`,
            },
      );
    } else if (c.kind === 'delete') {
      // A delete conflict's frontier is the delete and the edits concurrent with it.
      const iEdited = mine.some((h) => h.kind === 'set');
      out.push(
        iEdited
          ? {
              ...base,
              kind: 'edit-not-applied',
              message: 'Your edit was not applied: the item was deleted at the same time.',
            }
          : {
              ...base,
              kind: 'delete-conflict',
              message: 'An item was deleted while someone was editing it.',
            },
      );
    }
  }
  return out;
}
