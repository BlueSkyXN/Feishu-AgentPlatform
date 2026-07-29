import { Semaphore } from '../core/semaphore.js';

export interface WorkerStartLimiter {
  run<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export class ConcurrentWorkerStartLimiter implements WorkerStartLimiter {
  private readonly semaphore: Semaphore;

  constructor(readonly capacity: number) {
    this.semaphore = new Semaphore(capacity);
  }

  get inUse(): number {
    return this.semaphore.inUse;
  }

  get waiting(): number {
    return this.semaphore.waiting;
  }

  async run<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return await this.semaphore.run(start, signal);
  }
}

export const UNBOUNDED_WORKER_START_LIMITER: WorkerStartLimiter = {
  async run<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    return await start();
  },
};

export interface ResidentRuntimeIdentity {
  appKey: string;
  agentId: string;
  bindingId: string;
  conversationKey: string;
  storageId: string;
}

export interface ResidentRuntimeLease {
  activate(control: ResidentRuntimeControl): void;
  touch(): void;
  release(): void;
}

export interface ResidentRuntimeControl {
  isIdle(): boolean;
  lastUsedAt(): number;
  evict(): Promise<boolean>;
}

/**
 * Optional Host-wide resident-runtime boundary. A Host can share one
 * coordinator across binding registries; the registry still enforces its own
 * per-binding maxResidentSessions policy.
 */
export interface ResidentRuntimeCoordinator {
  acquire(
    identity: ResidentRuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<ResidentRuntimeLease>;
}

export const UNBOUNDED_RESIDENT_RUNTIME_COORDINATOR: ResidentRuntimeCoordinator = {
  async acquire(
    _identity: ResidentRuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<ResidentRuntimeLease> {
    throwIfAborted(signal);
    return { activate() {}, touch() {}, release() {} };
  },
};

export class GlobalResidentRuntimeCoordinator
  implements ResidentRuntimeCoordinator
{
  private readonly residents = new Map<number, {
    identity: ResidentRuntimeIdentity;
    control?: ResidentRuntimeControl;
    evicting: boolean;
  }>();
  private readonly waiters = new Set<() => void>();
  private nextLeaseId = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Resident runtime capacity must be a positive integer.');
    }
  }

  get residentCount(): number {
    return this.residents.size;
  }

  get waitingCount(): number {
    return this.waiters.size;
  }

  list(): ResidentRuntimeIdentity[] {
    return [...this.residents.values()].map(({ identity }) => ({ ...identity }));
  }

  async acquire(
    identity: ResidentRuntimeIdentity,
    signal?: AbortSignal,
  ): Promise<ResidentRuntimeLease> {
    while (true) {
      throwIfAborted(signal);
      if (this.residents.size < this.capacity) return this.createLease(identity);
      const candidate = this.lruIdleCandidate();
      if (candidate) {
        candidate.value.evicting = true;
        try {
          if (await candidate.value.control?.evict()) continue;
        } finally {
          const current = this.residents.get(candidate.id);
          if (current) current.evicting = false;
        }
      }
      await this.waitForChange(signal);
    }
  }

  private createLease(identity: ResidentRuntimeIdentity): ResidentRuntimeLease {
    const leaseId = this.nextLeaseId;
    this.nextLeaseId += 1;
    this.residents.set(leaseId, { identity: { ...identity }, evicting: false });
    let released = false;
    return {
      activate: (control): void => {
        if (released) return;
        const resident = this.residents.get(leaseId);
        if (!resident) return;
        resident.control = control;
        this.notifyChange();
      },
      touch: (): void => this.notifyChange(),
      release: (): void => {
        if (released) return;
        released = true;
        this.residents.delete(leaseId);
        this.notifyChange();
      },
    };
  }

  private lruIdleCandidate(): {
    id: number;
    value: {
      identity: ResidentRuntimeIdentity;
      control?: ResidentRuntimeControl;
      evicting: boolean;
    };
  } | undefined {
    let candidate: ReturnType<GlobalResidentRuntimeCoordinator['lruIdleCandidate']>;
    for (const [id, value] of this.residents) {
      if (value.evicting || !value.control?.isIdle()) continue;
      if (
        !candidate ||
        value.control.lastUsedAt() < (candidate.value.control?.lastUsedAt() ?? Infinity)
      ) {
        candidate = { id, value };
      }
    }
    return candidate;
  }

  private async waitForChange(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        cleanup();
        resolve();
      };
      const abort = (): void => {
        cleanup();
        const error = new Error('Runtime capacity acquisition aborted.');
        error.name = 'AbortError';
        reject(error);
      };
      const cleanup = (): void => {
        this.waiters.delete(wake);
        signal?.removeEventListener('abort', abort);
      };
      this.waiters.add(wake);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  private notifyChange(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error('Runtime capacity acquisition aborted.');
  error.name = 'AbortError';
  throw error;
}
