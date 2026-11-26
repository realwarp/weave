/**
 * GHOSTLINE browser UI (design 13.1). `?device=<name>` chooses the IndexedDB database and so the
 * replica. Every button is one user intent with a stable mutationId stored in localStorage before
 * the write (see pending.ts). All user text is rendered with textContent.
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
const ICON = {
  hand: 'M7 11V7a2 2 0 1 1 4 0v3M11 10V5.5a2 2 0 1 1 4 0V10M15 10V7a2 2 0 1 1 4 0v6a7 7 0 0 1-7 7h-1a7 7 0 0 1-6-3.4l-2.2-3.8a2 2 0 0 1 3.4-2L7 13',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  two: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 20a6.5 6.5 0 0 0-3-5.5',
  pencil: 'M4 20h4L19 9l-4-4L4 16v4Z',
  alert: 'M12 4 2.5 20h19ZM12 10v4M12 17h.01',
} as const;
function icon(name: keyof typeof ICON): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', ICON[name]);
  svg.append(path);
  return svg;
}

type Style = 'go' | 'outline' | 'plain' | 'muted' | 'metoo';
const STYLE: Record<Style, string> = {
  go: 'gl-btn go',
  outline: 'gl-btn',
  plain: 'gl-btn plain',
  muted: 'gl-btn muted',
  metoo: 'gl-btn metoo',
};

/** A button whose text content is exactly `label`. */
function button(
  label: string,
  onClick: () => Promise<unknown>,
  style: Style = 'outline',
): HTMLButtonElement {
  const b = el('button', label, STYLE[style]);
  b.type = 'button';
  b.addEventListener('click', () => void act(onClick, b));
  return b;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const initials = (name: string) =>
  (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();

// ---------------------------------------------------------------- status

type SyncState = 'ready' | 'syncing' | 'synced' | 'partial' | 'offline' | 'error';

/** Plain words for neighbours; the technical detail stays one click away for debugging. */
const MESSAGES = {
  ready: 'Ready. Your changes are saved on this device.',
  offline: "You're offline. Changes are saved on this device.",
  backOnline: 'Back online. Press Sync to share your changes.',
  syncing: 'Sharing your changes...',
  synced: 'Up to date.',
  unshared: 'New changes saved here. Press Sync to share them.',
  failed: "Couldn't sync. Your changes are still saved here. Try again.",
  schemaOlder: 'Partly shared. Some changes need a newer version of the app.',
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
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = 'Details';
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
  storage: indexedDbStorage({ name: `ghostline-${device}` }),
  collections,
});
const session: Session = { replica, pending: localPending(device, localStorage), user: device };
const relay = httpTransport({
  baseUrl: location.origin,
  ...(token === undefined ? {} : { token }),
});

$('device').textContent = device;
$('footer-device').textContent = `${device} · replica ${replica.id.slice(0, 8)}`;
document.title = `Ghostline · ${device}`;

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
  const form = el('form', undefined, 'gl-inline');
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
  const submit = el('button', saveLabel, STYLE.go);
  submit.type = 'submit';
  const cancel = button(
    'Cancel',
    async () => {
      editing = null;
    },
    'muted',
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

type ReqState = 'open' | 'claimed' | 'mine' | 'done';
function requestState(r: RecordView<HelpRequest>): ReqState {
  if (r.value.state !== 'open') return 'done';
  if (!r.value.claimedBy) return 'open';
  return r.value.claimedBy === device ? 'mine' : 'claimed';
}
const ORDER: Record<ReqState, number> = { open: 0, mine: 1, claimed: 2, done: 3 };

function requestItem(r: RecordView<HelpRequest>): HTMLLIElement {
  const state = requestState(r);
  const claimedBy = r.value.claimedBy;
  const count = meTooCount(r);
  const li = el('li', undefined, 'gl-req');
  li.dataset['id'] = r.id;
  li.dataset['state'] = state;

  // Who has it: an empty seat while nobody does, the volunteer's initials once someone does.
  const who = el('span', undefined, 'gl-who');
  who.setAttribute('aria-hidden', 'true');
  if (state === 'done') who.append(icon('check'));
  else if (claimedBy) who.textContent = initials(claimedBy);
  else who.append(icon('hand'));
  li.append(who);

  const body = el('div', undefined, 'body');
  body.append(el('h3', r.value.title));
  if (r.value.details) body.append(el('p', r.value.details, 'details'));
  const tagList = r.value.tags ?? [];
  if (tagList.length > 0) {
    const tags = el('div', undefined, 'gl-tags');
    for (const t of tagList) tags.append(el('span', t, 'tag'));
    body.append(tags);
  }
  const owner = el('div', undefined, 'gl-owner');
  owner.append(
    el(
      'span',
      claimedBy
        ? `${state === 'done' ? 'done · ' : ''}claimed by ${claimedBy}${state === 'mine' ? ' (you)' : ''}`
        : state === 'open'
          ? 'needs a volunteer'
          : 'done',
      'meta',
    ),
  );
  if (count > 0)
    owner.append(
      el(
        'span',
        `${plural(count, 'neighbour', 'neighbours')} ${state === 'done' ? 'needed' : 'need'} this too`,
        'gl-voices',
      ),
    );
  body.append(owner);
  li.append(body);

  if (state !== 'done') {
    const acts = el('div', undefined, 'acts');
    // One obvious next step: take it on, or, once it is yours, mark it done.
    if (state === 'mine') acts.append(button('Fulfil', () => fulfilRequest(session, r.id), 'go'));
    else
      acts.append(
        button('Claim', () => claimRequest(session, r.id), state === 'open' ? 'go' : 'outline'),
      );
    const metoo = button(`Me too (${count})`, () => meToo(session, r.id), 'metoo');
    metoo.title = 'I need this too';
    acts.append(metoo);
    li.append(acts);

    if (editing?.kind === 'tag' && editing.id === r.id) {
      li.append(
        inlineEditor('tag', r.id, 'New tag', 'Add', async (text) => {
          const tag = text.trim();
          if (tag) await tagRequest(session, r.id, [tag]);
        }),
      );
    } else {
      const more = el('div', undefined, 'more');
      more.append(
        button(
          'Add tag',
          async () => {
            editing = { kind: 'tag', id: r.id, text: '' };
          },
          'plain',
        ),
      );
      if (state !== 'mine')
        more.append(button('Fulfil', () => fulfilRequest(session, r.id), 'muted'));
      li.append(more);
    }
  }
  return li;
}

function announcementItem(a: RecordView<Announcement>): HTMLLIElement {
  const draft = a.value.status === 'draft';
  const li = el('li', undefined, 'gl-ann');
  li.dataset['id'] = a.id;
  li.dataset['draft'] = String(draft);
  li.append(el('span', draft ? 'Draft · not published yet' : 'Announcement', 'kind'));
  li.append(el('h3', a.value.title));
  const isEditing = editing?.kind === 'body' && editing.id === a.id;
  if (isEditing) {
    li.append(
      inlineEditor('body', a.id, 'New message', 'Save', (body) =>
        editAnnouncement(session, a.id, { body }),
      ),
    );
  } else {
    const text = a.value.body ?? '';
    li.append(el('p', text || 'No message.', text ? 'text' : 'text none'));
  }
  li.append(el('p', `${draft ? 'Drafted' : 'Posted'} by ${a.value.author}`, 'by'));
  const row = el('div', undefined, 'row');
  if (draft) row.append(button('Publish', () => publishAnnouncement(session, a.id), 'go'));
  if (!isEditing)
    row.append(
      button(
        'Edit',
        async () => {
          editing = { kind: 'body', id: a.id, text: a.value.body ?? '' };
        },
        'plain',
      ),
    );
  row.append(button('Delete', () => deleteAnnouncement(session, a.id), 'muted'));
  li.append(row);
  return li;
}

const NOTICE_ICON: Record<Notice['kind'], keyof typeof ICON> = {
  'claim-lost': 'user',
  'claim-conflict': 'two',
  'edit-not-applied': 'pencil',
  'delete-conflict': 'alert',
};

function noticeItem(n: Notice, titles: Map<string, string>): HTMLLIElement {
  const li = el('li', undefined, n.open ? 'gl-note open' : 'gl-note');
  li.dataset['kind'] = n.kind;
  const ic = el('span', undefined, 'ic');
  ic.append(icon(NOTICE_ICON[n.kind]));
  const title = titles.get(n.recordId);
  const what = n.collection === 'requests' ? 'Request' : 'Announcement';
  li.append(
    ic,
    el('p', n.message, 'msg'),
    el('p', title === undefined ? `${what}, since deleted` : `${what}: ${title}`, 'ref'),
    el('p', n.open ? 'Still open' : 'Settled', 'st'),
  );
  return li;
}

async function draw(): Promise<void> {
  const anns = await listAnnouncements(session);
  const reqs = await listRequests(session);
  const notes = await notices(session);

  const ordered = [...reqs].sort((a, b) => ORDER[requestState(a)] - ORDER[requestState(b)]);
  $('requests').replaceChildren(...ordered.map(requestItem));
  $('req-empty').hidden = reqs.length > 0;
  const openCount = reqs.filter((r) => r.value.state === 'open').length;
  $('req-summary').textContent = reqs.length
    ? `${openCount} open · ${reqs.length - openCount} done`
    : '';

  // Drafts first: they are the ones still waiting for someone.
  const annOrdered = [...anns].sort(
    (a, b) => Number(b.value.status === 'draft') - Number(a.value.status === 'draft'),
  );
  $('announcements').replaceChildren(...annOrdered.map(announcementItem));
  $('ann-empty').hidden = anns.length > 0;
  const drafts = anns.filter((a) => a.value.status === 'draft').length;
  $('ann-summary').textContent = anns.length
    ? `${anns.length - drafts} posted${drafts ? ` · ${plural(drafts, 'draft', 'drafts')}` : ''}`
    : '';

  const titles = new Map<string, string>();
  for (const a of anns) titles.set(a.id, a.value.title);
  for (const r of reqs) titles.set(r.id, r.value.title);
  const openNotes = notes.filter((n) => n.open);
  $('notices').replaceChildren(...notes.map((n) => noticeItem(n, titles)));
  $('notice-empty').hidden = notes.length > 0;
  $('notice-summary').textContent = openNotes.length ? `${openNotes.length} open` : '';
  const attention = $('attention');
  attention.hidden = openNotes.length === 0;
  if (openNotes[0] !== undefined)
    $('attention-text').replaceChildren(
      el(
        'b',
        openNotes.length === 1 ? '1 thing to look at: ' : `${openNotes.length} things to look at: `,
      ),
      openNotes[0].message,
    );

  await showQueue();
}

/** How many accepted changes the relay has not acknowledged yet (real data from status()). */
async function showQueue(): Promise<void> {
  const peers = Object.values((await replica.status()).peers);
  const queue = $('queue');
  if (peers.length === 0) {
    queue.textContent = 'Not shared with anyone yet';
    return;
  }
  const waiting = Math.max(...peers.map((p) => p.pendingOps));
  queue.textContent =
    waiting === 0
      ? 'Everything here has been shared'
      : `${plural(waiting, 'change', 'changes')} waiting to be shared`;
  // "Up to date" is only true until the next local change; say so once one is waiting.
  if (waiting > 0 && $('sync-state').dataset['state'] === 'synced')
    status(MESSAGES.unshared, 'ready');
}

// ---------------------------------------------------------------- composer

const tabs = [$<HTMLButtonElement>('tab-req'), $<HTMLButtonElement>('tab-ann')];
const panels = [$<HTMLFormElement>('req-form'), $<HTMLFormElement>('ann-form')];
function showTab(i: number, focus = false): void {
  tabs.forEach((t, j) => {
    t.setAttribute('aria-selected', String(i === j));
    t.tabIndex = i === j ? 0 : -1;
    panels[j]!.hidden = i !== j;
  });
  if (focus) tabs[i]!.focus();
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => showTab(i));
  t.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      showTab((i + 1) % tabs.length, true);
    }
  });
});

function wireForm(
  formId: string,
  errorId: string,
  sayId: string,
  savedText: string,
  write: (data: FormData) => Promise<unknown>,
): void {
  const form = $<HTMLFormElement>(formId);
  const title = form.elements.namedItem('title') as HTMLInputElement;
  const error = $(errorId);
  const say = $(sayId);
  const idleText = say.textContent ?? '';
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  let sayTimer: ReturnType<typeof setTimeout> | undefined;
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
      error.textContent = 'Please write a few words first.';
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
      say.textContent = savedText;
      say.classList.add('done');
      clearTimeout(sayTimer);
      sayTimer = setTimeout(() => {
        say.textContent = idleText;
        say.classList.remove('done');
      }, 4000);
    }, submit ?? undefined);
  });
}

const annIntent = formIntent(device, localStorage, 'announcement');
const reqIntent = formIntent(device, localStorage, 'request');

wireForm(
  'ann-form',
  'ann-title-err',
  'ann-say',
  'Draft saved. Publish it from the announcements list.',
  async (data) => {
    // One intent per submission, kept in localStorage until the write is recorded (survives reloads).
    const intent = annIntent.get();
    await draftAnnouncement(
      session,
      intent,
      String(data.get('title')).trim(),
      String(data.get('body') ?? ''),
    );
    annIntent.done();
  },
);

wireForm(
  'req-form',
  'req-title-err',
  'req-say',
  'Posted on this device. Sync to share it.',
  async (data) => {
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
  },
);

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
        const detail = `sync ${r.status}${'code' in r ? ` ${String(r.code)}` : ''}`;
        if (r.status === 'complete') {
          // `complete` means both sides were verified to hold the same changes (design 8.2).
          status(MESSAGES.synced, 'synced');
          $('sync-state').title = `Last synced at ${new Date().toLocaleTimeString()}`;
        } else if (r.status === 'partial') {
          status(
            r.code === 'PEER_SCHEMA_OLDER' ? MESSAGES.schemaOlder : MESSAGES.notSettled,
            'partial',
            detail,
          );
        } else {
          status(
            navigator.onLine ? MESSAGES.failed : MESSAGES.offline,
            navigator.onLine ? 'error' : 'offline',
            detail,
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
  const online = navigator.onLine;
  document.body.dataset['online'] = String(online);
  if (!online) status(MESSAGES.offline, 'offline');
  else if (event !== undefined && $('sync-state').dataset['state'] === 'offline')
    status(MESSAGES.backOnline, 'ready');
}
addEventListener('online', showNetwork);
addEventListener('offline', showNetwork);

replica.subscribe(() => void render());
await render();
status(MESSAGES.ready, 'ready');
showNetwork();
