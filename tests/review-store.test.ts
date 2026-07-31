import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { formatReviewProposal } from "../src/discord/review-components.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import {
  createReviewStore,
  sanitizeReviewText,
  type PendingReview
} from "../src/documents/review-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-review-store-"));
  roots.push(root);
  const storage = createDocumentStorage({ rootDirectory: root });
  await storage.store(Buffer.from("docx"), {
    originalFilename: "proposal.docx",
    uploadedByUserId: "owner-1",
    guildId: "guild-1",
    channelId: "channel-1",
    discordAttachmentId: "attachment-1",
    editMode: "review"
  }, "document-1");
  return {
    root,
    storage,
    store: createReviewStore({ storage, logger: pino({ level: "silent" }) })
  };
}

function pending(overrides: Partial<PendingReview> = {}): PendingReview {
  const now = new Date().toISOString();
  return {
    reviewId: "review-1",
    documentId: "document-1",
    discordThreadId: "thread-1",
    discordInstructionMessageId: "instruction-1",
    discordReviewMessageId: "message-1",
    requestedByUserId: "owner-1",
    instructionPreview: "Change ＠everyone safely",
    superdocsJobId: "opaque-job",
    changeIds: ["change-1"],
    proposedChanges: [{
      changeId: "change-1",
      operation: "edit",
      oldText: "Before",
      newText: "After",
      explanation: "Requested update"
    }],
    status: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
  };
}

describe("pending review storage and previews", () => {
  it("writes atomically, reloads after restart, and contains safe fields only", async () => {
    const { root, storage, store } = await harness();
    await store.create(pending());
    const directory = path.join(root, "documents", "document-1");
    expect((await readdir(directory)).filter((name) => name.includes("pending-review")))
      .toEqual(["pending-review.json"]);
    const text = await readFile(path.join(directory, "pending-review.json"), "utf8");
    expect(text).not.toContain("session");
    expect(text).not.toContain("old_html");
    expect(text).not.toContain("chunk_id");
    const restarted = createReviewStore({ storage, logger: pino({ level: "silent" }) });
    await expect(restarted.find("review-1")).resolves.toMatchObject({ status: "pending" });
  });

  it("rejects a second unresolved review but permits replacement after terminal state", async () => {
    const { store } = await harness();
    const first = await store.create(pending());
    await expect(store.create(pending({ reviewId: "review-2" })))
      .rejects.toMatchObject({ category: "review_conflict" });
    await store.replace({ ...first, status: "completed" }, ["pending"]);
    await expect(store.create(pending({ reviewId: "review-2" })))
      .resolves.toMatchObject({ reviewId: "review-2" });
  });

  it("handles a corrupt pending-review file without throwing", async () => {
    const { root, store } = await harness();
    await writeFile(
      path.join(root, "documents", "document-1", "pending-review.json"),
      "not-json"
    );
    await expect(store.read("document-1")).resolves.toBeUndefined();
  });

  it("strips HTML and scripts, decodes entities, caps previews, and escapes mentions", () => {
    const safe = sanitizeReviewText(
      `<script>alert('x')</script><p>Payment &amp; tax for @everyone</p>${"x".repeat(800)}`,
      100
    );
    expect(safe).not.toMatch(/<script|<p>/i);
    expect(safe).toContain("Payment & tax for ＠everyone");
    expect(safe.length).toBeLessThanOrEqual(100);
  });

  it("formats a bounded proposal without raw HTML or opaque external IDs", () => {
    const review = pending({
      superdocsJobId: "SECRET-JOB-ID",
      proposedChanges: Array.from({ length: 30 }, (_, index) => ({
        changeId: `SECRET-CHANGE-${index}`,
        operation: "edit" as const,
        oldText: `Before ${index} ${"a".repeat(150)}`,
        newText: `After ${index} ${"b".repeat(150)}`,
        explanation: "Safe explanation"
      }))
    });
    const proposal = formatReviewProposal(review);
    expect(proposal.content.length).toBeLessThanOrEqual(2_000);
    expect(proposal.content).toContain("omitted");
    expect(proposal.content).not.toContain("SECRET-JOB-ID");
    expect(proposal.content).not.toContain("SECRET-CHANGE");
    expect(proposal.components[0]?.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Approve All", style: 3 }),
        expect.objectContaining({ label: "Reject All", style: 4 })
      ])
    );
  });
});
