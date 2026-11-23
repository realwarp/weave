/**
 * FIELDNOTE browser UI (design 13.2). `?device=<name>` chooses the IndexedDB database and so the
 * replica; `?schema=1` runs the old v1 schema (to try mixed-version sync). Every button is one
 * intent with a stable mutationId stored in localStorage before the write. User text is rendered
 * with textContent only.
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
  observationsOf,
  setStatus,
  type Session,
  type Status,
} from './logic.js';
import { STATUS, collectionsV1, collectionsV2 } from './model.js';
import { localPending } from './pending.js';

const params = new URLSearchParams(location.search);
const device =
  (params.get('device') ?? 'worker1').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'worker1';
const version: 1 | 2 = params.get('schema') === '1' ? 1 : 2;
const token = params.get('token') ?? undefined;

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node;
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
function button(label: string, onClick: () => Promise<unknown>): HTMLButtonElement {
  const b = el('button', label);
  b.type = 'button';
  b.addEventListener('click', () => void act(onClick));
  return b;
}
const status = (text: string) => ($('status').textContent = text);

async function act(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await render();
  } catch (e) {
    status(`Error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

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

$('device').textContent = device;
$('schema').textContent = `schema v${version}`;
document.title = `FIELDNOTE - ${device}`;
if (version === 1) {
  for (const name of ['site', 'zone'])
    ($('insp-form').querySelector(`[name=${name}]`) as HTMLInputElement).placeholder =
      name === 'site' ? 'Location' : '(v2 only)';
  ($('insp-form').querySelector('[name=zone]') as HTMLInputElement).disabled = true;
}

async function renderDetail(): Promise<void> {
  const box = $('detail');
  box.replaceChildren();
  const row = (await listInspections(session)).find((r) => r.id === selected);
  if (row === undefined) {
    box.append(el('p', 'Select an inspection.', 'meta'));
    return;
  }
  box.append(
    el('h3', row.title),
    el(
      'p',
      `${row.where || 'no location'} - ${row.status} - assigned: ${row.assignees.join(', ') || 'nobody'}`,
      'meta',
    ),
  );
  const statusRow = el('p');
  for (const s of STATUS)
    if (s !== row.status)
      statusRow.append(button(`Mark ${s}`, () => setStatus(session, row.id, s as Status)));
  statusRow.append(
    button('Rename', async () => {
      const title = prompt('Title', row.title);
      if (title) await editInspection(session, row.id, { title });
    }),
  );
  box.append(statusRow);

  box.append(el('h4', 'Observations'));
  const form = el('form');
  form.id = 'obs-form';
  const note = el('input');
  note.name = 'note';
  note.placeholder = 'Observation';
  note.required = true;
  const severity = el('select');
  severity.name = 'severity';
  for (let i = 1; i <= 5; i++) severity.append(new Option(`severity ${i}`, String(i)));
  const reading = el('input');
  reading.name = 'reading';
  reading.placeholder = 'Reading (number)';
  reading.inputMode = 'decimal';
  const submit = el('button', 'Add observation');
  submit.type = 'submit';
  form.append(note, severity, reading, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    form.dataset['intent'] ??= crypto.randomUUID();
    const intent = form.dataset['intent'];
    const value = {
      note: note.value,
      severity: Number(severity.value),
      ...(reading.value.trim() ? { reading: Number(reading.value) } : {}),
    };
    void act(async () => {
      await addObservation(session, intent, row.id, value);
      delete form.dataset['intent'];
    });
  });
  box.append(form);
  const list = el('ul');
  list.id = 'observations';
  for (const o of await observationsOf(session, row.id)) {
    const li = el(
      'li',
      `${o.note ?? ''} - severity ${o.severity}${o.reading === undefined ? '' : `, reading ${o.reading}`}`,
    );
    li.append(
      button('Raise severity', () =>
        editObservation(session, o.id, { severity: Math.min(5, o.severity + 1) }),
      ),
    );
    list.append(li);
  }
  box.append(list);

  box.append(el('h4', 'Operation history'));
  const hist = el('ol', undefined, 'meta');
  for (const h of await inspectionHistory(session, row.id)) {
    hist.append(
      el(
        'li',
        `v${h.schemaVersion} ${h.kind} ${JSON.stringify(h.fields)}${h.concurrentWith ? ` - concurrent with ${h.concurrentWith}` : ''}`,
      ),
    );
  }
  box.append(hist);
}

// Renders run one at a time: a change event and an action can both ask for one, and two
// overlapping renders would each clear and then fill the same lists.
let rendering: Promise<void> = Promise.resolve();
function render(): Promise<void> {
  rendering = rendering.then(draw, draw);
  return rendering;
}

async function draw(): Promise<void> {
  const body = $('inspections');
  body.replaceChildren();
  for (const r of await listInspections(session)) {
    const tr = el('tr', undefined, r.id === selected ? 'selected' : undefined);
    tr.dataset['id'] = r.id;
    tr.append(
      el('td', r.title),
      el('td', r.where),
      el('td', `${r.status}${r.openConflicts ? ` (${r.openConflicts} conflict)` : ''}`),
    );
    const cell = el('td');
    cell.append(
      button('Open', async () => {
        selected = r.id;
      }),
    );
    tr.append(cell);
    body.append(tr);
  }
  await renderDetail();
  const conflicts = $('conflicts');
  conflicts.replaceChildren();
  for (const c of await conflictHistory(session)) {
    const tr = el('tr');
    tr.append(
      el('td', `${c.collection}/${c.recordId.slice(0, 8)}`),
      el('td', c.field),
      el('td', c.values.join(' | ')),
      el('td', c.resolved),
      el('td', c.status),
    );
    conflicts.append(tr);
  }
}

$('insp-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  form.dataset['intent'] ??= crypto.randomUUID();
  const intent = form.dataset['intent'];
  const title = String(data.get('title'));
  const site = String(data.get('site') ?? '').trim();
  const zone = String(data.get('zone') ?? '').trim();
  const input =
    version === 1
      ? { title, ...(site ? { location: site } : {}) }
      : { title, ...(site ? { site } : {}), ...(zone ? { zone } : {}) };
  void act(async () => {
    selected = (await createInspection(session, intent, input, [device])).recordId;
    delete form.dataset['intent'];
    form.reset();
  });
});

$('sync').addEventListener(
  'click',
  () =>
    void act(async () => {
      status('Syncing...');
      const r = await replica.sync(relay);
      status(
        r.status === 'complete'
          ? 'Synced.'
          : r.status === 'partial'
            ? `Partial: ${r.code}`
            : `Sync failed: ${r.code}`,
      );
    }),
);

replica.subscribe(() => void render());
await render();
status('Offline-ready. Press Sync to exchange changes.');
