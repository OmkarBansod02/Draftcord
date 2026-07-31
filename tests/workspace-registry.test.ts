import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";

const temporaryDirectories: string[] = [];
const logger = pino({ level: "silent" });

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-registry-"));
  temporaryDirectories.push(root);
  const storage = createDocumentStorage({ rootDirectory: root });
  return {
    root,
    storage,
    registry: createDocumentWorkspaceRegistry({ storage, logger })
  };
}

async function storeWorkspace(
  storage: ReturnType<typeof createDocumentStorage>,
  documentId: string,
  threadId?: string
) {
  await storage.store(
    Buffer.from("docx"),
    {
      originalFilename: `${documentId}.docx`,
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: `attachment-${documentId}`
    },
    documentId
  );
  return await storage.updateMetadata(documentId, {
    status: "ready",
    superdocsSessionId: `session-${documentId}`,
    ...(threadId ? { discordThreadId: threadId } : {})
  });
}

describe("document workspace registry", () => {
  it("rebuilds thread mappings from metadata and survives a restart", async () => {
    const { storage, registry } = await harness();
    await storeWorkspace(storage, "document-1", "thread-1");

    expect(await registry.refresh()).toMatchObject({ mappedCount: 1 });
    expect(registry.resolve("thread-1")?.documentId).toBe("document-1");

    const restarted = createDocumentWorkspaceRegistry({ storage, logger });
    await restarted.refresh();
    expect(restarted.resolve("thread-1")?.superdocsSessionId).toBe(
      "session-document-1"
    );
  });

  it("refreshes immediately after a new workspace is registered", async () => {
    const { storage, registry } = await harness();
    await registry.refresh();
    const metadata = await storeWorkspace(storage, "document-1", "thread-1");
    expect(registry.resolve("thread-1")).toBeUndefined();
    expect(registry.register(metadata)).toBe(true);
    expect(registry.resolve("thread-1")?.documentId).toBe("document-1");
  });

  it("ignores metadata without a thread ID", async () => {
    const { storage, registry } = await harness();
    await storeWorkspace(storage, "document-1");
    expect(await registry.refresh()).toMatchObject({ mappedCount: 0 });
  });

  it("reports duplicate mappings and does not route the conflicting thread", async () => {
    const { storage, registry } = await harness();
    await storeWorkspace(storage, "document-1", "thread-shared");
    await storeWorkspace(storage, "document-2", "thread-shared");
    const refreshed = await registry.refresh();
    expect(refreshed.duplicateThreadIds).toEqual(["thread-shared"]);
    expect(registry.resolve("thread-shared")).toBeUndefined();
  });

  it("handles corrupt metadata without losing healthy mappings", async () => {
    const { root, storage, registry } = await harness();
    await storeWorkspace(storage, "document-1", "thread-1");
    const corruptDirectory = path.join(root, "documents", "corrupt-document");
    await mkdir(corruptDirectory, { recursive: true });
    await writeFile(path.join(corruptDirectory, "metadata.json"), "not-json");

    expect(await registry.refresh()).toMatchObject({
      mappedCount: 1,
      corruptCount: 1
    });
    expect(registry.resolve("thread-1")?.documentId).toBe("document-1");
  });
});
