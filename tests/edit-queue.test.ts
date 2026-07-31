import { describe, expect, it } from "vitest";

import { createDocumentEditQueue } from "../src/documents/edit-queue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("per-document edit queue", () => {
  it("runs one edit at a time and preserves order for the same document", async () => {
    const queue = createDocumentEditQueue();
    const release = deferred();
    const events: string[] = [];
    expect(
      queue.enqueue("document-1", async () => {
        events.push("first-start");
        await release.promise;
        events.push("first-end");
      }).position
    ).toBe(0);
    expect(
      queue.enqueue("document-1", async () => {
        events.push("second");
      }).position
    ).toBe(1);

    await nextTurn();
    expect(events).toEqual(["first-start"]);
    release.resolve();
    expect(await queue.waitForIdle(1_000)).toBe(true);
    expect(events).toEqual(["first-start", "first-end", "second"]);
    expect(queue.documentQueueCount).toBe(0);
  });

  it("allows different documents to edit concurrently", async () => {
    const queue = createDocumentEditQueue();
    const release = deferred();
    const started: string[] = [];
    queue.enqueue("document-1", async () => {
      started.push("document-1");
      await release.promise;
    });
    queue.enqueue("document-2", async () => {
      started.push("document-2");
      await release.promise;
    });
    await nextTurn();
    expect(started.sort()).toEqual(["document-1", "document-2"]);
    release.resolve();
    await queue.waitForIdle(1_000);
  });

  it("enforces the pending limit", async () => {
    const queue = createDocumentEditQueue({ maxPendingEdits: 1 });
    const release = deferred();
    queue.enqueue("document-1", () => release.promise);
    expect(queue.enqueue("document-1", async () => undefined).accepted).toBe(true);
    expect(queue.enqueue("document-1", async () => undefined).accepted).toBe(false);
    release.resolve();
    await queue.waitForIdle(1_000);
  });

  it("releases the queue after a failure", async () => {
    const queue = createDocumentEditQueue();
    const events: string[] = [];
    queue.enqueue("document-1", async () => {
      events.push("failed");
      throw new Error("simulated failure");
    });
    queue.enqueue("document-1", async () => {
      events.push("continued");
    });
    expect(await queue.waitForIdle(1_000)).toBe(true);
    expect(events).toEqual(["failed", "continued"]);
    expect(queue.has("document-1")).toBe(false);
  });
});
