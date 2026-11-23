import { createReplica } from '@weave/core';
import { memoryStorage } from '@weave/storage/memory';
import { x } from './local.js';
export const r = [createReplica, memoryStorage, x];
