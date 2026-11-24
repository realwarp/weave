/**
 * An in-memory ordered key-value map: a `Map` plus a sorted key array, so prefix scans are
 * O(log n + k). Shared by the memory adapter and the file adapter. Keys are ASCII, so the
 * JavaScript string order equals byte order.
 */
export class SortedStore {
  private readonly values = new Map<string, string>();
  private readonly sortedKeys: string[] = [];

  get size(): number {
    return this.values.size;
  }

  get(key: string): string | undefined {
    return this.values.get(key);
  }

  has(key: string): boolean {
    return this.values.has(key);
  }

  set(key: string, value: string): void {
    if (!this.values.has(key)) this.sortedKeys.splice(this.lowerBound(key), 0, key);
    this.values.set(key, value);
  }

  delete(key: string): void {
    if (!this.values.has(key)) return;
    this.values.delete(key);
    const i = this.lowerBound(key);
    if (this.sortedKeys[i] === key) this.sortedKeys.splice(i, 1);
  }

  /** Applies a write set (`null` deletes). */
  apply(writes: ReadonlyMap<string, string | null>): void {
    for (const [key, value] of writes) {
      if (value === null) this.delete(key);
      else this.set(key, value);
    }
  }

  /** Keys with `prefix`, strictly greater than `after`, ascending. */
  keysFrom(prefix: string, after?: string): string[] {
    const startKey = after !== undefined && after >= prefix ? after : prefix;
    let i = this.lowerBound(startKey);
    if (after !== undefined && this.sortedKeys[i] === after) i++;
    const out: string[] = [];
    for (; i < this.sortedKeys.length; i++) {
      const key = this.sortedKeys[i]!;
      if (!key.startsWith(prefix)) break;
      out.push(key);
    }
    return out;
  }

  entries(): Array<[string, string]> {
    return this.sortedKeys.map((k) => [k, this.values.get(k)!]);
  }

  clear(): void {
    this.values.clear();
    this.sortedKeys.length = 0;
  }

  private lowerBound(key: string): number {
    let lo = 0;
    let hi = this.sortedKeys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.sortedKeys[mid]! < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
