import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import { createReviewStore } from "../src/documents/review-store.js";
import { reconcileStaleExports } from "../src/documents/export-recovery.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("startup export recovery", () => {
  it("restores a stale export to ready without replaying delivery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-export-recovery-"));
    roots.push(root);
    const logger = pino({ level: "silent" });
    const storage = createDocumentStorage({ rootDirectory: root });
    await storage.store(Buffer.from("docx"), {
      originalFilename: "proposal.docx",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    }, "document-1");
    const metadata = await storage.updateMetadata("document-1", {
      status: "exporting",
      superdocsSessionId: "opaque-session",
      discordThreadId: "thread-1",
      modeControlMessageId: "control-1"
    });
    const registry = createDocumentWorkspaceRegistry({ storage, logger });
    registry.register(metadata);
    const reviewStore = createReviewStore({ storage, logger });
    await reconcileStaleExports({
      storage,
      registry,
      reviewStore,
      logger
    });
    expect(await storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      lastExportErrorCategory: "stale_export_recovered"
    });
  });

  it("does not recover while a review remains unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-export-recovery-"));
    roots.push(root);
    const logger = pino({ level: "silent" });
    const storage = createDocumentStorage({ rootDirectory: root });
    await storage.store(Buffer.from("docx"), {
      originalFilename: "proposal.docx",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    }, "document-1");
    const metadata = await storage.updateMetadata("document-1", {
      status: "exporting",
      superdocsSessionId: "opaque-session",
      discordThreadId: "thread-1",
      pendingReviewId: "review-1",
      pendingReviewMessageId: "review-message-1"
    });
    const registry = createDocumentWorkspaceRegistry({ storage, logger });
    registry.register(metadata);
    const reviewStore = createReviewStore({ storage, logger });
    const now = new Date().toISOString();
    await reviewStore.create({
      reviewId: "review-1",
      documentId: "document-1",
      discordThreadId: "thread-1",
      discordInstructionMessageId: "instruction-1",
      discordReviewMessageId: "review-message-1",
      requestedByUserId: "owner-1",
      instructionPreview: "Edit",
      superdocsJobId: "opaque-job",
      changeIds: ["change-1"],
      proposedChanges: [{ changeId: "change-1", operation: "edit" }],
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await reconcileStaleExports({
      storage,
      registry,
      reviewStore,
      logger
    });
    expect((await storage.readMetadata("document-1")).status).toBe("exporting");
  });
});
