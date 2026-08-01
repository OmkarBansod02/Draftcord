import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentStorage } from "../src/documents/document-storage.js";
import { reconcilePendingReviews } from "../src/documents/review-recovery.js";
import { createReviewStore, type PendingReview } from "../src/documents/review-store.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import type { SuperDocsReviewClient } from "../src/superdocs/review-client.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(status: PendingReview["status"], expiresAt: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-recovery-"));
  roots.push(root);
  const logger = pino({ level: "silent" });
  const storage = createDocumentStorage({ rootDirectory: root });
  await storage.store(Buffer.from("docx"), {
    originalFilename: "proposal.docx",
    uploadedByUserId: "owner-1",
    guildId: "guild-1",
    channelId: "channel-1",
    discordAttachmentId: "attachment-1",
    editMode: "review"
  }, "document-1");
  const metadata = await storage.updateMetadata("document-1", {
    status: status === "decision_processing" ? "approval_processing" :
      status === "generating" ? "review_generating" : "awaiting_approval",
    superdocsSessionId: "session-1",
    discordThreadId: "thread-1",
    pendingReviewId: "review-1",
    pendingReviewMessageId: "message-1"
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
    discordReviewMessageId: "message-1",
    requestedByUserId: "owner-1",
    instructionPreview: "Edit",
    superdocsJobId: "opaque-job",
    changeIds: ["change-1"],
    proposedChanges: [{ changeId: "change-1", operation: "edit" }],
    status,
    createdAt: now,
    updatedAt: now,
    expiresAt
  });
  return { logger, storage, registry, reviewStore };
}

function client(getJob: SuperDocsReviewClient["getJob"]): SuperDocsReviewClient {
  return {
    startReview: vi.fn(),
    getJob,
    pollJob: vi.fn(),
    decideReview: vi.fn()
  };
}

describe("startup review reconciliation", () => {
  it.each(["generating", "decision_processing"] as const)(
    "classifies interrupted %s work without replaying it",
    async (status) => {
      const test = await setup(status, new Date(Date.now() + 60_000).toISOString());
      const getJob = vi.fn();
      await reconcilePendingReviews({
        ...test,
        reviewClient: client(getJob)
      });
      expect(await test.reviewStore.read("document-1")).toMatchObject({
        status: status === "generating" ? "failed" : "reconciliation_required",
        safeErrorCategory: status === "generating"
          ? "interrupted_review_generation"
          : "interrupted_decision_reconciliation"
      });
      expect(await test.storage.readMetadata("document-1")).toMatchObject({
        status: "review_failed",
        lastReviewErrorCategory: status === "generating"
          ? "interrupted_review_generation"
          : "interrupted_decision_reconciliation"
      });
      expect(getJob).not.toHaveBeenCalled();
    }
  );

  it("expires stale controls without contacting SuperDocs", async () => {
    const test = await setup("pending", new Date(Date.now() - 1_000).toISOString());
    const getJob = vi.fn();
    await reconcilePendingReviews({ ...test, reviewClient: client(getJob) });
    expect((await test.reviewStore.read("document-1"))?.status).toBe("expired");
    expect(getJob).not.toHaveBeenCalled();
  });

  it("preserves a valid pending review when the temporary job still awaits approval", async () => {
    const test = await setup("pending", new Date(Date.now() + 60_000).toISOString());
    const getJob = vi.fn(async () => ({
      status: "awaiting_approval" as const,
      metadata: { pending_changes: [{ change_id: "change-1", operation: "edit" as const }] }
    }));
    await reconcilePendingReviews({ ...test, reviewClient: client(getJob) });
    expect((await test.reviewStore.read("document-1"))?.status).toBe("pending");
    expect((await test.storage.readMetadata("document-1")).status).toBe("awaiting_approval");
    expect(getJob).toHaveBeenCalledOnce();
  });
});
