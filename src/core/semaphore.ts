export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Semaphore capacity must be a positive integer.');
    }
  }

  get inUse(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();
    if (this.active < this.capacity) {
      this.active += 1;
      return this.releaseFactory();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.abort = (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private releaseFactory(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        if (waiter.signal && waiter.abort) {
          waiter.signal.removeEventListener('abort', waiter.abort);
        }
        waiter.resolve(this.releaseFactory());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

function abortError(): Error {
  const error = new Error('Semaphore acquisition aborted.');
  error.name = 'AbortError';
  return error;
}
