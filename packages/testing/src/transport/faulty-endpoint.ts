/**
 * `FaultyEndpoint` (design 12.1): wraps a `SyncEndpoint` and injects seeded, reproducible faults:
 * dropped requests, dropped responses, duplicate delivery, reordered and truncated op lists, plus
 * hook points for scripted interleavings.
 */
import { WeaveError, type Random, type SyncEndpoint } from '@weave/core/protocol';
import { chance, seededRandom, shuffleWith } from '../faults/random.js';

export type EndpointMethod = 'pull' | 'push' | 'ack';

export interface FaultOptions {
  readonly seed?: number | string;
  /** The request is lost before it reaches the endpoint. */
  readonly dropRequestRate?: number;
  /** The endpoint handles the request, but the response is lost. */
  readonly dropResponseRate?: number;
  /** A push or ack is delivered twice. */
  readonly duplicateRate?: number;
  /** The op lines of a pull response or push request are shuffled. */
  readonly reorderRate?: number;
  /** The op list of a pull response is cut short (the response then says `more`). */
  readonly truncateRate?: number;
  readonly hooks?: {
    readonly beforeCall?: (method: EndpointMethod, request: unknown) => void | Promise<void>;
    readonly afterCall?: (
      method: EndpointMethod,
      request: unknown,
      response: unknown,
    ) => void | Promise<void>;
  };
}

function lost(method: EndpointMethod, phase: 'request' | 'response'): WeaveError {
  return new WeaveError('TRANSPORT_ERROR', `Simulated loss of the ${method} ${phase}`, {
    retryable: true,
    details: { simulated: true, method, phase },
  });
}

export class FaultyEndpoint implements SyncEndpoint {
  private readonly random: Random;
  readonly calls: Array<{ method: EndpointMethod; fault?: string }> = [];

  constructor(
    private readonly inner: SyncEndpoint,
    private readonly options: FaultOptions = {},
  ) {
    this.random = seededRandom(options.seed ?? 1);
  }

  private async around<Req, Res>(
    method: EndpointMethod,
    request: Req,
    call: (r: Req) => Promise<Res>,
    mutateRequest: (r: Req) => Req,
    mutateResponse: (r: Res) => Res,
  ): Promise<Res> {
    await this.options.hooks?.beforeCall?.(method, request);
    if (chance(this.random, this.options.dropRequestRate ?? 0)) {
      this.calls.push({ method, fault: 'drop-request' });
      throw lost(method, 'request');
    }
    const sent = mutateRequest(request);
    let response = await call(sent);
    if (method !== 'pull' && chance(this.random, this.options.duplicateRate ?? 0)) {
      this.calls.push({ method, fault: 'duplicate' });
      response = await call(sent);
    }
    if (chance(this.random, this.options.dropResponseRate ?? 0)) {
      this.calls.push({ method, fault: 'drop-response' });
      throw lost(method, 'response');
    }
    this.calls.push({ method });
    const out = mutateResponse(response);
    await this.options.hooks?.afterCall?.(method, request, out);
    return out;
  }

  private maybeShuffle(ops: readonly string[]): string[] {
    return chance(this.random, this.options.reorderRate ?? 0)
      ? shuffleWith(ops, this.random)
      : [...ops];
  }

  pull: SyncEndpoint['pull'] = (request) =>
    this.around(
      'pull',
      request,
      (r) => this.inner.pull(r),
      (r) => r,
      (res) => {
        let ops = this.maybeShuffle(res.ops);
        let more = res.more;
        if (ops.length > 1 && chance(this.random, this.options.truncateRate ?? 0)) {
          ops = ops.slice(0, Math.max(1, Math.floor(ops.length / 2)));
          more = true;
        }
        return { ...res, ops, more };
      },
    );

  push: SyncEndpoint['push'] = (request) =>
    this.around(
      'push',
      request,
      (r) => this.inner.push(r),
      (r) => ({ ...r, ops: this.maybeShuffle(r.ops) }),
      (res) => res,
    );

  ack: SyncEndpoint['ack'] = (request) =>
    this.around(
      'ack',
      request,
      (r) => this.inner.ack(r),
      (r) => r,
      (res) => res,
    );
}
