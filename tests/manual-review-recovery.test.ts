import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import {
  inspectAndRecoverReview,
  recoverReviewFromOperatorConfirmation
} from "../src/documents/manual-review-recovery.js";
import { createReviewStore } from "../src/documents/review-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-manual-review-"));
  roots.push(root);
  const logger = pino({ level: "silent" });
  const storage = createDocumentStorage({ rootDirectory: root });
  await storage.store(Buffer.from("original-preserved"), {
    originalFilename: "proposal.docx",
    uploadedByUserId: "owner-1",
    guildId: "guild-1",
    channelId: "channel-1",
    discordAttachmentId: "attachment-1",
    editMode: "review"
  }, "document-1");
  await storage.updateMetadata("document-1", {
    status: "review_failed",
    superdocsSessionId: "session-1",
    discordThreadId: "thread-1",
    lastReviewErrorCategory: "review_poll_network"
  });
  const reviewStore = createReviewStore({ storage, logger });
  const now = new Date().toISOString();
  await reviewStore.create({
    reviewId: "review-1",
    documentId: "document-1",
    discordThreadId: "thread-1",
    discordInstructionMessageId: "instruction-1",
    discordReviewMessageId: "review-message-1",
    requestedByUserId: "owner-1",
    instructionPreview: "Change the deadline",
    superdocsJobId: "job-1",
    changeIds: ["change-1"],
    proposedChanges: [{ changeId: "change-1", operation: "edit" }],
    status: "ambiguous",
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    decision: "approved",
    decidedAt: now,
    decisionInteractionId: "interaction-1",
    safeErrorCategory: "review_poll_network"
  });
  return {
    root,
    storage,
    reviewStore,
    activity: createEditActivityRepository({ storage, logger })
  };
}

describe("manual review recovery", () => {
  it("inspects first and reconciles only a known completed job without another approval", async () => {
    const test = await harness();
    const getJob = vi.fn(async () => ({ status: "completed" as const }));
    const beforeMetadata = await test.storage.readMetadata("document-1");

    await expect(inspectAndRecoverReview({
      ...test,
      documentId: "document-1",
      applyKnownTerminal: false,
      reviewClient: { getJob }
    })).resolves.toMatchObject({
      applied: false,
      outcome: "inspection_only",
      jobStatus: "completed"
    });
    expect(await test.storage.readMetadata("document-1")).toEqual(beforeMetadata);
    expect((await test.reviewStore.read("document-1"))?.status).toBe("ambiguous");

    await expect(inspectAndRecoverReview({
      ...test,
      documentId: "document-1",
      applyKnownTerminal: true,
      reviewClient: { getJob }
    })).resolves.toMatchObject({
      applied: true,
      outcome: "completed_approved"
    });
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      superdocsSessionId: "session-1",
      editCount: 1,
      lastReviewDecision: "approved"
    });
    expect((await test.reviewStore.read("document-1"))?.status).toBe("completed");
    expect(await readFile(
      path.join(test.root, "documents", "document-1", "original.docx"),
      "utf8"
    )).toBe("original-preserved");
    const history = await readFile(
      path.join(test.root, "documents", "document-1", "activity.jsonl"),
      "utf8"
    );
    expect(history).toContain("manual_recovery_confirmed_completed");
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it("does not change local state while the remote job is nonterminal", async () => {
    const test = await harness();
    const beforeMetadata = await test.storage.readMetadata("document-1");
    await expect(inspectAndRecoverReview({
      ...test,
      documentId: "document-1",
      applyKnownTerminal: true,
      reviewClient: {
        getJob: vi.fn(async () => ({ status: "in_progress" as const }))
      }
    })).resolves.toMatchObject({ applied: false, outcome: "not_terminal" });
    expect(await test.storage.readMetadata("document-1")).toEqual(beforeMetadata);
    expect((await test.reviewStore.read("document-1"))?.status).toBe("ambiguous");
  });

  it("records an explicit operator-confirmed unchanged outcome without an API decision", async () => {
    const test = await harness();
    await expect(recoverReviewFromOperatorConfirmation({
      ...test,
      documentId: "document-1",
      expectedReviewId: "review-1",
      confirmedOutcome: "unchanged",
      decisionInteractionId: "interaction-1"
    })).resolves.toMatchObject({
      applied: true,
      outcome: "confirmed_unchanged"
    });
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "review_failed",
      editCount: 0,
      superdocsSessionId: "session-1",
      lastReviewErrorCategory: "manual_recovery_operator_confirmed_unchanged"
    });
    expect(await test.reviewStore.read("document-1")).toMatchObject({
      status: "failed",
      decisionInteractionId: "interaction-1"
    });
    const history = await readFile(
      path.join(test.root, "documents", "document-1", "activity.jsonl"),
      "utf8"
    );
    expect(history).toContain("manual_recovery_operator_confirmed_unchanged");
    expect(history).toContain('"discordInteractionId":"interaction-1"');
  });
});
