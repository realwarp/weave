/**
 * GHOSTLINE browser UI (design 13.1). `?device=<name>` chooses the IndexedDB database and so the
 * replica. Every button is one user intent with a stable mutationId stored in localStorage before
 * the write (see pending.ts). All user text is rendered with textContent.
 */
import { createReplica } from '@weave/core';
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
  notices,
  publishAnnouncement,
  tagRequest,
  type Session,
} from './logic.js';
import { collections } from './model.js';
import { localPending } from './pending.js';

const params = new URLSearchParams(location.search);
const device =
  (params.get('device') ?? 'alice').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'alice';
const token = params.get('token') ?? undefined;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el as T;
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
  storage: indexedDbStorage({ name: `ghostline-${device}` }),
  collections,
});
const session: Session = { replica, pending: localPending(device, localStorage), user: device };
const relay = httpTransport({
  baseUrl: location.origin,
  ...(token === undefined ? {} : { token }),
});

$('device').textContent = device;
document.title = `GHOSTLINE - ${device}`;

// Renders run one at a time: a change event and an action can both ask for one, and two
// overlapping renders would each clear and then fill the same lists.
let rendering: Promise<void> = Promise.resolve();
function render(): Promise<void> {
  rendering = rendering.then(draw, draw);
  return rendering;
}

async function draw(): Promise<void> {
  const annList = $('announcements');
  annList.replaceChildren();
  for (const a of await listAnnouncements(session)) {
    const li = el('li');
    li.dataset['id'] = a.id;
    li.append(el('strong', a.value.title), el('div', a.value.body ?? ''));
    li.append(el('div', `${a.value.status} by ${a.value.author}`, 'meta'));
    if (a.value.status === 'draft')
      li.append(button('Publish', () => publishAnnouncement(session, a.id)));
    li.append(
      button('Edit', async () => {
        const body = prompt('New message', a.value.body ?? '');
        if (body !== null) await editAnnouncement(session, a.id, { body });
      }),
      button('Delete', () => deleteAnnouncement(session, a.id)),
    );
    annList.append(li);
  }

  const reqList = $('requests');
  reqList.replaceChildren();
  for (const r of await listRequests(session)) {
    const li = el('li');
    li.dataset['id'] = r.id;
    li.append(el('strong', r.value.title), el('div', r.value.details ?? ''));
    const tags = el('div');
    for (const t of r.value.tags ?? []) tags.append(el('span', t, 'tag'));
    li.append(tags);
    li.append(
      el(
        'div',
        `${r.value.state}${r.value.claimedBy ? `, claimed by ${r.value.claimedBy}` : ''}`,
        'meta',
      ),
    );
    if (r.value.state === 'open') {
      if (r.value.claimedBy !== device)
        li.append(button('Claim', () => claimRequest(session, r.id)));
      li.append(
        button('Add tag', async () => {
          const tag = prompt('Tag')?.trim();
          if (tag) await tagRequest(session, r.id, [tag]);
        }),
        button('Fulfil', () => fulfilRequest(session, r.id)),
      );
    }
    reqList.append(li);
  }

  const noticeList = $('notices');
  noticeList.replaceChildren();
  const list = await notices(session);
  if (list.length === 0) noticeList.append(el('li', 'No notices.', 'meta'));
  for (const n of list) noticeList.append(el('li', n.message, `notice ${n.open ? 'open' : ''}`));
}

$('ann-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  // One intent per submission; the key is kept on the form until the write is recorded.
  form.dataset['intent'] ??= crypto.randomUUID();
  const intent = form.dataset['intent'];
  void act(async () => {
    await draftAnnouncement(
      session,
      intent,
      String(data.get('title')),
      String(data.get('body') ?? ''),
    );
    delete form.dataset['intent'];
    form.reset();
  });
});

$('req-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const data = new FormData(form);
  form.dataset['intent'] ??= crypto.randomUUID();
  const intent = form.dataset['intent'];
  const tags = String(data.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  void act(async () => {
    await createRequest(
      session,
      intent,
      String(data.get('title')),
      String(data.get('details') ?? ''),
      tags,
    );
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
          : `Sync ${r.status}${'code' in r ? `: ${String(r.code)}` : ''}`,
      );
    }),
);

replica.subscribe(() => void render());
await render();
status('Offline-ready. Press Sync to exchange changes.');
