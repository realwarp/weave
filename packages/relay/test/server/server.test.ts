import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { memoryStorage } from '@weave/storage/memory';
import { encodePushRequest, httpTransport } from '@weave/transport/http';
import { makeOps, runTransportConformance } from '../../../testing/src/transport/index.js';
import { RelayCore } from '../../src/core/index.js';
import { startRelay } from '../../src/index.js';
import { createRelayServer, listen, type RelayServerOptions } from '../../src/server/index.js';
import { A, B } from '../helpers.js';

const TOKEN = 'tok-9f8e7d6c5b4a';
const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'weave-relay-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function serve(options: Omit<RelayServerOptions, 'core'> = {}) {
  const core = new RelayCore({ storage: memoryStorage() });
  await core.open();
  const running = await listen(createRelayServer({ core, ...options }), 0);
  return {
    core,
    url: running.url,
    close: async () => {
      await running.close();
      await core.close();
    },
  };
}

runTransportConformance('HTTP transport against the real relay', async () => {
  const relay = await serve({ token: TOKEN });
  return { endpoint: httpTransport({ baseUrl: relay.url, token: TOKEN }), close: relay.close };
});

runTransportConformance('HTTP transport against a file-backed relay', async () => {
  const relay = await startRelay({ dir: tempDir(), port: 0 });
  return { endpoint: httpTransport({ baseUrl: relay.url }), close: relay.close };
});

describe('relay HTTP server', () => {
  it('answers /v1/health without a token', async () => {
    const relay = await serve({ token: TOKEN });
    try {
      const res = await fetch(`${relay.url}/v1/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, endpointId: relay.core.endpointId });
    } finally {
      await relay.close();
    }
  });

  it('requires the bearer token on every data route', async () => {
    const relay = await serve({ token: TOKEN });
    try {
      for (const route of ['/v1/pull', '/v1/push', '/v1/ack']) {
        for (const auth of [undefined, 'Bearer wrong', `Bearer ${TOKEN}x`, TOKEN]) {
          const res = await fetch(`${relay.url}${route}`, {
            method: 'POST',
            headers: auth === undefined ? {} : { authorization: auth },
            body: '{}',
          });
          expect(res.status, `${route} ${auth}`).toBe(401);
        }
      }
      await expect(
        httpTransport({ baseUrl: relay.url, token: 'nope' }).pull({
          replicaId: A,
          vector: {},
          support: {},
          limit: 0,
        }),
      ).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', retryable: false });
    } finally {
      await relay.close();
    }
  });

  it('rejects bodies over the size limit with 413 and malformed bodies with 400', async () => {
    const relay = await serve({ maxBodyBytes: 1024 });
    try {
      const big = await fetch(`${relay.url}/v1/pull`, { method: 'POST', body: 'x'.repeat(5000) });
      expect(big.status).toBe(413);
      const bad = await fetch(`${relay.url}/v1/pull`, { method: 'POST', body: 'not json' });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${relay.url}/v1/nothing`, { method: 'POST', body: '{}' });
      expect(missing.status).toBe(404);
    } finally {
      await relay.close();
    }
  });

  it('enforces the op limits over HTTP and stores nothing', async () => {
    const core = new RelayCore({ storage: memoryStorage(), limits: { maxOpsPerPush: 2 } });
    await core.open();
    const running = await listen(createRelayServer({ core }), 0);
    try {
      const res = await fetch(`${running.url}/v1/push`, {
        method: 'POST',
        body: encodePushRequest({ replicaId: A, support: { notes: 1 }, ops: await makeOps(A, 3) }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await core.vector()).toEqual({});
    } finally {
      await running.close();
      await core.close();
    }
  });

  it('never writes the token or bodies to its log', async () => {
    const lines: string[] = [];
    const relay = await serve({ token: TOKEN, log: (l) => lines.push(l) });
    try {
      const t = httpTransport({ baseUrl: relay.url, token: TOKEN });
      const ops = await makeOps(A, 2, { fields: () => ({ secret: 'body-secret-value' }) });
      await t.push({ replicaId: A, support: { notes: 1 }, ops });
      await t.pull({ replicaId: B, vector: {}, support: { notes: 1 }, limit: 10 });
      await t.ack({ replicaId: B, durable: { [A]: 2 } });
      await fetch(`${relay.url}/v1/pull`, {
        method: 'POST',
        headers: { authorization: 'Bearer leaked-guess' },
      });
      expect(lines.length).toBeGreaterThanOrEqual(4);
      for (const line of lines) {
        expect(line).not.toContain(TOKEN);
        expect(line).not.toContain('leaked-guess');
        expect(line).not.toContain('body-secret-value');
        expect(line).toMatch(/^(GET|POST) \/v1\/\w+ \d{3} \d+ms$/);
      }
    } finally {
      await relay.close();
    }
  });
});

describe('weave-relay CLI', () => {
  const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

  it('starts with --data and --port, answers /v1/health and shuts down', async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [cli, '--data', dir, '--port', '0'], {
      env: { ...process.env, WEAVE_RELAY_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (c: string) => {
          out += c;
          const m = /listening on (http:\/\/\S+)/.exec(out);
          if (m) resolve(m[1]!);
        });
        child.once('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
      });
      const res = await fetch(`${url}/v1/health`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
      const denied = await fetch(`${url}/v1/pull`, { method: 'POST', body: '{}' });
      expect(denied.status).toBe(401);
    } finally {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
  });
});
