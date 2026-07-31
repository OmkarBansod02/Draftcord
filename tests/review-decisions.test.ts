import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewDecisionProcessor } from "../src/documents/review-decisions.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createReviewStore, type PendingReview } from "../src/documents/review-store.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import {
  SuperDocsReviewError,
  type SuperDocsReviewClient
} from "../src/superdocs/review-client.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(decideReview: SuperDocsReviewClient["decideReview"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-decisions-"));
  roots.push(root);
  const logger = pino({ level: "silent" });
  const storage = createDocumentStorage({ rootDirectory: root });
  await storage.store(Buffer.from("original"), {
    originalFilename: "proposal.docx",
    uploadedByUserId: "owner-1",
    guildId: "guild-1",
    channelId: "channel-1",
    discordAttachmentId: "attachment-1",
    editMode: "review"
  }, "document-1");
  const reviewStore = createReviewStore({ storage, logger });
  const now = new Date().toISOString();
  const review: PendingReview = {
    reviewId: "review-1",
    documentId: "document-1",
    discordThreadId: "thread-1",
    discordInstructionMessageId: "instruction-1",
    discordReviewMessageId: "review-message-1",
    requestedByUserId: "owner-1",
    instructionPreview: "Change deadline",
    superdocsJobId: "opaque-job",
    changeIds: ["change-1", "change-2"],
    proposedChanges: [
      { changeId: "change-1", operation: "edit", oldText: "15", newText: "30" },
      { changeId: "change-2", operation: "create", newText: "Taxes excluded" }
    ],
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
  await reviewStore.create(review);
  const metadata = await storage.updateMetadata("document-1", {
    status: "awaiting_approval",
    superdocsSessionId: "session-1",
    discordThreadId: "thread-1",
    pendingReviewId: "review-1",
    pendingReviewMessageId: "review-message-1"
  });
  const registry = createDocumentWorkspaceRegistry({ storage, logger });
  registry.register(metadata);
  const editThreadMessage = vi.fn(async () => undefined);
  const reviewClient: SuperDocsReviewClient = {
    startReview: vi.fn(),
    getJob: vi.fn(),
    decideReview,
    pollJob: vi.fn(async () => ({ status: "completed" as const }))
  };
  const dependencies = {
    config: { ownerUserId: "owner-1", guildId: "guild-1" },
    logger,
    storage,
    registry,
    activity: createEditActivityRepository({ storage, logger }),
    reviewStore,
    reviewClient,
    discordClient: {
      editThreadMessage,
      createThreadMessage: vi.fn(async () => ({ id: "new-message" }))
    }
  };
  return {
    ...dependencies,
    processor: createReviewDecisionProcessor(dependencies),
    editThreadMessage
  };
}

const context = {
  reviewId: "review-1",
  decision: "approve" as const,
  guildId: "guild-1",
  channelId: "thread-1",
  messageId: "review-message-1",
  userId: "owner-1",
  interactionId: "interaction-1"
};

describe("review decision idempotency", () => {
  it("allows exactly one outbound request under duplicate/racing clicks", async () => {
    let release!: () => void;
    const decide = vi.fn(async () => await new Promise<void>((resolve) => { release = resolve; }));
    const test = await harness(decide);
    const first = test.processor.process(context);
    await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
    await expect(test.processor.process({ ...context, decision: "reject" }))
      .resolves.toMatch(/already processing|resolved/);
    release();
    await expect(first).resolves.toContain("applied");
    expect(decide).toHaveBeenCalledOnce();
    expect(decide).toHaveBeenCalledWith({
      sessionId: "session-1",
      jobId: "opaque-job",
      changeIds: ["change-1", "change-2"],
      approved: true
    });
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      editCount: 1,
      lastReviewDecision: "approved"
    });
  });

  it("rejects without incrementing editCount and survives a processor restart", async () => {
    const decide = vi.fn(async () => undefined);
    const test = await harness(decide);
    await expect(test.processor.process({ ...context, decision: "reject" }))
      .resolves.toContain("rejected");
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      editCount: 0,
      lastReviewDecision: "rejected"
    });
    const restarted = createReviewDecisionProcessor(test);
    await expect(restarted.process(context)).resolves.toContain("already been resolved");
    expect(decide).toHaveBeenCalledOnce();
  });

  it("marks an ambiguous modifying timeout and never retries it", async () => {
    const decide = vi.fn(async () => {
      throw new SuperDocsReviewError(
        "review_decision_timeout",
        "request timed out"
      );
    });
    const test = await harness(decide);
    await expect(test.processor.process(context)).resolves.toContain("uncertain");
    expect((await test.reviewStore.read("document-1"))?.status).toBe("ambiguous");
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "review_failed",
      editCount: 0
    });
    await test.processor.process(context);
    expect(decide).toHaveBeenCalledOnce();
  });

  it.each(["approve", "reject"] as const)(
    "keeps a revised proposal round pending after %s",
    async (decision) => {
      const decide = vi.fn(async () => undefined);
      const test = await harness(decide);
      vi.mocked(test.reviewClient.pollJob).mockResolvedValueOnce({
        status: "awaiting_approval",
        metadata: {
          pending_changes: [{
            change_id: "change-next",
            operation: "edit",
            old_html: "<p>Old</p>",
            new_html: "<p>New</p>"
          }]
        }
      });
      await expect(test.processor.process({ ...context, decision }))
        .resolves.toContain("new proposal round");
      expect(await test.storage.readMetadata("document-1")).toMatchObject({
        status: "awaiting_approval",
        editCount: 0
      });
      expect(await test.reviewStore.read("document-1")).toMatchObject({
        status: "pending",
        changeIds: ["change-next"]
      });
      expect(decide).toHaveBeenCalledOnce();
    }
  );

  it("does not turn an applied approval into a retryable failure when final Discord delivery fails", async () => {
    const decide = vi.fn(async () => undefined);
    const test = await harness(decide);
    test.editThreadMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Discord unavailable"));
    await expect(test.processor.process(context)).resolves.toContain("applied");
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      editCount: 1
    });
    expect((await test.reviewStore.read("document-1"))?.status).toBe("completed");
    expect(decide).toHaveBeenCalledOnce();
  });

  it("rejects wrong thread and message controls before the outbound call", async () => {
    const decide = vi.fn(async () => undefined);
    const test = await harness(decide);
    await expect(test.processor.process({ ...context, channelId: "thread-other" }))
      .resolves.toContain("does not match");
    await expect(test.processor.process({ ...context, messageId: "message-other" }))
      .resolves.toContain("does not match");
    await expect(test.processor.process({ ...context, userId: "other-user" }))
      .resolves.toContain("does not match");
    expect(decide).not.toHaveBeenCalled();
  });
});
