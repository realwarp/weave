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

type Style = 'primary' | 'outline' | 'quiet' | 'subtle' | 'danger';
const STYLE_CLASS: Record<Style, string> = {
  primary: 'btn primary',
  outline: 'btn',
  quiet: 'btn quiet',
  subtle: 'btn quiet subtle',
  danger: 'btn quiet danger',
};

/** A button whose text content is exactly `label`. */
function button(
  label: string,
  onClick: () => Promise<unknown>,
  style: Style = 'outline',
): HTMLButtonElement {
  const b = el('button', label, STYLE_CLASS[style]);
  b.type = 'button';
  b.addEventListener('click', () => void act(onClick, b));
  return b;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- status

type SyncState = 'ready' | 'syncing' | 'synced' | 'partial' | 'error';

function status(text: string, state: SyncState): void {
  $('status').textContent = text;
  $('sync-state').dataset['state'] = state;
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
// Wall-clock date for display only.
$('today').textContent = new Date().toLocaleDateString(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});
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
  const form = el('form', undefined, 'inline');
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
  const submit = el('button', saveLabel, 'btn primary');
  submit.type = 'submit';
  const cancel = button(
    'Cancel',
    async () => {
      editing = null;
    },
    'subtle',
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

type ReqState = 'open' | 'claimed' | 'done';
function requestState(r: RecordView<HelpRequest>): ReqState {
  if (r.value.state !== 'open') return 'done';
  return r.value.claimedBy ? 'claimed' : 'open';
}
const STATE_LABEL: Record<ReqState, string> = {
  open: 'Open',
  claimed: 'Claimed',
  done: 'Fulfilled',
};
const STATE_ORDER: Record<ReqState, number> = { open: 0, claimed: 1, done: 2 };

function requestItem(r: RecordView<HelpRequest>): HTMLLIElement {
  const state = requestState(r);
  const claimedBy = r.value.claimedBy;
  const mine = claimedBy === device;
  const count = meTooCount(r);
  const li = el('li', undefined, 'request');
  li.dataset['id'] = r.id;
  li.dataset['state'] = state;

  li.append(el('span', STATE_LABEL[state], 'state'));

  const body = el('div', undefined, 'body');
  body.append(el('h3', r.value.title));
  if (r.value.details) body.append(el('p', r.value.details, 'details'));
  const tagList = r.value.tags ?? [];
  if (tagList.length > 0) {
    const tags = el('div', undefined, 'tags');
    for (const t of tagList) tags.append(el('span', t, 'tag'));
    body.append(tags);
  }
  body.append(
    el(
      'span',
      claimedBy
        ? `claimed by ${claimedBy}${mine ? ' (you)' : ''}`
        : state === 'open'
          ? 'not claimed yet: could you help?'
          : 'fulfilled',
      'meta',
    ),
  );
  if (state === 'done' && count > 0)
    body.append(el('p', `${plural(count, 'neighbour', 'neighbours')} needed this too.`, 'needed'));
  li.append(body);

  if (state !== 'done') {
    const side = el('div', undefined, 'side-actions');
    // The one obvious next step: take it on, or, once it is yours, mark it done.
    // Claiming something a neighbour already took on stays possible, but is not the suggestion.
    if (mine) side.append(button('Fulfil', () => fulfilRequest(session, r.id), 'primary'));
    else
      side.append(
        button('Claim', () => claimRequest(session, r.id), claimedBy ? 'outline' : 'primary'),
      );
    const metoo = button(`Me too (${count})`, () => meToo(session, r.id), 'outline');
    metoo.classList.add('metoo');
    metoo.title = 'I need this too';
    side.append(metoo);
    li.append(side);

    const more = el('div', undefined, 'more');
    const tagging = editing?.kind === 'tag' && editing.id === r.id;
    if (tagging) {
      more.append(
        inlineEditor('tag', r.id, 'New tag', 'Add', async (text) => {
          const tag = text.trim();
          if (tag) await tagRequest(session, r.id, [tag]);
        }),
      );
    } else {
      more.append(
        button(
          'Add tag',
          async () => {
            editing = { kind: 'tag', id: r.id, text: '' };
          },
          'quiet',
        ),
      );
      if (!mine) more.append(button('Fulfil', () => fulfilRequest(session, r.id), 'subtle'));
    }
    li.append(more);
  }
  return li;
}

function announcementItem(a: RecordView<Announcement>): HTMLLIElement {
  const draft = a.value.status === 'draft';
  const li = el('li', undefined, 'ann');
  li.dataset['id'] = a.id;
  li.dataset['draft'] = String(draft);
  li.append(el('span', draft ? 'Draft · not published yet' : 'Published', 'label'));
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
  li.append(el('p', `${draft ? 'Drafted' : 'Posted'} by ${a.value.author}`, 'byline'));

  const row = el('div', undefined, 'row');
  if (draft) row.append(button('Publish', () => publishAnnouncement(session, a.id), 'primary'));
  if (!isEditing)
    row.append(
      button(
        'Edit',
        async () => {
          editing = { kind: 'body', id: a.id, text: a.value.body ?? '' };
        },
        'quiet',
      ),
    );
  row.append(button('Delete', () => deleteAnnouncement(session, a.id), 'danger'));
  li.append(row);
  return li;
}

const NOTICE_KIND: Record<Notice['kind'], string> = {
  'claim-lost': 'Your claim',
  'claim-conflict': 'Two claims',
  'edit-not-applied': 'Your edit',
  'delete-conflict': 'Deleted while edited',
};

function noticeItem(n: Notice, titles: Map<string, string>): HTMLLIElement {
  const li = el('li', undefined, n.open ? 'notice open' : 'notice');
  li.dataset['kind'] = n.kind;
  li.append(el('span', `${NOTICE_KIND[n.kind]} · ${n.open ? 'needs a look' : 'settled'}`, 'what'));
  li.append(el('p', n.message, 'msg'));
  const ref = el('p', undefined, 'ref');
  const title = titles.get(n.recordId);
  const what = n.collection === 'requests' ? 'Request' : 'Announcement';
  if (title === undefined) ref.textContent = `${what}, since deleted`;
  else ref.append(`${what}: `, el('em', title));
  li.append(ref);
  return li;
}

async function draw(): Promise<void> {
  const anns = await listAnnouncements(session);
  const reqs = await listRequests(session);
  const notes = await notices(session);

  const ordered = [...reqs].sort(
    (a, b) => STATE_ORDER[requestState(a)] - STATE_ORDER[requestState(b)],
  );
  $('requests').replaceChildren(...ordered.map(requestItem));
  $('req-empty').hidden = reqs.length > 0;
  const openCount = reqs.filter((r) => r.value.state === 'open').length;
  const doneCount = reqs.length - openCount;
  $('req-summary').textContent =
    reqs.length === 0 ? '' : `${openCount} open${doneCount ? ` · ${doneCount} fulfilled` : ''}`;
  $('nav-req').textContent = String(openCount);

  // Drafts first: they are the ones that still need something from someone.
  const annOrdered = [...anns].sort(
    (a, b) => Number(b.value.status === 'draft') - Number(a.value.status === 'draft'),
  );
  $('announcements').replaceChildren(...annOrdered.map(announcementItem));
  $('ann-empty').hidden = anns.length > 0;
  const drafts = anns.filter((a) => a.value.status === 'draft').length;
  $('ann-summary').textContent =
    anns.length === 0
      ? ''
      : `${anns.length - drafts} published${drafts ? ` · ${plural(drafts, 'draft', 'drafts')}` : ''}`;
  $('nav-ann').textContent = String(anns.length);

  const titles = new Map<string, string>();
  for (const a of anns) titles.set(a.id, a.value.title);
  for (const r of reqs) titles.set(r.id, r.value.title);
  const openNotes = notes.filter((n) => n.open).length;
  $('notices').replaceChildren(...notes.map((n) => noticeItem(n, titles)));
  $('notice-empty').hidden = notes.length > 0;
  $('notice-summary').textContent = openNotes ? `${openNotes} to look at` : '';
  const navNotices = $('nav-notices');
  navNotices.textContent = String(openNotes);
  navNotices.classList.toggle('attention', openNotes > 0);
}

// ---------------------------------------------------------------- composer forms

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
  'Draft saved. Publish it below when it is ready.',
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
  'Saved on this device. Sync to share it.',
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

// The announcement form is folded away until someone wants to write one.
const annForm = $<HTMLFormElement>('ann-form');
const annToggle = $<HTMLButtonElement>('ann-toggle');
function showAnnForm(open: boolean): void {
  annForm.hidden = !open;
  annToggle.hidden = open;
  annToggle.setAttribute('aria-expanded', String(open));
  if (open) (annForm.elements.namedItem('title') as HTMLInputElement).focus();
  else annToggle.focus();
}
annToggle.addEventListener('click', () => showAnnForm(true));
$('ann-cancel').addEventListener('click', () => showAnnForm(false));

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
          $('sync-state').title = `Last synced at ${new Date().toLocaleTimeString()}`;
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
  document.body.dataset['online'] = String(navigator.onLine);
}
addEventListener('online', showNetwork);
addEventListener('offline', showNetwork);
showNetwork();

replica.subscribe(() => void render());
await render();
status('Offline-ready. Press Sync to exchange changes.', 'ready');
