import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Message } from "discord.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDocumentMessageHandler } from "../src/discord/document-messages.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import { createDocumentEditQueue } from "../src/documents/edit-queue.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import {
  SuperDocsClientError,
  type SuperDocsEditingClient
} from "../src/superdocs/client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function harness(maxPendingEdits = 5) {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-messages-"));
  temporaryDirectories.push(root);
  const logger = pino({ level: "silent" });
  const storage = createDocumentStorage({ rootDirectory: root });
  await storage.store(
    Buffer.from("original unchanged"),
    {
      originalFilename: "proposal.docx",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    },
    "document-1"
  );
  const metadata = await storage.updateMetadata("document-1", {
    status: "ready",
    superdocsSessionId: "existing-session",
    discordThreadId: "thread-1"
  });
  const registry = createDocumentWorkspaceRegistry({ storage, logger });
  registry.register(metadata);
  const activity = createEditActivityRepository({ storage, logger });
  const queue = createDocumentEditQueue({ maxPendingEdits });
  const superdocsClient: SuperDocsEditingClient & {
    editDocument: ReturnType<typeof vi.fn<SuperDocsEditingClient["editDocument"]>>;
  } = {
    editDocument: vi.fn<SuperDocsEditingClient["editDocument"]>(async () => ({
      response: "Updated.",
      documentChanges: {
        changesSummary: "Updated the payment deadline.",
        chunkDiffs: [{}],
        requiresApproval: false
      }
    }))
  };
  const handler = createDocumentMessageHandler({
    config: { guildId: "guild-1", ownerUserId: "owner-1" },
    logger,
    storage,
    registry,
    activity,
    queue,
    superdocsClient
  });
  return { root, storage, registry, activity, queue, superdocsClient, handler };
}

function fakeMessage(
  overrides: Record<string, unknown> = {}
): {
  message: Message;
  reply: ReturnType<typeof vi.fn>;
  statusEdit: ReturnType<typeof vi.fn>;
  threadSend: ReturnType<typeof vi.fn>;
} {
  const statusEdit = vi.fn(async () => undefined);
  const reply = vi.fn(async () => ({ edit: statusEdit }));
  const threadSend = vi.fn(async () => undefined);
  const channel = {
    isThread: () => true,
    isSendable: () => true,
    sendTyping: vi.fn(async () => undefined),
    send: threadSend,
    ...(overrides.channel as object | undefined)
  };
  const messageValue: Record<string, unknown> = {
    id: "message-1",
    guildId: "guild-1",
    channelId: "thread-1",
    content: "Change the payment deadline from 15 days to 30 days.",
    author: { id: "owner-1", bot: false },
    webhookId: null,
    system: false,
    channel,
    reply
  };
  Object.assign(messageValue, overrides, {
    channel,
    reply: overrides.reply ?? reply
  });
  const message = messageValue as unknown as Message;
  return { message, reply, statusEdit, threadSend };
}

describe("Discord document message filtering", () => {
  it.each([
    ["bot", { author: { id: "bot-1", bot: true } }],
    ["other user", { author: { id: "other-1", bot: false } }],
    ["wrong guild", { guildId: "guild-2" }],
    ["parent channel", { channel: { isThread: () => false } }],
    ["unrelated thread", { channelId: "thread-other" }],
    ["empty", { content: "   " }],
    ["attachment only", { content: "" }],
    ["webhook", { webhookId: "webhook-1" }],
    ["system", { system: true }]
  ])("ignores a %s message without calling SuperDocs", async (_name, overrides) => {
    const context = await harness();
    context.handler(fakeMessage(overrides).message);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(context.superdocsClient.editDocument).not.toHaveBeenCalled();
  });
});

describe("Discord document editing", () => {
  it("acknowledges before SuperDocs, edits the same reply, and persists success", async () => {
    const context = await harness();
    const events: string[] = [];
    const fake = fakeMessage();
    fake.reply.mockImplementation(async () => {
      events.push("reply");
      return { edit: fake.statusEdit };
    });
    context.superdocsClient.editDocument.mockImplementation(async () => {
      events.push("superdocs");
      return {
        response: "Updated.",
        documentChanges: {
          changesSummary: "Deadline changed while price stayed unchanged.",
          chunkDiffs: [{}],
          requiresApproval: false
        }
      };
    });

    context.handler(fake.message);
    await context.queue.waitForIdle(1_000);

    expect(events).toEqual(["reply", "superdocs"]);
    expect(context.superdocsClient.editDocument).toHaveBeenCalledWith({
      sessionId: "existing-session",
      instruction: "Change the payment deadline from 15 days to 30 days."
    });
    expect(fake.reply).toHaveBeenCalledOnce();
    expect(fake.reply.mock.calls[0]?.[0]).toMatchObject({
      allowedMentions: { parse: [], repliedUser: false }
    });
    expect(fake.statusEdit).toHaveBeenCalledOnce();
    const finalOptions = fake.statusEdit.mock.calls[0]?.[0];
    expect(finalOptions.content).toContain("✅ Document updated");
    expect(finalOptions.content.length).toBeLessThanOrEqual(2_000);
    expect(finalOptions.allowedMentions).toEqual({ parse: [], repliedUser: false });

    expect(await context.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      editCount: 1,
      lastEditDiscordMessageId: "message-1"
    });
    const activityText = await readFile(
      path.join(context.root, "documents", "document-1", "activity.jsonl"),
      "utf8"
    );
    expect(activityText).toContain('"status":"started"');
    expect(activityText).toContain('"status":"succeeded"');
    expect(await readFile(path.join(context.root, "documents", "document-1", "original.docx"), "utf8")).toBe("original unchanged");
  });

  it("reports no change without incrementing editCount", async () => {
    const context = await harness();
    context.superdocsClient.editDocument.mockResolvedValueOnce({
      response: "The price is already unchanged."
    });
    const fake = fakeMessage();
    context.handler(fake.message);
    await context.queue.waitForIdle(1_000);
    expect(fake.statusEdit.mock.calls[0]?.[0].content).toContain(
      "No document changes applied"
    );
    expect(await context.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      editCount: 0
    });
  });

  it("moves to edit_failed, leaves editCount unchanged, and allows a later edit", async () => {
    const context = await harness();
    context.superdocsClient.editDocument.mockRejectedValueOnce(
      new SuperDocsClientError("edit_server_error", "external details", 503)
    );
    const first = fakeMessage();
    context.handler(first.message);
    await context.queue.waitForIdle(1_000);
    expect(await context.storage.readMetadata("document-1")).toMatchObject({
      status: "edit_failed",
      editCount: 0,
      lastEditErrorCategory: "edit_server_error"
    });

    const second = fakeMessage({ id: "message-2", content: "Try a new edit." });
    context.handler(second.message);
    await context.queue.waitForIdle(1_000);
    expect(context.superdocsClient.editDocument).toHaveBeenCalledTimes(2);
    expect(await context.storage.readMetadata("document-1")).toMatchObject({
      status: "ready",
      editCount: 1
    });
  });

  it("never replays terminal or started-only Discord message IDs", async () => {
    const context = await harness();
    const first = fakeMessage();
    context.handler(first.message);
    await context.queue.waitForIdle(1_000);
    context.handler(fakeMessage().message);
    await context.queue.waitForIdle(1_000);
    expect(context.superdocsClient.editDocument).toHaveBeenCalledOnce();

    const now = new Date().toISOString();
    await context.activity.append("document-1", {
      activityId: "activity-ambiguous",
      type: "document_edit",
      discordMessageId: "message-ambiguous",
      discordThreadId: "thread-1",
      requestedByUserId: "owner-1",
      instruction: "Ambiguous edit",
      status: "started",
      createdAt: now
    });
    context.handler(fakeMessage({ id: "message-ambiguous" }).message);
    await context.queue.waitForIdle(1_000);
    expect(context.superdocsClient.editDocument).toHaveBeenCalledOnce();
  });

  it("does not call SuperDocs if the initial status reply fails", async () => {
    const context = await harness();
    const fake = fakeMessage({
      reply: vi.fn(async () => {
        throw new Error("Discord unavailable");
      })
    });
    context.handler(fake.message);
    await context.queue.waitForIdle(1_000);
    expect(context.superdocsClient.editDocument).not.toHaveBeenCalled();
  });

  it("does not repeat a successful edit when status update delivery fails", async () => {
    const context = await harness();
    const fake = fakeMessage();
    fake.statusEdit.mockRejectedValueOnce(new Error("Discord unavailable"));
    context.handler(fake.message);
    await context.queue.waitForIdle(1_000);
    expect(context.superdocsClient.editDocument).toHaveBeenCalledOnce();
    expect(fake.threadSend).toHaveBeenCalledOnce();
  });

  it("queues same-document messages in Discord event order", async () => {
    const context = await harness();
    let release!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instructions: string[] = [];
    context.superdocsClient.editDocument.mockImplementation(async ({ instruction }) => {
      instructions.push(instruction);
      if (instructions.length === 1) await firstPending;
      return {
        response: "Updated.",
        documentChanges: {
          chunkDiffs: [{}],
          requiresApproval: false
        }
      };
    });
    const first = fakeMessage({ id: "message-1", content: "First edit" });
    const second = fakeMessage({ id: "message-2", content: "Second edit" });
    context.handler(first.message);
    context.handler(second.message);
    await vi.waitFor(() => expect(instructions).toEqual(["First edit"]));
    expect(second.reply.mock.calls[0]?.[0].content).toContain("Queue position: 1");
    release();
    await context.queue.waitForIdle(1_000);
    expect(instructions).toEqual(["First edit", "Second edit"]);
  });

  it("returns a busy reply when the pending limit is full", async () => {
    const context = await harness(0);
    let release!: () => void;
    context.superdocsClient.editDocument.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          release = () => resolve({
            response: "Updated.",
            documentChanges: { chunkDiffs: [{}], requiresApproval: false }
          });
        })
    );
    context.handler(fakeMessage({ id: "message-1" }).message);
    const second = fakeMessage({ id: "message-2" });
    context.handler(second.message);
    expect(second.reply.mock.calls[0]?.[0].content).toContain("queue limit");
    expect(context.superdocsClient.editDocument).toHaveBeenCalledTimes(0);
    await vi.waitFor(() =>
      expect(context.superdocsClient.editDocument).toHaveBeenCalledOnce()
    );
    release();
    await context.queue.waitForIdle(1_000);
    expect(context.superdocsClient.editDocument).toHaveBeenCalledOnce();
  });
});
