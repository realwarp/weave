/**
 * In-process transport (design 8.1): calls an endpoint in the same process. Requests and responses
 * are JSON round-tripped, so the two sides never share object references, exactly like a network.
 */
import type { SyncEndpoint } from '@weave/core/protocol';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Creates an in-process transport that calls a SyncEndpoint in the same process.
 * Requests and responses are JSON round-tripped so the two sides never share object references.
 * @param endpoint - The SyncEndpoint to wrap for in-process use.
 * @returns A SyncEndpoint that delegates to the provided endpoint with JSON serialization.
 */
export function inProcessTransport(endpoint: SyncEndpoint): SyncEndpoint {
  return {
    /**
     * Pulls ops from the endpoint via JSON serialization.
     * @param request - The pull request to forward.
     * @returns The pull response from the endpoint.
     */
    pull: async (request) => copy(await endpoint.pull(copy(request))),
    /**
     * Pushes ops to the endpoint via JSON serialization.
     * @param request - The push request to forward.
     * @returns The push response from the endpoint.
     */
    push: async (request) => copy(await endpoint.push(copy(request))),
    /**
     * Acknowledges durable ops to the endpoint via JSON serialization.
     * @param request - The acknowledgment request to forward.
     */
    ack: async (request) => {
      await endpoint.ack(copy(request));
    },
    // [ADV] Snapshots pass through when the endpoint offers them (R4.8).
    ...(endpoint.snapshot === undefined
      ? {}
      : { snapshot: async () => copy(await endpoint.snapshot!()) }),
    ...(endpoint.putSnapshot === undefined
      ? {}
      : {
          putSnapshot: async (s: Parameters<NonNullable<SyncEndpoint['putSnapshot']>>[0]) =>
            endpoint.putSnapshot!(copy(s)),
        }),
  };
}
