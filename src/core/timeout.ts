export class TimeoutError extends Error {
  constructor(readonly timeoutMs: number, message?: string) {
    super(message ?? `Operation timed out after ${timeoutMs} ms.`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>),
  timeoutMs: number,
  message?: string,
  parentSignal?: AbortSignal,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('timeoutMs must be a positive number.');
  }
  if (parentSignal?.aborted) throw abortError();

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort: ((error: Error) => void) | undefined;
  const relayAbort = (): void => {
    controller.abort(parentSignal?.reason);
    rejectAbort?.(abortError());
  };
  parentSignal?.addEventListener('abort', relayAbort, { once: true });

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(timeoutMs, message);
      controller.abort(error);
      reject(error);
      void Promise.resolve()
        .then(() => onTimeout?.())
        .catch(() => undefined);
    }, timeoutMs);
  });
  const aborted = parentSignal
    ? new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      })
    : undefined;

  try {
    let task: Promise<T>;
    try {
      task =
        typeof operation === 'function'
          ? Promise.resolve(operation(controller.signal))
          : operation;
    } catch (error) {
      task = Promise.reject(error);
    }
    return await Promise.race(aborted ? [task, timeout, aborted] : [task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener('abort', relayAbort);
    rejectAbort = undefined;
  }
}

function abortError(): Error {
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  return error;
}
