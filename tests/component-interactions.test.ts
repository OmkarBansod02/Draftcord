import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createComponentInteractionHandler } from "../src/discord/component-interactions.js";
import { createInteractionHandler } from "../src/discord/interactions.js";
import type { DiscordInteraction } from "../src/discord/types.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createReviewStore } from "../src/documents/review-store.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import type { SuperDocsReviewClient } from "../src/superdocs/review-client.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-components-"));
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
    status: "ready",
    superdocsSessionId: "session-1",
    discordThreadId: "thread-1",
    modeControlMessageId: "control-1"
  });
  const registry = createDocumentWorkspaceRegistry({ storage, logger });
  registry.register(metadata);
  const editThreadMessage = vi.fn(async () => undefined);
  const createThreadMessage = vi.fn(async () => ({ id: "message-new" }));
  const followup = vi.fn(async () => undefined);
  const reviewClient: SuperDocsReviewClient = {
    startReview: vi.fn(),
    getJob: vi.fn(),
    pollJob: vi.fn(async () => ({ status: "completed" as const })),
    decideReview: vi.fn()
  };
  const reviewStore = createReviewStore({ storage, logger });
  const component = createComponentInteractionHandler({
    config: { applicationId: "app-1", ownerUserId: "owner-1", guildId: "guild-1" },
    logger,
    storage,
    registry,
    reviewStore,
    activity: createEditActivityRepository({ storage, logger }),
    reviewClient,
    discordClient: { editThreadMessage, createThreadMessage },
    followup
  });
  return {
    storage,
    reviewStore,
    reviewClient,
    component,
    editThreadMessage,
    followup,
    logger,
    registry
  };
}

function modeInteraction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return {
    id: "interaction-1",
    application_id: "app-1",
    type: 3,
    token: "transient-token",
    guild_id: "guild-1",
    channel_id: "thread-1",
    member: { user: { id: "owner-1" } },
    message: { id: "control-1" },
    data: { custom_id: "draftcord:mode:auto_apply:document-1", component_type: 2 },
    ...overrides
  };
}

function reviewInteraction(overrides: Partial<DiscordInteraction> = {}): DiscordInteraction {
  return modeInteraction({
    message: { id: "review-message-1" },
    data: {
      custom_id: "draftcord:review:approve:review-1",
      component_type: 2
    },
    ...overrides
  });
}

describe("Discord component interactions", () => {
  it("acknowledges a mode change with type 6, updates metadata, and redraws active controls", async () => {
    const context = await harness();
    const result = context.component.handle(modeInteraction());
    expect(result?.response).toEqual({ type: 6 });
    await result?.afterResponse?.();
    expect((await context.storage.readMetadata("document-1")).editMode).toBe("auto_apply");
    expect(context.editThreadMessage).toHaveBeenCalledOnce();
    const components = (context.editThreadMessage.mock.calls as unknown[][])[0]?.[3] as
      | Array<{ components: Array<Record<string, unknown>> }>
      | undefined;
    expect(components?.[0]?.components[0]).toMatchObject({
      label: "Auto Apply",
      disabled: true
    });
    expect(context.followup).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Auto Apply") })
    );
  });

  it("denies a wrong owner ephemerally before background processing", async () => {
    const context = await harness();
    const result = context.component.handle(modeInteraction({
      member: { user: { id: "other-user" } }
    }));
    expect(result?.response).toMatchObject({ type: 4, data: { flags: 64 } });
    expect(result?.afterResponse).toBeUndefined();
    expect(context.editThreadMessage).not.toHaveBeenCalled();
  });

  it("rejects forged wrong-thread controls and blocks changes during review", async () => {
    const context = await harness();
    const forged = context.component.handle(modeInteraction({ channel_id: "thread-other" }));
    expect(forged?.response.type).toBe(6);
    await forged?.afterResponse?.();
    expect((await context.storage.readMetadata("document-1")).editMode).toBe("review");
    expect(context.editThreadMessage).not.toHaveBeenCalled();

    await context.storage.updateMetadata("document-1", { status: "awaiting_approval" });
    const blocked = context.component.handle(modeInteraction());
    await blocked?.afterResponse?.();
    expect((await context.storage.readMetadata("document-1")).editMode).toBe("review");
  });

  it("handles unknown custom IDs safely", async () => {
    const context = await harness();
    expect(context.component.handle(modeInteraction({
      data: { custom_id: "draftcord:unknown:value", component_type: 2 }
    }))?.response).toMatchObject({ type: 4, data: { flags: 64 } });
  });

  it("transitions pending to decision processing only from an identified review component", async () => {
    const context = await harness();
    const now = new Date().toISOString();
    await context.reviewStore.create({
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
      status: "pending",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    await context.storage.updateMetadata("document-1", {
      status: "awaiting_approval",
      pendingReviewId: "review-1",
      pendingReviewMessageId: "review-message-1"
    });

    const missingIdentity = context.component.handle(reviewInteraction({
      id: undefined,
      token: undefined
    }));
    expect(missingIdentity?.response).toMatchObject({ type: 4, data: { flags: 64 } });
    expect((await context.reviewStore.read("document-1"))?.status).toBe("pending");
    expect(context.reviewClient.decideReview).not.toHaveBeenCalled();

    vi.mocked(context.reviewClient.decideReview).mockImplementationOnce(async () => {
      expect(await context.reviewStore.read("document-1")).toMatchObject({
        status: "decision_processing",
        decisionInteractionId: "interaction-1"
      });
    });
    const actualClick = context.component.handle(reviewInteraction());
    expect(actualClick?.response).toEqual({ type: 6 });
    expect((await context.reviewStore.read("document-1"))?.status).toBe("pending");
    await actualClick?.afterResponse?.();
    expect(context.reviewClient.decideReview).toHaveBeenCalledOnce();
    expect(await context.reviewStore.read("document-1")).toMatchObject({
      status: "completed",
      decisionInteractionId: "interaction-1"
    });
  });

  it("routes type 3 through the HTTP handler while command interactions still work", () => {
    const componentHandler = {
      handle: vi.fn(() => ({ response: { type: 6 as const } }))
    };
    const handler = createInteractionHandler({
      config: {
        applicationId: "app-1",
        botToken: "bot-token",
        ownerUserId: "owner-1",
        guildId: "guild-1",
        documentChannelId: "channel-1",
        superdocs: {
          apiKey: "key",
          apiBaseUrl: "https://superdocs.example/v1",
          modelTier: "core",
          thinkingDepth: "balanced"
        }
      },
      logger: pino({ level: "silent" }),
      componentHandler
    });
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    handler({ body: modeInteraction() } as never, { status } as never, vi.fn());
    expect(componentHandler.handle).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith({ type: 6 });

    componentHandler.handle.mockReturnValueOnce(undefined as never);
    handler({ body: { type: 2, data: { name: "ping" } } } as never, { status } as never, vi.fn());
    expect(json).toHaveBeenLastCalledWith(expect.objectContaining({ type: 4 }));
  });
});
