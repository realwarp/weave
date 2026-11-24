/**
 * NDJSON wire helpers for the relay HTTP API (design 10.1).
 * Line 1 is a JSON header; every following line is one canonical op line.
 * Shared by the HTTP client and the relay server.
 */
import {
  WeaveError,
  type BlockedOrigin,
  type CompactionInfo,
  type PullResponse,
  type PushRequest,
  type Support,
  type VersionVector,
} from '@weave/core/protocol';

function bad(message: string): never {
  throw new WeaveError('VALIDATION_FAILED', `Malformed NDJSON message: ${message}`);
}

function splitLines(text: string): { header: unknown; ops: string[] } {
  const lines = text.split('\n');
  const first = lines.shift();
  if (first === undefined || first.length === 0) bad('missing header line');
  let header: unknown;
  try {
    header = JSON.parse(first);
  } catch {
    bad('header is not JSON');
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header))
    bad('header is not an object');
  const ops = lines
    .filter((l) => l.length > 0)
    .map((l) => (l.endsWith('\r') ? bad('carriage return in op line') : l));
  return { header, ops };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function join(header: unknown, ops: readonly string[]): string {
  for (const op of ops) if (op.includes('\n')) bad('op line contains a newline');
  return [JSON.stringify(header), ...ops].join('\n') + '\n';
}

/**
 * Encodes a pull response as NDJSON text.
 * @param response - The pull response to encode.
 * @returns The NDJSON-encoded pull response.
 */
export function encodePullResponse(response: PullResponse): string {
  const { ops, ...header } = response;
  return join(header, ops);
}

/**
 * Decodes a pull response from NDJSON text.
 * @param text - The NDJSON-encoded pull response.
 * @returns The parsed PullResponse object.
 */
export function decodePullResponse(text: string): PullResponse {
  const { header, ops } = splitLines(text);
  const h = header as Record<string, unknown>;
  if (typeof h['endpointId'] !== 'string') bad('endpointId');
  if (!isObject(h['durable'])) bad('durable');
  if (!(h['support'] === '*' || isObject(h['support']))) bad('support');
  if (!Array.isArray(h['blocked'])) bad('blocked');
  if (typeof h['more'] !== 'boolean') bad('more');
  const compaction = h['compaction'];
  if (
    compaction !== undefined &&
    !(
      isObject(compaction) &&
      isObject(compaction['horizon']) &&
      isObject(compaction['compactedThrough']) &&
      isObject(compaction['removed'])
    )
  )
    bad('compaction');
  return {
    endpointId: h['endpointId'],
    durable: h['durable'] as VersionVector,
    support: h['support'] as Support | '*',
    blocked: h['blocked'] as BlockedOrigin[],
    more: h['more'],
    ops,
    ...(compaction === undefined ? {} : { compaction: compaction as unknown as CompactionInfo }),
  };
}

/**
 * Encodes a push request as NDJSON text.
 * @param request - The push request to encode.
 * @returns The NDJSON-encoded push request.
 */
export function encodePushRequest(request: PushRequest): string {
  const { ops, ...header } = request;
  return join(header, ops);
}

/**
 * Decodes a push request from NDJSON text.
 * @param text - The NDJSON-encoded push request.
 * @returns The parsed PushRequest object.
 */
export function decodePushRequest(text: string): PushRequest {
  const { header, ops } = splitLines(text);
  const h = header as Record<string, unknown>;
  if (typeof h['replicaId'] !== 'string') bad('replicaId');
  if (!isObject(h['support'])) bad('support');
  return { replicaId: h['replicaId'], support: h['support'] as Support, ops };
}
