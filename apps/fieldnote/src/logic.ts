/**
 * FIELDNOTE actions and views (R14.1 to R14.6). A session runs either schema version; version 1
 * writes `location`, version 2 writes `site` and `zone`. Every action has one stable mutationId.
 */
import type { Collection, Replica, WriteResult } from '@weave/core';
import type {
  STATUS} from './model.js';
import {
  inspectionsV1,
  inspectionsV2,
  observations,
  type InspectionV2,
  type Observation,
} from './model.js';
import { runAction, type PendingStore } from './pending.js';

export interface Session {
  readonly replica: Replica;
  readonly pending: PendingStore;
  readonly user: string;
  /** The schema version this device runs. */
  readonly version: 1 | 2;
}

export type Status = (typeof STATUS)[number];

/** Inspection fields that both versions accept for writing. */
export interface InspectionInput {
  title?: string;
  /** Version 1 only. */
  location?: string;
  /** Version 2 only. */
  site?: string;
  zone?: string;
}

type AnyInspection = Record<string, unknown>;

function insp(s: Session): Collection<AnyInspection> {
  return (s.version === 1
    ? s.replica.collection(inspectionsV1)
    : s.replica.collection(inspectionsV2)) as unknown as Collection<AnyInspection>;
}
const obs = (s: Session) => s.replica.collection(observations);

function fieldsFor(s: Session, input: InspectionInput): AnyInspection {
  const out: AnyInspection = {};
  if (input.title !== undefined) out['title'] = input.title;
  if (s.version === 1) {
    if (input.site !== undefined || input.zone !== undefined)
      throw new Error('site and zone need schema version 2');
    if (input.location !== undefined) out['location'] = input.location;
  } else {
    if (input.location !== undefined)
      throw new Error('location was replaced by site and zone in version 2');
    if (input.site !== undefined) out['site'] = input.site;
    if (input.zone !== undefined) out['zone'] = input.zone;
  }
  return out;
}

// Input is checked before an intent is recorded, so a bad call never stores a mutationId.
export function createInspection(
  s: Session,
  intent: string,
  input: InspectionInput & { title: string },
  assignees: string[] = [],
): Promise<WriteResult> {
  const value = {
    ...fieldsFor(s, input),
    status: 'open',
    assignees: [...new Set(assignees)].sort(),
  };
  return runAction(s.replica, s.pending, `inspection:${intent}`, (mutationId) =>
    insp(s).create(value, { mutationId }),
  );
}

export function editInspection(
  s: Session,
  id: string,
  input: InspectionInput,
): Promise<WriteResult> {
  const patch = fieldsFor(s, input);
  return runAction(s.replica, s.pending, `edit:${id}:${JSON.stringify(input)}`, (mutationId) =>
    insp(s).update(id, patch, { mutationId }),
  );
}

/** Status only moves forward under concurrency: the more advanced status wins (max-rank). */
export function setStatus(s: Session, id: string, status: Status): Promise<WriteResult> {
  return runAction(s.replica, s.pending, `status:${id}:${status}`, (mutationId) =>
    insp(s).update(id, { status }, { mutationId }),
  );
}

export async function assign(s: Session, id: string, people: string[]): Promise<WriteResult> {
  const current = ((await insp(s).get(id))?.value['assignees'] as string[] | undefined) ?? [];
  const assignees = [...new Set([...current, ...people])].sort();
  return runAction(s.replica, s.pending, `assign:${id}:${people.join(',')}`, (mutationId) =>
    insp(s).update(id, { assignees }, { mutationId }),
  );
}

function checkSeverity(severity: number): number {
  if (!Number.isInteger(severity) || severity < 1 || severity > 5)
    throw new Error('severity must be an integer from 1 to 5');
  return severity;
}

export function addObservation(
  s: Session,
  intent: string,
  inspectionId: string,
  input: { note: string; severity: number; reading?: number },
): Promise<WriteResult> {
  const value: Observation = {
    inspectionId,
    note: input.note,
    severity: checkSeverity(input.severity),
  };
  if (input.reading !== undefined) value.reading = input.reading;
  return runAction(s.replica, s.pending, `observation:${intent}`, (mutationId) =>
    obs(s).create(value, { mutationId }),
  );
}

export function editObservation(
  s: Session,
  id: string,
  patch: { note?: string; severity?: number; reading?: number },
): Promise<WriteResult> {
  const p: Partial<Observation> = {};
  if (patch.note !== undefined) p.note = patch.note;
  if (patch.severity !== undefined) p.severity = checkSeverity(patch.severity);
  if (patch.reading !== undefined) p.reading = patch.reading;
  return runAction(s.replica, s.pending, `obs-edit:${id}:${JSON.stringify(p)}`, (mutationId) =>
    obs(s).update(id, p, { mutationId }),
  );
}

// ---------------------------------------------------------------- views

export interface InspectionRow {
  readonly id: string;
  readonly title: string;
  /** "site / zone" for v2, the raw `location` for v1. */
  readonly where: string;
  readonly status: Status;
  readonly assignees: readonly string[];
  readonly openConflicts: number;
}

export async function listInspections(s: Session): Promise<InspectionRow[]> {
  const rows = await insp(s).query({ orderBy: 'title' });
  return rows.map((r) => {
    const v = r.value as Partial<InspectionV2> & { location?: string };
    const where =
      s.version === 1
        ? (v.location ?? '')
        : [v.site, v.zone].filter((x) => x !== undefined && x !== '').join(' / ');
    return {
      id: r.id,
      title: String(v.title ?? ''),
      where,
      status: (v.status ?? 'open') as Status,
      assignees: v.assignees ?? [],
      openConflicts: r.conflicts.length,
    };
  });
}

export async function observationsOf(s: Session, inspectionId: string) {
  const all = await obs(s).query({ where: { inspectionId } });
  return all.map((o) => ({ id: o.id, ...o.value, openConflicts: o.conflicts.length }));
}

/** One line per op of an inspection, oldest first, as written (not migrated) (R2.5). */
export async function inspectionHistory(s: Session, id: string) {
  return (await insp(s).history(id)).map((h) => ({
    by: h.opId.replicaId,
    seq: h.opId.seq,
    kind: h.kind,
    schemaVersion: h.schemaVersion,
    fields: h.fields,
    concurrentWith: h.concurrentWith.length,
  }));
}

export interface ConflictRow {
  readonly conflictId: string;
  readonly collection: string;
  readonly recordId: string;
  readonly field: string;
  readonly values: readonly string[];
  readonly resolved: string;
  readonly status: 'open' | 'superseded';
}

/**
 * The conflict history view (R14.4): every concurrent edit that WEAVE resolved, with the competing
 * values and the result, built from `conflicts.history()`.
 */
export async function conflictHistory(s: Session): Promise<ConflictRow[]> {
  const show = (v: unknown) =>
    v === undefined ? '(none)' : typeof v === 'string' ? v : JSON.stringify(v);
  const rows: ConflictRow[] = [];
  for (const c of await s.replica.conflicts.history()) {
    const col = c.collection === 'observations' ? obs(s) : insp(s);
    const ops = await col.history(c.recordId);
    const key = (o: { replicaId: string; seq: number }) => `${o.replicaId}:${o.seq}`;
    // The competing edits: ops on this field that ran at the same time as another op on it.
    const touching = ops.filter((h) =>
      c.kind === 'delete' ? true : c.field !== undefined && c.field in h.fields,
    );
    const ids = new Set(touching.map((h) => key(h.opId)));
    const competing = touching.filter((h) => h.concurrentWith.some((o) => ids.has(key(o))));
    rows.push({
      conflictId: c.conflictId,
      collection: c.collection,
      recordId: c.recordId,
      field: c.kind === 'delete' ? '(deleted)' : (c.field ?? ''),
      values: competing.map((h) =>
        h.kind === 'delete'
          ? 'delete'
          : show(c.field === undefined ? undefined : h.fields[c.field]),
      ),
      resolved: c.kind === 'delete' ? 'deleted' : show(c.resolved),
      status: c.status,
    });
  }
  return rows;
}
