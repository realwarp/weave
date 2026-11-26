/**
 * GHOSTLINE browser UI (design 13.1). `?device=<name>` chooses the IndexedDB database and so the
 * replica. Every button is one user intent with a stable mutationId stored in localStorage before
 * the write (see pending.ts). All user text is rendered with textContent; icons are fixed SVG
 * markup from this file only.
 */
import { createReplica, type RecordView } from '@weave/core';
import { indexedDbStorage } from '@weave/storage/indexeddb';
import { httpTransport } from '@weave/transport/http';
import {
  claimRequest,
  createRequest,
  deleteAnnouncement,
  draftAnnouncement,
  editAnnouncement,
  fulfilRequest,
  listAnnouncements,
  listRequests,
  meToo,
  meTooCount,
  notices,
  publishAnnouncement,
  tagRequest,
  type Notice,
  type Session,
} from './logic.js';
import { collections, type Announcement, type HelpRequest } from './model.js';
import { formIntent, localPending } from './pending.js';

const params = new URLSearchParams(location.search);
const device =
  (params.get('device') ?? 'alice').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'alice';
const token = params.get('token') ?? undefined;

// ---------------------------------------------------------------- DOM helpers

const $ = <T extends HTMLElement>(id: string): T => {
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

/** Fixed icon paths (never user data). */
const ICONS = {
  hand: 'M7 11V7a2 2 0 1 1 4 0v3M11 10V5.5a2 2 0 1 1 4 0V10M15 10V7a2 2 0 1 1 4 0v6a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4l-2.2-3.8a2 2 0 0 1 3.4-2L7 13',
  plusOne: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  tag: 'M3 12V4h8l9 9-8 8-9-9ZM7.5 7.5h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  send: 'M4 12l16-8-6 16-2.5-6.5Z',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  swords: 'M5 19l6-6M3 21l2-2M19 5l-8 8M14 4l6 0 0 6M10 4 4 4l0 6',
  alert: 'M12 4 2.5 20h19ZM12 10v4M12 17h.01',
  unlink: 'M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5',
  x: 'M6 6l12 12M18 6 6 18',
} as const;
type IconName = keyof typeof ICONS;

function icon(name: IconName): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

type Variant = 'primary' | 'ghost' | 'danger' | 'success' | 'metoo' | '';

/** A button whose text content is exactly `label` (icons carry no text). */
function button(
  label: string,
  onClick: () => Promise<unknown>,
  opts: { icon?: IconName; variant?: Variant; extra?: string } = {},
): HTMLButtonElement {
  const b = el('button');
  b.type = 'button';
  b.className = ['btn', 'sm', opts.variant ?? '', opts.extra ?? ''].filter(Boolean).join(' ');
  if (opts.icon !== undefined) b.append(icon(opts.icon));
  b.append(el('span', label));
  b.addEventListener('click', () => void act(onClick, b));
  return b;
}

function initials(name: string): string {
  const letters = name.replace(/[^A-Za-z0-9]/g, '');
  return (letters.slice(0, 2) || '?').toUpperCase();
}

/** A stable hue per name, so each person keeps one avatar colour on every device. */
function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function avatar(name: string, small = false): HTMLSpanElement {
  const a = el('span', initials(name), small ? 'avatar sm' : 'avatar');
  a.style.setProperty('--hue', String(hue(name)));
  a.setAttribute('aria-hidden', 'true');
  return a;
}

// ---------------------------------------------------------------- status

type SyncState = 'ready' | 'syncing' | 'synced' | 'partial' | 'error';

function status(text: string, state: SyncState): void {
  $('status').textContent = text;
  $('sync-pill').dataset['state'] = state;
}

async function act(fn: () => Promise<unknown>, source?: HTMLButtonElement): Promise<void> {
  if (source !== undefined) source.disabled = true;
  try {
    await fn();
    await render();
  } catch (e) {
    status(`Error: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally {
    if (source !== undefined && source.isConnected) source.disabled = false;
  }
}

// ---------------------------------------------------------------- replica

const replica = await createReplica({
  storage: indexedDbStorage({ name: `ghostline-${device}` }),
  collections,
});
const session: Session = { replica, pending: localPending(device, localStorage), user: device };
const relay = httpTransport({
  baseUrl: location.origin,
  ...(token === undefined ? {} : { token }),
});

$('device').textContent = device;
$('device-avatar').replaceWith(avatar(device));
$('footer-device').textContent = `device ${device} · replica ${replica.id.slice(0, 8)}`;
document.title = `GHOSTLINE · ${device}`;

// ---------------------------------------------------------------- inline editors

/** At most one inline editor is open; its text survives re-renders caused by sync events. */
let editing: { kind: 'body' | 'tag'; id: string; text: string } | null = null;

function inlineEditor(
  kind: 'body' | 'tag',
  id: string,
  placeholder: string,
  saveLabel: string,
  save: (text: string) => Promise<unknown>,
): HTMLFormElement {
  const form = el('form', undefined, 'inline-editor');
  const input = kind === 'body' ? el('textarea') : el('input');
  if (input instanceof HTMLInputElement) input.type = 'text';
  input.placeholder = placeholder;
  input.setAttribute('aria-label', placeholder);
  input.value = editing?.text ?? '';
  input.addEventListener('input', () => {
    if (editing !== null) editing.text = input.value;
  });
  (input as HTMLElement).addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      editing = null;
      void render();
    }
  });
  const submit = el('button');
  submit.type = 'submit';
  submit.className = 'btn sm primary';
  submit.append(icon('check'), el('span', saveLabel));
  const cancel = button(
    'Cancel',
    async () => {
      editing = null;
    },
    { variant: 'ghost', icon: 'x' },
  );
  form.append(input, submit, cancel);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value;
    void act(async () => {
      await save(text);
      editing = null;
    }, submit);
  });
  queueMicrotask(() => {
    if (editing?.kind === kind && editing.id === id) input.focus();
  });
  return form;
}

// ---------------------------------------------------------------- rendering

// Renders run one at a time: a change event and an action can both ask for one, and two
// overlapping renders would each clear and then fill the same lists.
let rendering: Promise<void> = Promise.resolve();
function render(): Promise<void> {
  rendering = rendering.then(draw, draw);
  return rendering;
}

function announcementCard(a: RecordView<Announcement>): HTMLLIElement {
  const li = el('li', undefined, 'card');
  li.dataset['id'] = a.id;
  const draft = a.value.status === 'draft';
  li.dataset['tone'] = draft ? 'draft' : 'published';

  const top = el('div', undefined, 'card-top');
  top.append(
    el('h3', a.value.title, 'card-title'),
    el('span', draft ? 'Draft' : 'Published', `pill ${draft ? 'draft' : 'published'}`),
  );
  li.append(top);

  const isEditing = editing?.kind === 'body' && editing.id === a.id;
  if (isEditing) {
    li.append(
      inlineEditor('body', a.id, 'New message', 'Save', (body) =>
        editAnnouncement(session, a.id, { body }),
      ),
    );
  } else {
    const body = a.value.body ?? '';
    li.append(el('p', body || 'No message.', body ? 'card-body' : 'card-body muted'));
  }

  const by = el('div', undefined, 'byline');
  by.append(avatar(a.value.author, true), el('span', `by ${a.value.author}`));
  li.append(by);

  const actions = el('div', undefined, 'actions');
  if (draft)
    actions.append(
      button('Publish', () => publishAnnouncement(session, a.id), {
        icon: 'send',
        variant: 'success',
      }),
    );
  if (!isEditing)
    actions.append(
      button(
        'Edit',
        async () => {
          editing = { kind: 'body', id: a.id, text: a.value.body ?? '' };
        },
        { icon: 'pencil' },
      ),
    );
  actions.append(
    button('Delete', () => deleteAnnouncement(session, a.id), {
      icon: 'trash',
      variant: 'danger',
      extra: 'push',
    }),
  );
  li.append(actions);
  return li;
}

function requestCard(r: RecordView<HelpRequest>): HTMLLIElement {
  const li = el('li', undefined, 'card');
  li.dataset['id'] = r.id;
  const open = r.value.state === 'open';
  const claimedBy = r.value.claimedBy;
  const tone = !open ? 'done' : claimedBy ? 'claimed' : 'open';
  li.dataset['tone'] = tone;

  const top = el('div', undefined, 'card-top');
  top.append(
    el('h3', r.value.title, 'card-title'),
    el('span', !open ? 'Fulfilled' : claimedBy ? 'Claimed' : 'Open', `pill ${tone}`),
  );
  li.append(top);
  if (r.value.details) li.append(el('p', r.value.details, 'card-body'));

  const tagList = r.value.tags ?? [];
  if (tagList.length > 0) {
    const tags = el('div', undefined, 'tags');
    for (const t of tagList) tags.append(el('span', t, 'tag'));
    li.append(tags);
  }

  const by = el('div', undefined, 'byline');
  if (claimedBy) by.append(avatar(claimedBy, true));
  by.append(
    el(
      'span',
      claimedBy
        ? `claimed by ${claimedBy}${claimedBy === device ? ' (you)' : ''}`
        : open
          ? 'not claimed yet'
          : 'fulfilled',
      'meta',
    ),
  );
  const count = meTooCount(r);
  if (!open && count > 0)
    by.append(el('span', `· ${count} ${count === 1 ? 'person' : 'people'} needed this`));
  li.append(by);

  if (editing?.kind === 'tag' && editing.id === r.id) {
    li.append(
      inlineEditor('tag', r.id, 'New tag', 'Add', async (text) => {
        const tag = text.trim();
        if (tag) await tagRequest(session, r.id, [tag]);
      }),
    );
  }

  if (open) {
    const actions = el('div', undefined, 'actions');
    if (claimedBy !== device)
      actions.append(
        button('Claim', () => claimRequest(session, r.id), { icon: 'hand', variant: 'primary' }),
      );
    else {
      const mine = el('span', undefined, 'mine');
      mine.append(icon('user'), el('span', "You're on it"));
      actions.append(mine);
    }
    actions.append(
      button(`Me too (${count})`, () => meToo(session, r.id), {
        icon: 'plusOne',
        variant: 'metoo',
      }),
    );
    if (!(editing?.kind === 'tag' && editing.id === r.id))
      actions.append(
        button(
          'Add tag',
          async () => {
            editing = { kind: 'tag', id: r.id, text: '' };
          },
          { icon: 'tag', variant: 'ghost' },
        ),
      );
    actions.append(
      button('Fulfil', () => fulfilRequest(session, r.id), {
        icon: 'check',
        variant: 'success',
        extra: 'push',
      }),
    );
    li.append(actions);
  }
  return li;
}

const NOTICE_ICON: Record<Notice['kind'], IconName> = {
  'claim-lost': 'user',
  'claim-conflict': 'swords',
  'edit-not-applied': 'unlink',
  'delete-conflict': 'alert',
};

function noticeItem(n: Notice, titles: Map<string, string>): HTMLLIElement {
  const li = el('li', undefined, n.open ? 'notice open' : 'notice');
  li.dataset['kind'] = n.kind;
  const ic = el('span', undefined, 'n-icon');
  ic.append(icon(NOTICE_ICON[n.kind]));
  const text = el('div', undefined, 'n-text');
  const title = titles.get(n.recordId);
  const what = n.collection === 'requests' ? 'Request' : 'Announcement';
  text.append(
    el('div', n.message, 'n-msg'),
    el('div', title === undefined ? `${what} (since deleted)` : `${what}: ${title}`, 'n-ref'),
  );
  li.append(ic, text, el('span', n.open ? 'Open' : 'Resolved', 'n-state'));
  return li;
}

async function draw(): Promise<void> {
  const anns = await listAnnouncements(session);
  const reqs = await listRequests(session);
  const notes = await notices(session);

  const annList = $('announcements');
  annList.replaceChildren(...anns.map(announcementCard));
  $('ann-empty').hidden = anns.length > 0;
  $('ann-count').textContent = String(anns.length);

  const reqList = $('requests');
  reqList.replaceChildren(...reqs.map(requestCard));
  $('req-empty').hidden = reqs.length > 0;
  $('req-count').textContent = String(reqs.length);

  const titles = new Map<string, string>();
  for (const a of anns) titles.set(a.id, a.value.title);
  for (const r of reqs) titles.set(r.id, r.value.title);
  const noticeList = $('notices');
  noticeList.replaceChildren(...notes.map((n) => noticeItem(n, titles)));
  $('notice-empty').hidden = notes.length > 0;
  $('notice-count').textContent = String(notes.length);

  $('stat-open').textContent = String(reqs.filter((r) => r.value.state === 'open').length);
  $('stat-pub').textContent = String(anns.filter((a) => a.value.status === 'published').length);
  $('stat-notices').textContent = String(notes.filter((n) => n.open).length);
}

// ---------------------------------------------------------------- composer forms

function wireForm(
  formId: string,
  errorId: string,
  noteId: string,
  write: (data: FormData) => Promise<unknown>,
): void {
  const form = $<HTMLFormElement>(formId);
  const title = form.elements.namedItem('title') as HTMLInputElement;
  const error = $(errorId);
  const note = $(noteId);
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  title.addEventListener('input', () => {
    if (title.value.trim()) {
      title.removeAttribute('aria-invalid');
      error.textContent = '';
    }
  });
  let busy = false;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    // One submission at a time: the form's intent (and so its mutationId) is reused until the
    // write is recorded.
    if (busy) return;
    if (!title.value.trim()) {
      title.setAttribute('aria-invalid', 'true');
      error.textContent = 'Please add a title first.';
      title.focus();
      return;
    }
    const data = new FormData(form);
    busy = true;
    void act(async () => {
      try {
        await write(data);
      } finally {
        busy = false;
      }
      // Clear only what was submitted, so text typed while saving is kept.
      for (const field of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input, textarea',
      ))
        if (field.value === String(data.get(field.name) ?? '')) field.value = '';
      note.textContent = 'Saved on this device.';
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => (note.textContent = ''), 3500);
    }, submit ?? undefined);
  });
}

const annIntent = formIntent(device, localStorage, 'announcement');
const reqIntent = formIntent(device, localStorage, 'request');

wireForm('ann-form', 'ann-title-err', 'ann-note', async (data) => {
  // One intent per submission, kept in localStorage until the write is recorded (survives reloads).
  const intent = annIntent.get();
  await draftAnnouncement(
    session,
    intent,
    String(data.get('title')).trim(),
    String(data.get('body') ?? ''),
  );
  annIntent.done();
});

wireForm('req-form', 'req-title-err', 'req-note', async (data) => {
  const intent = reqIntent.get();
  const tags = String(data.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  await createRequest(
    session,
    intent,
    String(data.get('title')).trim(),
    String(data.get('details') ?? ''),
    tags,
  );
  reqIntent.done();
});

// ---------------------------------------------------------------- sync and network

const syncButton = $<HTMLButtonElement>('sync');
syncButton.addEventListener(
  'click',
  () =>
    void act(async () => {
      syncButton.setAttribute('aria-busy', 'true');
      status('Syncing...', 'syncing');
      try {
        const r = await replica.sync(relay);
        if (r.status === 'complete') {
          status('Synced.', 'synced');
          $('sync-pill').title = `Last synced at ${new Date().toLocaleTimeString()}`;
        } else {
          status(
            `Sync ${r.status}${'code' in r ? `: ${String(r.code)}` : ''}`,
            r.status === 'partial' ? 'partial' : 'error',
          );
        }
      } finally {
        syncButton.removeAttribute('aria-busy');
      }
    }, syncButton),
);

function showNetwork(): void {
  const online = navigator.onLine;
  $('net').dataset['online'] = String(online);
  $('net-text').textContent = online ? 'Network' : 'No network';
  $('net').title = online
    ? 'This browser reports a network connection'
    : 'No network: keep working, changes are saved on this device';
}
addEventListener('online', showNetwork);
addEventListener('offline', showNetwork);
showNetwork();

replica.subscribe(() => void render());
await render();
status('Offline-ready. Press Sync to exchange changes.', 'ready');
