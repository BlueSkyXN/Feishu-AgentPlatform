export type BridgeEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_start'; toolName: string }
  | { type: 'tool_end'; toolName: string; isError: boolean };

export interface DeltaBridgeSession {
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  prompt(): Promise<void>;
  abort(): Promise<void>;
}

export interface DeltaBridgeSink {
  append(chunk: string): Promise<void>;
}

export interface DeltaBridgeHooks {
  onToolStart?(toolName: string): void;
  onToolEnd?(toolName: string, isError: boolean): void;
  onAbortError?(error: unknown): void;
}

export async function bridgeTextDeltas(
  session: DeltaBridgeSession,
  sink: DeltaBridgeSink,
  hooks: DeltaBridgeHooks = {},
): Promise<void> {
  let appendChain: Promise<void> = Promise.resolve();
  let appendFailure: unknown;
  let abortRequested = false;

  const requestAbort = (): void => {
    if (abortRequested) return;
    abortRequested = true;
    void session.abort().catch((error: unknown) => hooks.onAbortError?.(error));
  };

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'text_delta') {
      appendChain = appendChain
        .then(async () => {
          if (appendFailure !== undefined) return;
          await sink.append(event.delta);
        })
        .catch((error: unknown) => {
          if (appendFailure === undefined) {
            appendFailure = error;
            requestAbort();
          }
        });
      return;
    }

    if (event.type === 'tool_start') {
      hooks.onToolStart?.(event.toolName);
    } else {
      hooks.onToolEnd?.(event.toolName, event.isError);
    }
  });

  let promptFailure: unknown;
  try {
    await session.prompt();
  } catch (error) {
    promptFailure = error;
  } finally {
    // Pi's prompt() resolves only after the accepted run finishes. Detaching
    // here freezes appendChain so it can be drained deterministically below.
    unsubscribe();
  }

  await appendChain;
  if (appendFailure !== undefined) throw appendFailure;
  if (promptFailure !== undefined) throw promptFailure;
}
