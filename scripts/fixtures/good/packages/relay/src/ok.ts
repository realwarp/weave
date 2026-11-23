import type { Op } from '@weave/core/protocol';
import { createFileStorage } from '@weave/storage/file';
export type T = Op;
export const s = createFileStorage;
