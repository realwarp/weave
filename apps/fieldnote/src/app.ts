/**
 * FIELDNOTE browser UI (design 13.2). `?device=<name>` chooses the IndexedDB database and so the
 * replica; `?schema=1` runs the old v1 schema (to try mixed-version sync). Every button is one
 * intent with a stable mutationId stored in localStorage before the write. User text is rendered
 * with textContent only.
 *
 * The forms are static: re-renders after a sync or a change only rebuild the lists and the record
 * header, so text a worker is typing is never wiped.
 */
import { createReplica } from '@weave/core';
import { indexedDbStorage } from '@weave/storage/indexeddb';
import { httpTransport } from '@weave/transport/http';
import {
  addObservation,
  conflictHistory,
  createInspection,
  editInspection,
  editObservation,
  inspectionHistory,
  listInspections,
  observationNotes,
  observationsOf,
  parseReading,
  setStatus,
  type InspectionRow,
  type Session,
  type Status,
} from './logic.js';
import { collectionsV1, collectionsV2 } from './model.js';
import { formIntent, localPending } from './pending.js';

const params = new URLSearchParams(location.search);
const device =
  (params.get('device') ?? 'worker1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'worker1';
const version: 1 | 2 = params.get('schema') === '1' ? 1 : 2;
const token = params.get('token') ?? undefined;

// ---------------------------------------------------------------- DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
};
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  cls?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls !== undefined) node.className = cls;
  return node;
}
function button(label: string, onClick: () => Promise<unknown>, cls = 'btn'): HTMLButtonElement {
  const b = el('button', label, cls);
  b.type = 'button';
  b.addEventListener('click', () => void act(onClick, b));
  return b;
}

const STATUS_LABEL: Record<Status, string> = {
  open: 'Open',
  in_review: 'In review',
  closed: 'Closed',
};
function statusMark(s: Status): HTMLSpanElement {
  const span = el('span', STATUS_LABEL[s], 'st');
  span.dataset['s'] = s;
  return span;
}

// ---------------------------------------------------------------- status line

type SyncState = 'ready' | 'syncing' | 'synced' | 'partial' | 'offline' | 'error';

const MESSAGES = {
  ready: 'Ready. Your notes are saved on this device.',
  offline: "You're offline. Notes are saved on this device.",
  backOnline: 'Back online. Press Sync to share your notes.',
  syncing: 'Sharing your notes...',
  synced: 'Up to date.',
  failed: "Couldn't sync. Your notes are still saved here. Try again.",
  schemaOlder: 'Partly up to date. Some changes need a newer schema on this device.',
  notSettled: 'Still catching up. Press Sync again to finish.',
  actionFailed: "That didn't work. Please try again.",
} as const;

function status(text: string, state: SyncState, detail?: string): void {
  $('status').textContent = text;
  $('sync-state').dataset['state'] = state;
  const toggle = $<HTMLButtonElement>('sync-detail-toggle');
  const box = $('sync-detail');
  box.textContent = detail ?? '';
  box.hidden = true;
  toggle.hidden = detail === undefined;
  toggle.textContent = 'Details';
  toggle.setAttribute('aria-expanded', 'false');
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
}

async function act(fn: () => Promise<unknown>, source?: HTMLButtonElement): Promise<void> {
  if (source !== undefined) source.disabled = true;
  try {
    await fn();
    await render();
  } catch (e) {
    status(MESSAGES.actionFailed, 'error', errorDetail(e));
  } finally {
    if (source !== undefined && source.isConnected) source.disabled = false;
  }
}

// ---------------------------------------------------------------- replica

const replica = await createReplica({
  storage: indexedDbStorage({ name: `fieldnote-${device}` }),
  collections: version === 1 ? collectionsV1 : collectionsV2,
});
const session: Session = {
  replica,
  pending: localPending(device, localStorage),
  user: device,
  version,
};
const relay = httpTransport({
  baseUrl: location.origin,
  ...(token === undefined ? {} : { token }),
});
let selected: string | undefined;
/** The title being typed in the rename box, kept across re-renders. */
let renaming: { id: string; text: string } | null = null;

$('device').textContent = device;
const schemaChip = $('schema');
schemaChip.textContent = `schema v${version}`;
if (version === 1) {
  schemaChip.dataset['old'] = 'true';
  schemaChip.title = 'This device runs the older schema v1: it writes a single location field';
}
document.title = `FIELDNOTE · ${device}`;

const inspForm = $<HTMLFormElement>('insp-form');
if (version === 1) {
  $('site-label').firstChild!.textContent = 'Location ';
  (inspForm.elements.namedItem('site') as HTMLInputElement).placeholder = 'Location';
  const zone = inspForm.elements.namedItem('zone') as HTMLInputElement;
  zone.placeholder = 'Needs schema v2';
  zone.disabled = true;
}

// Severity: five large targets, 1 minor to 5 critical (the field's resolver keeps the higher).
const sevOpts = $('sev-opts');
for (let i = 1; i <= 5; i++) {
  const label = el('label');
  const input = el('input');
  input.type = 'radio';
  input.name = 'severity';
  input.value = String(i);
  input.checked = i === 1;
  input.setAttribute('aria-label', `Severity ${i}`);
  label.append(input, el('span', String(i), i >= 4 ? 'high' : undefined));
  sevOpts.append(label);
}

// ---------------------------------------------------------------- rendering

let rendering: Promise<void> = Promise.resolve();
function render(): Promise<void> {
  rendering = rendering.then(draw, draw);
  return rendering;
}

function select(id: string): void {
  if (selected !== id) {
    selected = id;
    renaming = null;
    resetObsForm();
  }
  void render().then(() => {
    if (matchMedia('(max-width: 900px)').matches) $('detail').scrollIntoView({ block: 'start' });
  });
}

function inspectionRow(r: InspectionRow): HTMLTableRowElement {
  const tr = el('tr', undefined, r.id === selected ? 'selected' : undefined);
  tr.dataset['id'] = r.id;
  const td = el('td');
  const b = el('button', undefined, 'row-btn');
  b.type = 'button';
  b.setAttribute('aria-pressed', String(r.id === selected));
  b.append(el('span', r.title, 't'), statusMark(r.status));
  b.append(el('span', r.where || 'No location', r.where ? 'w' : 'w none'));
  if (r.openConflicts > 0)
    b.append(
      el('span', `${r.openConflicts} open conflict${r.openConflicts === 1 ? '' : 's'}`, 'c'),
    );
  b.addEventListener('click', () => select(r.id));
  td.append(b);
  tr.append(td);
  return tr;
}

function fact(label: string, value: string, emptyText: string): HTMLDivElement {
  const d = el('div');
  d.append(el('div', label, 'label'), el('div', value || emptyText, value ? 'v' : 'v none'));
  return d;
}

function whereParts(row: InspectionRow): { site: string; zone: string } {
  if (version === 1) return { site: row.where, zone: '' };
  const [site = '', zone = ''] = row.where.split(' / ');
  return { site, zone };
}

function recordHead(row: InspectionRow): HTMLElement[] {
  const top = el('div', undefined, 'top-line');
  const titleBox = el('div');
  titleBox.append(el('div', 'Inspection', 'label'), el('h3', row.title));
  top.append(titleBox, statusMark(row.status));

  const facts = el('div', undefined, 'facts');
  const { site, zone } = whereParts(row);
  if (version === 1) facts.append(fact('Location', site, 'Not recorded'));
  else facts.append(fact('Site', site, 'Not recorded'), fact('Zone', zone, 'Not recorded'));
  facts.append(fact('Assigned', row.assignees.join(', '), 'Nobody'));

  // The status path. Under concurrency the more advanced status wins (max-rank).
  const path = el('ol', undefined, 'path');
  path.setAttribute('aria-label', 'Status path');
  const order: Status[] = ['open', 'in_review', 'closed'];
  const at = order.indexOf(row.status);
  order.forEach((s, i) => {
    const li = el(
      'li',
      undefined,
      i < at ? 'done' : i === at ? (s === 'closed' ? 'done' : 'now') : '',
    );
    li.append(el('span', undefined, 'pt'), el('span', STATUS_LABEL[s]));
    if (i === at) li.setAttribute('aria-current', 'step');
    path.append(li);
  });

  const actions = el('div', undefined, 'rec-actions');
  const move = (s: Status, cls: string) =>
    button(`Mark ${STATUS_LABEL[s].toLowerCase()}`, () => setStatus(session, row.id, s), cls);
  if (row.status === 'open')
    actions.append(move('in_review', 'btn primary'), move('closed', 'btn'));
  else if (row.status === 'in_review')
    actions.append(move('closed', 'btn primary'), move('open', 'btn quiet'));
  else actions.append(move('open', 'btn'), move('in_review', 'btn quiet'));
  if (renaming?.id !== row.id)
    actions.append(
      button(
        'Rename',
        async () => {
          renaming = { id: row.id, text: row.title };
        },
        'btn quiet',
      ),
    );

  const out: HTMLElement[] = [top, facts, path, actions];
  if (renaming?.id === row.id) {
    const form = el('form', undefined, 'rename');
    const input = el('input');
    input.type = 'text';
    input.value = renaming.text;
    input.setAttribute('aria-label', 'New title');
    input.maxLength = 140;
    input.addEventListener('input', () => {
      if (renaming !== null) renaming.text = input.value;
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        renaming = null;
        void render();
      }
    });
    const save = el('button', 'Save title', 'btn primary');
    save.type = 'submit';
    const cancel = button(
      'Cancel',
      async () => {
        renaming = null;
      },
      'btn quiet',
    );
    form.append(input, save, cancel);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const title = input.value.trim();
      if (!title) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      void act(async () => {
        await editInspection(session, row.id, { title });
        renaming = null;
      }, save);
    });
    queueMicrotask(() => input.focus());
    out.push(form);
  }
  return out;
}

function fieldLabel(key: string): string {
  return key === 'assignees' ? 'assigned' : key;
}
function fieldValue(key: string, v: unknown): string {
  if (key === 'status' && typeof v === 'string' && v in STATUS_LABEL)
    return STATUS_LABEL[v as Status];
  if (Array.isArray(v)) return v.join(', ');
  return typeof v === 'string' ? v : JSON.stringify(v);
}

async function drawRecord(row: InspectionRow | undefined): Promise<void> {
  $('rec-empty').hidden = row !== undefined;
  $('rec').hidden = row === undefined;
  if (row === undefined) return;
  $('rec-head').replaceChildren(...recordHead(row));

  const obsList = await observationsOf(session, row.id);
  $('obs-count').textContent = obsList.length ? String(obsList.length) : '';
  $('obs-empty').hidden = obsList.length > 0;
  $('observations').replaceChildren(
    ...obsList.map((o) => {
      const li = el('li', undefined, 'obs');
      li.dataset['id'] = o.id;
      const box = el('span', String(o.severity), o.severity >= 4 ? 'sevbox high' : 'sevbox');
      box.setAttribute('aria-hidden', 'true');
      const parts = el('div', undefined, 'facts-line');
      parts.append(`Severity ${o.severity}`);
      if (o.reading !== undefined)
        parts.append(' · Reading ', el('span', String(o.reading), 'mono'));
      if (o.openConflicts > 0) parts.append(' · ', el('span', 'conflicting edits', 'flag'));
      li.append(box, el('span', o.note ?? '', 'note'), parts);
      if (o.severity < 5) {
        const raise = button(
          'Raise severity',
          () => editObservation(session, o.id, { severity: o.severity + 1 }),
          'btn sm quiet act',
        );
        li.append(raise);
      }
      return li;
    }),
  );

  const history = await inspectionHistory(session, row.id);
  $('history').replaceChildren(
    ...history.map((h, i) => {
      const li = el('li', undefined, h.concurrentWith ? 'concurrent' : undefined);
      const what = h.kind === 'delete' ? 'Deleted' : i === 0 ? 'Created' : 'Changed';
      li.append(el('div', what, 'what'));
      const entries = Object.entries(h.fields);
      if (entries.length > 0) {
        const changes = el('ul', undefined, 'changes');
        for (const [k, v] of entries) {
          const c = el('li');
          c.append(`${fieldLabel(k)}: `, el('b', fieldValue(k, v)));
          changes.append(c);
        }
        li.append(changes);
      }
      const by = el('div', undefined, 'by');
      by.append(
        `schema v${h.schemaVersion} · ${h.by === replica.id ? 'this device' : `device ${h.by.slice(0, 8)}`} · change ${h.seq}`,
      );
      if (h.concurrentWith)
        by.append(
          ' · ',
          el(
            'span',
            `at the same time as ${h.concurrentWith} other change${h.concurrentWith === 1 ? '' : 's'}`,
            'flag',
          ),
        );
      li.append(by);
      return li;
    }),
  );
}

const RULE: Record<string, string> = {
  'inspections/status': 'most advanced status wins',
  'observations/severity': 'higher severity wins',
  'inspections/assignees': 'everyone is kept',
};

async function draw(): Promise<void> {
  const rows = await listInspections(session);
  if (selected !== undefined && !rows.some((r) => r.id === selected)) selected = undefined;
  $('inspections').replaceChildren(...rows.map(inspectionRow));
  $('insp-empty').hidden = rows.length > 0;
  const open = rows.filter((r) => r.status !== 'closed').length;
  $('insp-count').textContent = rows.length ? `${open} active · ${rows.length} total` : '';

  await drawRecord(rows.find((r) => r.id === selected));

  const titles = new Map(rows.map((r) => [r.id, r.title]));
  const notes = await observationNotes(session);
  const conflicts = await conflictHistory(session);
  $('conflict-empty').hidden = conflicts.length > 0;
  const openCount = conflicts.filter((c) => c.status === 'open').length;
  $('conflict-count').textContent = conflicts.length
    ? `${openCount} open · ${conflicts.length - openCount} settled`
    : '';
  $('conflicts').replaceChildren(
    ...conflicts.map((c) => {
      const tr = el('tr');
      const rec = el('td', undefined, 'rec');
      rec.dataset['h'] = 'Record';
      const name = c.collection === 'inspections' ? titles.get(c.recordId) : notes.get(c.recordId);
      rec.append(
        name || `${c.collection} ${c.recordId.slice(0, 8)}`,
        el('span', c.collection === 'inspections' ? 'Inspection' : 'Observation', 'kind'),
      );
      const field = el('td', c.field);
      field.dataset['h'] = 'Field';
      field.append(el('span', RULE[`${c.collection}/${c.field}`] ?? 'last writer wins', 'kind'));
      const vals = el('td');
      vals.dataset['h'] = 'Competing values';
      const list = el('div', undefined, 'vals');
      const shown = (v: string) => (c.field === 'status' ? fieldValue('status', v) : v);
      for (const v of c.values)
        list.append(el('span', shown(v), v === c.resolved ? 'won' : undefined));
      vals.append(list);
      const result = el('td', shown(c.resolved), 'result');
      result.dataset['h'] = 'Result';
      const state = el('td');
      state.dataset['h'] = 'State';
      state.append(
        el(
          'span',
          c.status === 'open' ? 'Open' : 'Settled',
          `cstate ${c.status === 'open' ? 'open' : 'settled'}`,
        ),
      );
      tr.append(rec, field, vals, result, state);
      return tr;
    }),
  );
}

// ---------------------------------------------------------------- new inspection

const inspIntent = formIntent(device, localStorage, 'inspection');
let inspBusy = false;
inspForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (inspBusy) return;
  const title = (inspForm.elements.namedItem('title') as HTMLInputElement).value.trim();
  const titleInput = inspForm.elements.namedItem('title') as HTMLInputElement;
  if (!title) {
    titleInput.setAttribute('aria-invalid', 'true');
    $('insp-err').textContent = 'Give the inspection a title.';
    titleInput.focus();
    return;
  }
  const data = new FormData(inspForm);
  // Kept in localStorage until the write is recorded, so a re-submit after a reload is a replay.
  const intent = inspIntent.get();
  const site = String(data.get('site') ?? '').trim();
  const zone = String(data.get('zone') ?? '').trim();
  const input =
    version === 1
      ? { title, ...(site ? { location: site } : {}) }
      : { title, ...(site ? { site } : {}), ...(zone ? { zone } : {}) };
  inspBusy = true;
  void act(
    async () => {
      try {
        selected = (await createInspection(session, intent, input, [device])).recordId;
      } finally {
        inspBusy = false;
      }
      inspIntent.done();
      renaming = null;
      resetObsForm();
      // Clear only what was submitted, so text typed while saving is kept.
      for (const f of inspForm.querySelectorAll<HTMLInputElement>('input'))
        if (f.value === String(data.get(f.name) ?? '')) f.value = '';
      flash('insp-say', 'Inspection saved on this device.');
    },
    inspForm.querySelector<HTMLButtonElement>('button[type="submit"]') ?? undefined,
  );
});
(inspForm.elements.namedItem('title') as HTMLInputElement).addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.value.trim()) {
    t.removeAttribute('aria-invalid');
    $('insp-err').textContent = '';
  }
});

const sayTimers = new Map<string, ReturnType<typeof setTimeout>>();
function flash(id: string, text: string): void {
  const say = $(id);
  const idle = say.dataset['idle'] ?? say.textContent ?? '';
  say.dataset['idle'] = idle;
  say.textContent = text;
  say.classList.add('done');
  clearTimeout(sayTimers.get(id));
  sayTimers.set(
    id,
    setTimeout(() => {
      say.textContent = idle;
      say.classList.remove('done');
    }, 4000),
  );
}

// ---------------------------------------------------------------- observations

const obsForm = $<HTMLFormElement>('obs-form');
const noteInput = obsForm.elements.namedItem('note') as HTMLInputElement;
const readingInput = obsForm.elements.namedItem('reading') as HTMLInputElement;

function clearErrors(): void {
  for (const [input, err] of [
    [noteInput, 'note-err'],
    [readingInput, 'reading-err'],
  ] as const) {
    input.removeAttribute('aria-invalid');
    $(err).textContent = '';
  }
}
function resetObsForm(): void {
  obsForm.reset();
  clearErrors();
}
noteInput.addEventListener('input', () => {
  if (noteInput.value.trim()) {
    noteInput.removeAttribute('aria-invalid');
    $('note-err').textContent = '';
  }
});
readingInput.addEventListener('input', () => {
  if (parseReading(readingInput.value).ok) {
    readingInput.removeAttribute('aria-invalid');
    $('reading-err').textContent = '';
  }
});

let obsBusy = false;
obsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const inspectionId = selected;
  if (obsBusy || inspectionId === undefined) return;
  clearErrors();
  const note = noteInput.value.trim();
  const parsed = parseReading(readingInput.value);
  let invalid: HTMLInputElement | undefined;
  if (!parsed.ok) {
    readingInput.setAttribute('aria-invalid', 'true');
    $('reading-err').textContent = parsed.error;
    invalid = readingInput;
  }
  if (!note) {
    noteInput.setAttribute('aria-invalid', 'true');
    $('note-err').textContent = 'Describe what you observed.';
    invalid = noteInput;
  }
  if (invalid !== undefined || !parsed.ok) {
    invalid?.focus();
    return;
  }
  const severity = Number(
    (obsForm.querySelector('input[name="severity"]:checked') as HTMLInputElement | null)?.value ??
      '1',
  );
  const obsIntent = formIntent(device, localStorage, `observation:${inspectionId}`);
  const intent = obsIntent.get();
  const value = {
    note,
    severity,
    ...(parsed.reading === undefined ? {} : { reading: parsed.reading }),
  };
  const submittedNote = noteInput.value;
  const submittedReading = readingInput.value;
  obsBusy = true;
  void act(
    async () => {
      try {
        await addObservation(session, intent, inspectionId, value);
      } finally {
        obsBusy = false;
      }
      obsIntent.done();
      if (noteInput.value === submittedNote) noteInput.value = '';
      if (readingInput.value === submittedReading) readingInput.value = '';
      flash('obs-say', 'Observation saved on this device.');
    },
    obsForm.querySelector<HTMLButtonElement>('button[type="submit"]') ?? undefined,
  );
});

// ---------------------------------------------------------------- sync and network

const syncButton = $<HTMLButtonElement>('sync');
syncButton.addEventListener(
  'click',
  () =>
    void act(async () => {
      syncButton.setAttribute('aria-busy', 'true');
      status(MESSAGES.syncing, 'syncing');
      try {
        const r = await replica.sync(relay);
        if (r.status === 'complete') {
          // `complete` means both sides were verified to hold the same changes (design 8.2).
          status(MESSAGES.synced, 'synced');
          $('sync-state').title = `Last synced at ${new Date().toLocaleTimeString()}`;
        } else if (r.status === 'partial') {
          const detail =
            r.code === 'PEER_SCHEMA_OLDER'
              ? `PEER_SCHEMA_OLDER: ${r.blocked
                  .map((b) => `${b.collection} v${b.requiredVersion} from ${b.origin.slice(0, 8)}`)
                  .join('; ')}`
              : String(r.code);
          status(
            r.code === 'PEER_SCHEMA_OLDER' ? MESSAGES.schemaOlder : MESSAGES.notSettled,
            'partial',
            detail,
          );
        } else {
          status(
            navigator.onLine ? MESSAGES.failed : MESSAGES.offline,
            navigator.onLine ? 'error' : 'offline',
            `sync failed ${String(r.code)}`,
          );
        }
      } catch (e) {
        // Nothing local is lost when a sync fails: every change was committed before it ran.
        status(
          navigator.onLine ? MESSAGES.failed : MESSAGES.offline,
          navigator.onLine ? 'error' : 'offline',
          errorDetail(e),
        );
      } finally {
        syncButton.removeAttribute('aria-busy');
      }
    }, syncButton),
);

const detailToggle = $<HTMLButtonElement>('sync-detail-toggle');
detailToggle.addEventListener('click', () => {
  const box = $('sync-detail');
  box.hidden = !box.hidden;
  detailToggle.setAttribute('aria-expanded', String(!box.hidden));
  detailToggle.textContent = box.hidden ? 'Details' : 'Hide details';
});

function showNetwork(event?: Event): void {
  if (!navigator.onLine) status(MESSAGES.offline, 'offline');
  else if (event !== undefined && $('sync-state').dataset['state'] === 'offline')
    status(MESSAGES.backOnline, 'ready');
}
addEventListener('online', showNetwork);
addEventListener('offline', showNetwork);

replica.subscribe(() => void render());
await render();
status(MESSAGES.ready, 'ready');
showNetwork();
