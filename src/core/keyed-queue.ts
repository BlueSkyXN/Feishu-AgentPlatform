interface QueueState {
  tail: Promise<unknown>;
  pending: number;
}

export class QueueFullError extends Error {
  constructor(
    readonly key: string,
    readonly limit: number,
  ) {
    super(`Queue "${key}" reached its pending-turn limit (${limit}).`);
    this.name = 'QueueFullError';
  }
}

export class KeyedQueue {
  private readonly states = new Map<string, QueueState>();

  constructor(private readonly maxPendingPerKey = 8) {
    if (!Number.isInteger(maxPendingPerKey) || maxPendingPerKey < 1) {
      throw new Error('maxPendingPerKey must be a positive integer.');
    }
  }

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const state = this.states.get(key) ?? {
      tail: Promise.resolve(),
      pending: 0,
    };
    if (state.pending >= this.maxPendingPerKey) {
      throw new QueueFullError(key, this.maxPendingPerKey);
    }

    state.pending += 1;
    const result = state.tail.catch(() => undefined).then(task);
    state.tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.states.set(key, state);

    const cleanup = (): void => {
      state.pending -= 1;
      if (state.pending === 0 && this.states.get(key) === state) {
        this.states.delete(key);
      }
    };
    void result.then(cleanup, cleanup);

    return result;
  }

  pending(key: string): number {
    return this.states.get(key)?.pending ?? 0;
  }

  activeKeys(): number {
    return this.states.size;
  }

  async onIdle(): Promise<void> {
    while (this.states.size > 0) {
      await Promise.all([...this.states.values()].map((state) => state.tail));
      // The pending counters are cleaned in promise callbacks. Yield once so
      // those callbacks can remove empty queue states before checking again.
      await Promise.resolve();
    }
  }
}
