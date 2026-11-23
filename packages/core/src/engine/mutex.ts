/** A FIFO async mutex: one critical section at a time, in arrival order. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
