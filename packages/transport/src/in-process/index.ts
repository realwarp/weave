/**
 * In-process transport (design 8.1): calls an endpoint in the same process. Requests and responses
 * are JSON round-tripped, so the two sides never share object references, exactly like a network.
 */
import type { SyncEndpoint } from '@weave/core/protocol';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function inProcessTransport(endpoint: SyncEndpoint): SyncEndpoint {
  return {
    pull: async (request) => copy(await endpoint.pull(copy(request))),
    push: async (request) => copy(await endpoint.push(copy(request))),
    ack: async (request) => {
      await endpoint.ack(copy(request));
    },
  };
}
