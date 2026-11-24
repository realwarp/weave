/**
 * `@weave/relay`: the WEAVE relay server library (R4a).
 */
import { fileStorage } from '@weave/storage/file';
import { RelayCore, type RelayLimits } from './core/index.js';
import { createRelayServer, listen, type RunningRelay } from './server/index.js';

export {
  DEFAULT_LIMITS,
  RelayCore,
  type RelayCoreOptions,
  type RelayLimits,
} from './core/index.js';
export {
  createRelayServer,
  listen,
  type RelayServerOptions,
  type RunningRelay,
} from './server/index.js';

export interface StartRelayOptions {
  readonly dir: string;
  readonly port?: number;
  readonly host?: string;
  readonly token?: string;
  readonly limits?: Partial<RelayLimits>;
  readonly log?: (line: string) => void;
}

/** Opens a file-backed relay and starts its HTTP server. `close()` stops both. */
export async function startRelay(
  options: StartRelayOptions,
): Promise<RunningRelay & { core: RelayCore }> {
  const core = new RelayCore({
    storage: fileStorage({ dir: options.dir }),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  await core.open();
  const server = createRelayServer({
    core,
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const running = await listen(server, options.port ?? 8787, options.host ?? '127.0.0.1');
  return {
    ...running,
    core,
    close: async () => {
      await running.close();
      await core.close();
    },
  };
}
