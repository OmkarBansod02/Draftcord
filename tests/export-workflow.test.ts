import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscordApiError,
  type DiscordExportFileClient
} from "../src/discord/api.js";
import type { DiscordInteraction } from "../src/discord/types.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import { createReviewStore } from "../src/documents/review-store.js";
import { createExportActivityRepository } from "../src/documents/export-activity.js";
import {
  createDocumentExportWorkflow,
  type DocumentExportWorkflow
} from "../src/documents/export-workflow.js";
import type { SuperDocsExportClient } from "../src/superdocs/export-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  root: string;
  workflow: DocumentExportWorkflow;
  storage: ReturnType<typeof createDocumentStorage>;
  exportClient: SuperDocsExportClient & { createExport: ReturnType<typeof vi.fn> };
  download: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  editOriginal: ReturnType<typeof vi.fn>;
  activityRoot: string;
}

function interaction(id: string, format: "docx" | "pdf" = "docx", limit?: number): DiscordInteraction {
  return {
    id,
    application_id: "app-1",
    type: 3,
    token: `token-${id}`,
    guild_id: "guild-1",
    channel_id: "thread-1",
    attachment_size_limit: limit,
    member: { user: { id: "owner-1" } },
    message: { id: "control-1" },
    data: {
      component_type: 2,
      custom_id: `draftcord:export:${format}:document-1`
    }
  };
}

async function harness(options: {
  status?: "ready" | "edit_failed" | "review_failed";
  maxExportBytes?: number;
  attachmentLimit?: number;
  upload?: (input: unknown) => Promise<{ id: string }>;
} = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-export-workflow-"));
  roots.push(root);
  const logger = pino({ level: "silent" });
  const storage = createDocumentStorage({ rootDirectory: root });
  const documentBytes = await readFile("fixtures/sample-proposal.docx");
  await storage.store(documentBytes, {
    originalFilename: "proposal.docx",
    uploadedByUserId: "owner-1",
    guildId: "guild-1",
    channelId: "channel-1",
    discordAttachmentId: "attachment-1"
  }, "document-1");
  const metadata = await storage.updateMetadata("document-1", {
    status: options.status ?? "ready",
    superdocsSessionId: "opaque-session",
    discordThreadId: "thread-1",
    modeControlMessageId: "control-1",
    editCount: 3
  });
  const registry = createDocumentWorkspaceRegistry({ storage, logger });
  registry.register(metadata);
  const reviewStore = createReviewStore({ storage, logger });
  const activity = createExportActivityRepository({ storage, logger });
  const createExport = vi.fn(async ({ format }: { format: "docx" | "pdf" }) => ({
    downloadUrl: "https://signed.example/export?token=secret",
    expiresAt: "2026-07-31T12:00:00Z",
    expiresInSeconds: 900,
    filename: `server.${format}`,
    format
  }));
  const exportClient = {
    createExport,
    exportDocument: createExport
  } as SuperDocsExportClient & { createExport: ReturnType<typeof vi.fn> };
  const download = vi.fn(async ({
    temporaryParentDirectory
  }: {
    temporaryParentDirectory: string;
  }) => {
    const temporaryDirectory = await mkdtemp(
      path.join(temporaryParentDirectory, ".test-export-")
    );
    const filePath = path.join(temporaryDirectory, "download.bin");
    await writeFile(filePath, documentBytes, { mode: 0o600 });
    return {
      filePath,
      temporaryDirectory,
      byteSize: documentBytes.byteLength,
      contentType: "application/octet-stream"
    };
  });
  const upload = vi.fn(options.upload ?? (async () => ({ id: "discord-export-1" })));
  const discordClient: DiscordExportFileClient = {
    uploadThreadFile: upload
  };
  const editOriginal = vi.fn(async () => undefined);
  const workflow = createDocumentExportWorkflow({
    config: { applicationId: "app-1", ownerUserId: "owner-1", guildId: "guild-1" },
    logger,
    storage,
    registry,
    reviewStore,
    activity,
    exportClient,
    discordClient,
    download,
    editOriginal,
    maxExportBytes: options.maxExportBytes ?? 20_000
  });
  return {
    root,
    workflow,
    storage,
    exportClient,
    download,
    upload,
    editOriginal,
    activityRoot: path.join(root, "documents", "document-1")
  };
}

describe("document export workflow", () => {
  it("exports the current session, stores a verified version, delivers it, and reuses the cache", async () => {
    const test = await harness();
    await test.workflow.run({ interaction: interaction("interaction-1"), documentId: "document-1", format: "docx" });

    expect(test.exportClient.createExport).toHaveBeenCalledWith({
      sessionId: "opaque-session",
      format: "docx",
      filename: "proposal-revised-v3"
    });
    expect(test.download).toHaveBeenCalledOnce();
    expect(test.upload).toHaveBeenCalledOnce();
    const firstUpload = test.upload.mock.calls[0]?.[0] as { filename: string; filePath: string };
    expect(firstUpload.filename).toBe("proposal-revised-v3.docx");
    expect(firstUpload.filePath).toMatch(/exports[\\/]v3[\\/]docx[\\/]document\.docx$/);

    const metadata = await test.storage.readMetadata("document-1");
    expect(metadata).toMatchObject({
      status: "ready",
      editCount: 3,
      lastExportFormat: "docx",
      lastExportVersion: 3,
      lastExportDiscordMessageId: "discord-export-1"
    });
    const exportMetadata = await readFile(
      path.join(test.activityRoot, "exports", "v3", "docx", "export-metadata.json"),
      "utf8"
    );
    expect(exportMetadata).toContain('"sha256"');
    expect(exportMetadata).not.toContain("signed.example");
    expect(exportMetadata).not.toContain("opaque-session");
    expect(test.editOriginal.mock.calls[0]?.[0].content).toContain(
      "https://discord.com/channels/guild-1/thread-1/discord-export-1"
    );

    await test.workflow.run({ interaction: interaction("interaction-2"), documentId: "document-1", format: "docx" });
    expect(test.exportClient.createExport).toHaveBeenCalledOnce();
    expect(test.download).toHaveBeenCalledOnce();
    expect(test.upload).toHaveBeenCalledTimes(2);

    await test.workflow.run({ interaction: interaction("interaction-2"), documentId: "document-1", format: "docx" });
    expect(test.upload).toHaveBeenCalledTimes(2);
    const activity = await readFile(path.join(test.activityRoot, "export-activity.jsonl"), "utf8");
    expect(activity).not.toContain("signed.example");
    expect(activity).not.toContain("opaque-session");
  });

  it("restores edit_failed after an ordinary delivery failure", async () => {
    const test = await harness({
      status: "edit_failed",
      upload: async () => {
        throw new DiscordApiError("forbidden", "private upstream details", 403);
      }
    });
    await test.workflow.run({ interaction: interaction("interaction-failed"), documentId: "document-1", format: "docx" });
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "edit_failed",
      editCount: 3,
      lastExportErrorCategory: "discord_forbidden"
    });
    expect(test.editOriginal.mock.calls.at(-1)?.[0].content).toContain(
      "Discord could not post"
    );
  });

  it("returns an oversized verified export privately without caching or uploading it", async () => {
    const test = await harness({ attachmentLimit: 1 });
    await test.workflow.run({ interaction: interaction("interaction-large", "docx", 1), documentId: "document-1", format: "docx" });
    expect(test.upload).not.toHaveBeenCalled();
    expect(test.editOriginal.mock.calls.at(-1)?.[0].content).toContain(
      "https://signed.example/export?token=secret"
    );
    await expect(readdir(path.join(test.activityRoot, "exports"))).rejects.toThrow();
    const activity = await readFile(path.join(test.activityRoot, "export-activity.jsonl"), "utf8");
    expect(activity).toContain('"status":"direct_link"');
    expect(activity).not.toContain("signed.example");
  });

  it("allows different documents to export independently and blocks a same-document race", async () => {
    const test = await harness();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    test.download.mockImplementationOnce(async ({ temporaryParentDirectory }: { temporaryParentDirectory: string }) => {
      await pending;
      const temporaryDirectory = await mkdtemp(path.join(temporaryParentDirectory, ".race-export-"));
      const filePath = path.join(temporaryDirectory, "download.bin");
      const bytes = await readFile("fixtures/sample-proposal.docx");
      await writeFile(filePath, bytes);
      return { filePath, temporaryDirectory, byteSize: bytes.byteLength, contentType: "application/octet-stream" };
    });
    const first = test.workflow.run({ interaction: interaction("interaction-race-1"), documentId: "document-1", format: "docx" });
    await vi.waitFor(() => expect(test.workflow.isActive("document-1")).toBe(true));
    const second = test.workflow.run({ interaction: interaction("interaction-race-2"), documentId: "document-1", format: "docx" });
    await second;
    expect(test.exportClient.createExport).toHaveBeenCalledOnce();
    release();
    await first;
    expect(test.upload).toHaveBeenCalledOnce();
    expect(test.editOriginal.mock.calls.some((call) => String(call[0]?.content).includes("already processing"))).toBe(true);
  });
});
