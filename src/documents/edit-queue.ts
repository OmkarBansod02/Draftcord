export interface EnqueueResult {
  accepted: boolean;
  position?: number;
}

interface QueueEntry {
  run: () => Promise<void>;
}

interface DocumentQueueState {
  active: boolean;
  pending: QueueEntry[];
}

export interface DocumentEditQueue {
  enqueue(documentId: string, run: () => Promise<void>): EnqueueResult;
  waitForIdle(timeoutMs: number): Promise<boolean>;
  has(documentId: string): boolean;
  readonly documentQueueCount: number;
}

export function createDocumentEditQueue({
  maxPendingEdits = 5
}: {
  maxPendingEdits?: number;
} = {}): DocumentEditQueue {
  if (!Number.isInteger(maxPendingEdits) || maxPendingEdits < 0) {
    throw new Error("maxPendingEdits must be a non-negative integer");
  }

  const queues = new Map<string, DocumentQueueState>();
  const idleWaiters = new Set<() => void>();

  function notifyIdle(): void {
    if (queues.size !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function startNext(documentId: string, state: DocumentQueueState): void {
    if (state.active) return;
    const entry = state.pending.shift();
    if (!entry) {
      queues.delete(documentId);
      notifyIdle();
      return;
    }

    state.active = true;
    void entry
      .run()
      .catch(() => undefined)
      .finally(() => {
        state.active = false;
        startNext(documentId, state);
      });
  }

  return {
    enqueue(documentId, run) {
      let state = queues.get(documentId);
      if (!state) {
        state = { active: false, pending: [] };
        queues.set(documentId, state);
      }

      const waitingCount = state.active
        ? state.pending.length
        : Math.max(0, state.pending.length - 1);
      if (waitingCount >= maxPendingEdits && (state.active || state.pending.length > 0)) {
        return { accepted: false };
      }

      const position = state.active ? state.pending.length + 1 : state.pending.length;
      state.pending.push({ run });
      queueMicrotask(() => startNext(documentId, state as DocumentQueueState));
      return { accepted: true, position };
    },

    async waitForIdle(timeoutMs) {
      if (queues.size === 0) return true;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          idleWaiters.delete(onIdle);
          resolve(value);
        };
        const onIdle = () => finish(true);
        const timeout = setTimeout(() => finish(false), timeoutMs);
        idleWaiters.add(onIdle);
      });
    },

    has(documentId) {
      return queues.has(documentId);
    },

    get documentQueueCount() {
      return queues.size;
    }
  };
}
