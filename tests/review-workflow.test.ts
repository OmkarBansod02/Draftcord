import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Message } from "discord.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentMessageHandler } from "../src/discord/document-messages.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import { createDocumentEditQueue } from "../src/documents/edit-queue.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createReviewStore } from "../src/documents/review-store.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import type { SuperDocsReviewClient } from "../src/superdocs/review-client.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-review-flow-"));
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
  const metadata = await storage.updateMetadata("document-1", {
    status: "ready",
    superdocsSessionId: "session-1",
    discordThreadId: "thread-1"
  });
  const registry = createDocumentWorkspaceRegistry({ storage, logger });
  registry.register(metadata);
  const reviewStore = createReviewStore({ storage, logger });
  const queue = createDocumentEditQueue();
  const reviewClient: SuperDocsReviewClient = {
    startReview: vi.fn(async () => ({ jobId: "opaque-job" })),
    getJob: vi.fn(),
    decideReview: vi.fn(),
    pollJob: vi.fn(async () => ({
      status: "awaiting_approval" as const,
      metadata: {
        awaiting_kind: null,
        pending_changes: [{
          change_id: "change-1",
          operation: "edit" as const,
          old_html: "<p>Payment is due in 15 days.</p>",
          new_html: "<p>Payment is due in 30 days.</p>",
          ai_explanation: "Updated @everyone's requested deadline."
        }]
      }
    }))
  };
  const editDocument = vi.fn(async () => ({ response: "wrong path" }));
  const handler = createDocumentMessageHandler({
    config: { guildId: "guild-1", ownerUserId: "owner-1" },
    logger,
    storage,
    registry,
    activity: createEditActivityRepository({ storage, logger }),
    queue,
    superdocsClient: { editDocument },
    reviewStore,
    reviewClient
  });
  return { storage, queue, reviewStore, reviewClient, editDocument, handler };
}

function message(overrides: Record<string, unknown> = {}) {
  const edit = vi.fn(async () => undefined);
  const reply = vi.fn(async () => ({ id: "review-message-1", edit }));
  const channel = {
    isThread: () => true,
    isSendable: () => true,
    sendTyping: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined)
  };
  return {
    value: {
      id: "instruction-1",
      guildId: "guild-1",
      channelId: "thread-1",
      content: "Change the deadline from 15 to 30 days.",
      author: { id: "owner-1", bot: false },
      webhookId: null,
      system: false,
      channel,
      reply,
      ...overrides
    } as unknown as Message,
    reply,
    edit
  };
}

describe("review-mode Discord message workflow", () => {
  it("creates a visible status before async SuperDocs and persists a safe proposal", async () => {
    const test = await harness();
    const item = message();
    const events: string[] = [];
    item.reply.mockImplementation(async () => {
      events.push("reply");
      return { id: "review-message-1", edit: item.edit };
    });
    vi.mocked(test.reviewClient.startReview).mockImplementation(async () => {
      events.push("superdocs");
      return { jobId: "opaque-job" };
    });
    test.handler(item.value);
    await test.queue.waitForIdle(1_000);
    expect(events).toEqual(["reply", "superdocs"]);
    expect(test.editDocument).not.toHaveBeenCalled();
    expect(test.reviewClient.startReview).toHaveBeenCalledWith({
      sessionId: "session-1",
      instruction: "Change the deadline from 15 to 30 days."
    });
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "awaiting_approval",
      pendingReviewId: expect.any(String),
      pendingReviewMessageId: "review-message-1",
      editCount: 0
    });
    const pending = await test.reviewStore.read("document-1");
    expect(pending).toMatchObject({
      status: "pending",
      changeIds: ["change-1"],
      discordReviewMessageId: "review-message-1"
    });
    expect(JSON.stringify(pending)).not.toContain("<p>");
    const proposal = (item.edit.mock.calls as unknown[][]).at(-1)?.[0] as {
      content: string;
    };
    expect(proposal.content).toContain("Changes ready for review");
    expect(proposal.content).toContain("＠everyone");
    expect(proposal.content).not.toContain("opaque-job");
    expect(proposal.content.length).toBeLessThanOrEqual(2_000);
  });

  it("blocks later edits while approval is pending", async () => {
    const test = await harness();
    test.handler(message().value);
    await test.queue.waitForIdle(1_000);
    const later = message({ id: "instruction-2" });
    test.handler(later.value);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const laterReply = (later.reply.mock.calls as unknown[][])[0]?.[0] as { content: string };
    expect(laterReply.content).toContain("Approve or reject");
    expect(test.reviewClient.startReview).toHaveBeenCalledOnce();
  });

  it("does not call SuperDocs if the processing reply fails", async () => {
    const test = await harness();
    const item = message();
    item.reply.mockRejectedValueOnce(new Error("Discord unavailable"));
    test.handler(item.value);
    await test.queue.waitForIdle(1_000);
    expect(test.reviewClient.startReview).not.toHaveBeenCalled();
  });

  it("pauses continue_prompt safely and does not treat it as a change batch", async () => {
    const test = await harness();
    vi.mocked(test.reviewClient.pollJob).mockResolvedValueOnce({
      status: "awaiting_approval",
      metadata: { awaiting_kind: "continue_prompt" }
    });
    const item = message();
    test.handler(item.value);
    await test.queue.waitForIdle(1_000);
    expect(await test.storage.readMetadata("document-1")).toMatchObject({
      status: "review_failed",
      editCount: 0,
      lastReviewErrorCategory: "continue_prompt_unsupported"
    });
    expect((await test.reviewStore.read("document-1"))?.status).toBe("ambiguous");
    const pausedMessage = (item.edit.mock.calls as unknown[][]).at(-1)?.[0] as {
      content: string;
    };
    expect(pausedMessage.content).toContain("not supported");
    expect(test.reviewClient.decideReview).not.toHaveBeenCalled();

    const later = message({ id: "instruction-2" });
    test.handler(later.value);
    await test.queue.waitForIdle(1_000);
    const blockedMessage = (later.edit.mock.calls as unknown[][]).at(-1)?.[0] as {
      content: string;
    };
    expect(blockedMessage.content).toContain("investigated manually");
    expect(test.reviewClient.startReview).toHaveBeenCalledOnce();
  });
});
