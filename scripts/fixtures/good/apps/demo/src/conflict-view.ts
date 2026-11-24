// A fixture app file that only reads the public ConflictRecord.frontier field: allowed.
import type { ConflictRecord } from '@weave/core';

export function competingValues(c: ConflictRecord): unknown[] {
  return c.frontier.map((e) => e.value);
}
