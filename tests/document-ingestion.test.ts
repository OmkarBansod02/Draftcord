import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadAttachment } from "../src/documents/attachment-downloader.js";
import { ingestDocument } from "../src/documents/document-ingestion.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("ingestDocument", () => {
  it("downloads, verifies, and stores a valid DOCX", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-ingest-"));
    temporaryDirectories.push(root);
    const fixture = await readFile("fixtures/sample-proposal.docx");
    const fetchImplementation = vi.fn(
      async () => new Response(fixture)
    ) as unknown as typeof fetch;

    const stored = await ingestDocument(
      {
        interactionId: "interaction-1",
        attachment: {
          id: "attachment-1",
          filename: "../../sample-proposal.docx",
          size: 1,
          url: "https://cdn.discordapp.com/file.docx?signature=do-not-store"
        },
        title: "Sample proposal",
        uploadedByUserId: "owner-1",
        guildId: "guild-1",
        channelId: "channel-1"
      },
      {
        logger: pino({ level: "silent" }),
        storage: createDocumentStorage({ rootDirectory: root }),
        download: (options) =>
          downloadAttachment({ ...options, fetchImplementation })
      }
    );

    await expect(readFile(stored.originalPath)).resolves.toEqual(fixture);
    expect(stored.directory).toBe(
      path.join(path.resolve(root), "documents", stored.documentId)
    );
    const metadata = await readFile(stored.metadataPath, "utf8");
    expect(metadata).not.toContain("cdn.discordapp.com");
    expect(metadata).not.toContain("do-not-store");
  });
});
