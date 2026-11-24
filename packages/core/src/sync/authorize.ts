/**
 * [ADV] Authorization hook and authenticated identity (R16.3, R16.4, task T5.6). Semantically
 * opaque helpers shared by replicas and the relay: they read only envelope fields.
 *
 * - Identity: when a transport authenticated the caller (`AuthContext`), the `replicaId` a request
 *   claims and the origin of every op it pushes must be in `writableAs`; otherwise the request
 *   fails with `UNAUTHORIZED` before anything is stored or acknowledged.
 * - Hook: an optional `AuthorizeHook` decides each batch before it is applied or sent. Anything but
 *   `true` (false, a throw, a rejection) denies with `UNAUTHORIZED`. Fail closed.
 */
import { WeaveError } from '../contracts/errors.js';
import type { ReplicaId } from '../contracts/json.js';
import type { AuthContext, AuthorizeHook, AuthorizeRequest, OpSummary } from '../contracts/sync.js';
import { readEnvelope } from '../ops/op.js';

function denied(message: string, details: Record<string, unknown>, cause?: unknown): WeaveError {
  return new WeaveError('UNAUTHORIZED', message, {
    details,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Whether `auth` may act as `replicaId`. No `auth` means no authenticated identity: allowed. */
export function mayActAs(auth: AuthContext | undefined, replicaId: ReplicaId): boolean {
  if (auth === undefined) return true;
  return auth.writableAs === '*' || auth.writableAs.includes(replicaId);
}

/**
 * R16.3: the claimed `replicaId` of a request, and the origin of every op it carries, must be one
 * the authenticated caller may act as.
 * @throws UNAUTHORIZED naming the principal and the first replica ID it may not act as.
 */
export function assertIdentity(
  auth: AuthContext | undefined,
  claimed: ReplicaId,
  origins: Iterable<ReplicaId> = [],
): void {
  if (auth === undefined) return;
  for (const id of [claimed, ...origins]) {
    if (!mayActAs(auth, id))
      throw denied(`"${auth.principal}" may not act as replica ${id}`, {
        principal: auth.principal,
        replicaId: id,
      });
  }
}

/** The envelope summary of op lines (no field values are read). */
export function summarize(lines: readonly string[]): OpSummary[] {
  return lines.map((line) => {
    const e = readEnvelope(line);
    return {
      replicaId: e.replicaId,
      seq: e.seq,
      collection: e.collection,
      schemaVersion: e.schemaVersion,
    };
  });
}

/**
 * Runs the hook, if any, and fails closed. Called with no ops it does nothing.
 * @throws UNAUTHORIZED when the hook returns anything but `true`, throws or rejects.
 */
export async function runAuthorize(
  hook: AuthorizeHook | undefined,
  request: AuthorizeRequest,
): Promise<void> {
  if (hook === undefined || request.ops.length === 0) return;
  let allowed: unknown;
  try {
    allowed = await hook(request);
  } catch (e) {
    throw denied('The authorization hook failed; the request is denied', hookDetails(request), e);
  }
  if (allowed !== true)
    throw denied(`Not authorized to ${request.direction} these ops`, hookDetails(request));
}

function hookDetails(request: AuthorizeRequest): Record<string, unknown> {
  return {
    direction: request.direction,
    peer: request.peer,
    ...(request.auth === undefined ? {} : { principal: request.auth.principal }),
    ops: request.ops.length,
  };
}
