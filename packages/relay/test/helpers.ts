import { createMemoryBacking, memoryStorage, type MemoryBacking } from '@weave/storage/memory';
import { seededRandom } from '../../testing/src/faults/random.js';
import { RelayCore, type RelayCoreOptions } from '../src/core/index.js';

export const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
export const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbb';
export const C = 'cccccccccccccccccccccccccc';

/** Opens a relay over an in-memory backing; reopening the same backing simulates a restart. */
export async function openRelay(
  backing: MemoryBacking = createMemoryBacking(),
  options: Omit<RelayCoreOptions, 'storage'> = {},
): Promise<{ core: RelayCore; backing: MemoryBacking }> {
  const core = new RelayCore({
    storage: memoryStorage({ backing }),
    random: seededRandom('relay'),
    ...options,
  });
  await core.open();
  return { core, backing };
}
