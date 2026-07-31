import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscordApiError,
  type DiscordDocumentThreadClient
} from "../src/discord/api.js";
import {
  createDocumentWorkspace,
  DocumentWorkspaceError
} from "../src/documents/document-workspace.js";
import {
  createDocumentStorage,
  type DocumentStatus
} from "../src/documents/document-storage.js";
import {
  SuperDocsClientError,
  type SuperDocsClient
} from "../src/superdocs/client.js";

const temporaryDirectories: string[] = [];
const documentBytes = Buffer.from("verified stored document bytes");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function createHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-workspace-"));
  temporaryDirectories.push(root);
  const storage = createDocumentStorage({
    rootDirectory: root,
    generateId: () => "document-12345678"
  });
  const statuses: DocumentStatus[] = [];
  const updateMetadata = storage.updateMetadata.bind(storage);
  vi.spyOn(storage, "updateMetadata").mockImplementation(
    async (documentId, update) => {
      if (update.status) statuses.push(update.status);
      return updateMetadata(documentId, update);
    }
  );

  const superdocsClient: SuperDocsClient = {
    ingestStoredDocument: vi.fn(async () => ({
      superdocsSessionId: "draftcord-document-12345678",
      uploadId: "upload-1",
      processingStatus: "ready",
      chunkCount: 7,
      superdocsDocumentId: "superdocs-document-1",
      warningsCount: 0
    }))
  };
  const discordClient: DiscordDocumentThreadClient = {
    createPublicThread: vi.fn(async ({ name }) => ({
      threadId: "thread-1",
      name
    })),
    addThreadMember: vi.fn(async () => undefined),
    createThreadMessage: vi.fn(async () => ({ id: "message-1" }))
  };
  const input = {
    interactionId: "interaction-1",
    attachment: {
      id: "attachment-1",
      filename: "../../proposal.docx",
      size: documentBytes.byteLength,
      url: "https://cdn.discordapp.com/file.docx?signature=do-not-store"
    },
    title: "Implementation Proposal",
    uploadedByUserId: "owner-1",
    guildId: "guild-1",
    channelId: "channel-1"
  };

  return {
    root,
    storage,
    statuses,
    superdocsClient,
    discordClient,
    input,
    dependencies: {
      logger: pino({ level: "silent" }),
      storage,
      superdocsClient,
      discordClient,
      ownerUserId: "owner-1",
      documentChannelId: "channel-1",
      download: vi.fn(async () => documentBytes),
      verify: vi.fn(async () => undefined)
    }
  };
}

describe("document workspace orchestration", () => {
  it("completes the workflow in the required metadata status order", async () => {
    const harness = await createHarness();
    const result = await createDocumentWorkspace(
      harness.input,
      harness.dependencies
    );

    expect(harness.statuses).toEqual([
      "superdocs_ingesting",
      "superdocs_ready",
      "thread_creating",
      "ready"
    ]);
    expect(harness.superdocsClient.ingestStoredDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        originalPath: expect.stringMatching(/original\.docx$/),
        documentId: "document-12345678"
      })
    );
    expect(harness.discordClient.createPublicThread).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: "channel-1" })
    );
    expect(harness.discordClient.addThreadMember).toHaveBeenCalledWith(
      "thread-1",
      "owner-1"
    );
    expect(harness.discordClient.createThreadMessage).toHaveBeenCalledOnce();
    expect(result.discordThreadUrl).toBe(
      "https://discord.com/channels/guild-1/thread-1"
    );
    expect(result.metadata).toMatchObject({
      status: "ready",
      editMode: "review",
      superdocsSessionId: "draftcord-document-12345678",
      superdocsDocumentId: "superdocs-document-1",
      superdocsChunkCount: 7,
      discordThreadId: "thread-1"
    });
    const welcomeCall = vi.mocked(harness.discordClient.createThreadMessage).mock.calls[0];
    expect(welcomeCall?.[1]).toContain("Editing mode: Review Mode");
    expect(welcomeCall?.[2]?.[0]?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Review Mode", disabled: true })
      ])
    );
  });

  it("persists a configured auto_apply default for a new workspace", async () => {
    const harness = await createHarness();
    const result = await createDocumentWorkspace(harness.input, {
      ...harness.dependencies,
      defaultEditMode: "auto_apply"
    });
    expect(result.metadata.editMode).toBe("auto_apply");
    const welcomeCall = vi.mocked(harness.discordClient.createThreadMessage).mock.calls[0];
    expect(welcomeCall?.[1]).toContain("Editing mode: Auto Apply");
    expect(welcomeCall?.[2]?.[0]?.components[0]).toMatchObject({
      label: "Auto Apply",
      disabled: true
    });
  });

  it("creates no thread when SuperDocs ingestion fails and retains original.docx", async () => {
    const harness = await createHarness();
    vi.mocked(harness.superdocsClient.ingestStoredDocument).mockRejectedValueOnce(
      new SuperDocsClientError(
        "processing_http_error",
        "external response body: sensitive"
      )
    );

    await expect(
      createDocumentWorkspace(harness.input, harness.dependencies)
    ).rejects.toMatchObject({
      stage: "superdocs_ingestion",
      documentId: "document-12345678",
      originalRetained: true
    });
    expect(harness.discordClient.createPublicThread).not.toHaveBeenCalled();
    const metadata = await harness.storage.readMetadata("document-12345678");
    expect(metadata).toMatchObject({
      status: "superdocs_failed",
      lastErrorCategory: "processing_http_error"
    });
    expect(JSON.stringify(metadata)).not.toContain("sensitive");
    await expect(
      access(
        path.join(
          harness.root,
          "documents",
          "document-12345678",
          "original.docx"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("preserves the SuperDocs mapping when thread creation fails", async () => {
    const harness = await createHarness();
    vi.mocked(harness.discordClient.createPublicThread).mockRejectedValueOnce(
      new DiscordApiError("forbidden", "external Discord details", 403)
    );

    await expect(
      createDocumentWorkspace(harness.input, harness.dependencies)
    ).rejects.toMatchObject({ stage: "discord_thread_creation" });
    const metadata = await harness.storage.readMetadata("document-12345678");
    expect(metadata).toMatchObject({
      status: "thread_failed",
      superdocsSessionId: "draftcord-document-12345678",
      superdocsDocumentId: "superdocs-document-1",
      lastErrorCategory: "thread_create_forbidden"
    });
    expect(metadata.discordThreadId).toBeUndefined();
    await expect(
      access(
        path.join(
          harness.root,
          "documents",
          "document-12345678",
          "original.docx"
        )
      )
    ).resolves.toBeUndefined();
  });

  it("preserves the one created thread ID when setup fails", async () => {
    const harness = await createHarness();
    vi.mocked(harness.discordClient.addThreadMember).mockRejectedValueOnce(
      new DiscordApiError("forbidden", "member add forbidden", 403)
    );

    await expect(
      createDocumentWorkspace(harness.input, harness.dependencies)
    ).rejects.toMatchObject({
      stage: "discord_thread_setup",
      threadUrl: "https://discord.com/channels/guild-1/thread-1"
    });
    expect(harness.discordClient.createPublicThread).toHaveBeenCalledOnce();
    expect(harness.discordClient.createThreadMessage).not.toHaveBeenCalled();
    const metadata = await harness.storage.readMetadata("document-12345678");
    expect(metadata).toMatchObject({
      status: "thread_setup_failed",
      discordThreadId: "thread-1",
      superdocsSessionId: "draftcord-document-12345678",
      lastErrorCategory: "thread_member_add_forbidden"
    });
    await expect(readFile(path.join(harness.root, "documents", "document-12345678", "original.docx"))).resolves.toEqual(documentBytes);
  });

  it("never persists secrets, remote URLs, or external response bodies", async () => {
    const harness = await createHarness();
    await createDocumentWorkspace(harness.input, harness.dependencies);
    const metadataText = await readFile(
      path.join(
        harness.root,
        "documents",
        "document-12345678",
        "metadata.json"
      ),
      "utf8"
    );

    expect(metadataText).not.toContain("cdn.discordapp.com");
    expect(metadataText).not.toContain("signature=do-not-store");
    expect(metadataText).not.toContain("test-bot-token");
    expect(metadataText).not.toContain("SUPERDOCS_API_KEY");
    expect(metadataText).not.toContain("uploads.example");
    expect(metadataText).not.toContain("discord.com/channels");
  });

  it("marks welcome-message failures as setup failures without creating another thread", async () => {
    const harness = await createHarness();
    vi.mocked(harness.discordClient.createThreadMessage).mockRejectedValueOnce(
      new DiscordApiError("server_error", "raw upstream body", 500)
    );

    await expect(
      createDocumentWorkspace(harness.input, harness.dependencies)
    ).rejects.toMatchObject({ stage: "discord_thread_setup" });
    expect(harness.discordClient.createPublicThread).toHaveBeenCalledOnce();
    const metadata = await harness.storage.readMetadata("document-12345678");
    expect(metadata).toMatchObject({
      status: "thread_setup_failed",
      discordThreadId: "thread-1",
      lastErrorCategory: "thread_message_create_server_error"
    });
    expect(JSON.stringify(metadata)).not.toContain("raw upstream body");
  });
});
