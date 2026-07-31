import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentStorage,
  DocumentStorageError
} from "../src/documents/document-storage.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "draftcord-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("document storage", () => {
  it("stores a downloaded DOCX and safe metadata inside the configured root", async () => {
    const root = await temporaryDirectory();
    const bytes = await readFile("fixtures/sample-proposal.docx");
    const storage = createDocumentStorage({ rootDirectory: root });
    const signedUrl = "https://cdn.discordapp.com/file.docx?signature=secret";

    const stored = await storage.store(bytes, {
      originalFilename: "../../secret.docx",
      title: "Proposal",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    });

    expect(path.relative(path.resolve(root), stored.originalPath)).not.toMatch(
      /^\.\.(?:[/\\]|$)/
    );
    expect(path.basename(stored.originalPath)).toBe("original.docx");
    await expect(readFile(stored.originalPath)).resolves.toEqual(bytes);

    const metadataText = await readFile(stored.metadataPath, "utf8");
    const metadata = JSON.parse(metadataText) as Record<string, unknown>;
    expect(metadata.originalFilename).toBe("../../secret.docx");
    expect(metadata.status).toBe("stored");
    expect(metadata.byteSize).toBe(bytes.byteLength);
    expect(metadataText).not.toContain(signedUrl);
    expect(metadataText).not.toContain("signature=secret");
    expect(metadataText).not.toContain("interaction-token");
    expect(metadataText).not.toContain("bot-token");
    expect(metadataText).not.toContain("superdocs-key");
    expect(Object.keys(metadata).sort()).toEqual(
      [
        "byteSize",
        "channelId",
        "createdAt",
        "discordAttachmentId",
        "documentId",
        "guildId",
        "originalFilename",
        "status",
        "title",
        "updatedAt",
        "uploadedByUserId"
      ].sort()
    );
  });

  it("updates metadata atomically with typed workspace fields", async () => {
    const root = await temporaryDirectory();
    const storage = createDocumentStorage({
      rootDirectory: root,
      generateId: () => "document-123"
    });
    const stored = await storage.store(Buffer.from("docx bytes"), {
      originalFilename: "proposal.docx",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    });

    const updated = await storage.updateMetadata(stored.documentId, {
      status: "ready",
      superdocsSessionId: "draftcord-document-123",
      superdocsChunkCount: 7,
      discordThreadId: "thread-1",
      discordThreadName: "Proposal · document"
    });

    expect(updated).toMatchObject({
      status: "ready",
      superdocsSessionId: "draftcord-document-123",
      superdocsChunkCount: 7,
      discordThreadId: "thread-1"
    });
    expect(await readdir(stored.directory)).toEqual([
      "metadata.json",
      "original.docx"
    ]);
  });

  it("cleans partial files when metadata writing fails", async () => {
    const root = await temporaryDirectory();
    let writes = 0;
    const failingWrite = vi.fn(
      async (
        file: string,
        data: string | Buffer,
        options: { flag: string; mode: number; encoding?: BufferEncoding }
      ) => {
        writes += 1;
        if (writes === 2) throw new Error("simulated metadata write failure");
        await writeFile(file, data, options);
      }
    );
    const storage = createDocumentStorage({
      rootDirectory: root,
      writeFileImplementation: failingWrite
    });

    await expect(
      storage.store(Buffer.from("docx bytes"), {
        originalFilename: "proposal.docx",
        uploadedByUserId: "owner-1",
        guildId: "guild-1",
        channelId: "channel-1",
        discordAttachmentId: "attachment-1"
      })
    ).rejects.toBeInstanceOf(DocumentStorageError);

    expect(await readdir(path.join(root, "documents"))).toEqual([]);
  });
});
