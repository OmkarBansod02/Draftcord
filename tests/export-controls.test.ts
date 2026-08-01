import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createComponentInteractionHandler, parseDraftcordCustomId } from "../src/discord/component-interactions.js";
import {
  createWorkspaceControlComponents,
  type ExportFormat
} from "../src/discord/review-components.js";
import type { DiscordInteraction } from "../src/discord/types.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import { createReviewStore } from "../src/documents/review-store.js";
import { createDocumentWorkspaceRegistry } from "../src/documents/workspace-registry.js";
import type { DocumentExportWorkflow } from "../src/documents/export-workflow.js";
import type { SuperDocsReviewClient } from "../src/superdocs/review-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function exportInteraction(format: ExportFormat): DiscordInteraction {
  return {
    id: `interaction-${format}`,
    application_id: "app-1",
    type: 3,
    token: "one-time-token",
    guild_id: "guild-1",
    channel_id: "thread-1",
    member: { user: { id: "owner-1" } },
    message: { id: "control-1" },
    data: {
      component_type: 2,
      custom_id: `draftcord:export:${format}:document-1`
    }
  };
}

describe("Phase 6 export controls", () => {
  it("renders DOCX and PDF controls in a second action row", () => {
    const rows = createWorkspaceControlComponents("document-1", "review");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.components.map((button) => button.label)).toEqual([
      "Auto Apply",
      "Review Mode"
    ]);
    expect(rows[1]?.components.map((button) => button.label)).toEqual([
      "Export DOCX",
      "Export PDF"
    ]);
    for (const row of rows) {
      expect(row.type).toBe(1);
      for (const button of row.components) {
        expect(button.type).toBe(2);
        expect(button.custom_id.length).toBeLessThanOrEqual(100);
      }
    }
    expect(parseDraftcordCustomId("draftcord:export:pdf:document-1")).toEqual({
      kind: "export",
      format: "pdf",
      documentId: "document-1"
    });
  });

  it("acknowledges a valid export with an ephemeral type 5 response", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-export-controls-"));
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
      status: "ready",
      superdocsSessionId: "opaque-session",
      discordThreadId: "thread-1",
      modeControlMessageId: "control-1"
    });
    const registry = createDocumentWorkspaceRegistry({ storage, logger });
    registry.register(metadata);
    const run = vi.fn(async () => undefined);
    const exportWorkflow: DocumentExportWorkflow = {
      run,
      isActive: () => false
    };
    const reviewClient: SuperDocsReviewClient = {
      startReview: vi.fn(),
      getJob: vi.fn(),
      pollJob: vi.fn(),
      decideReview: vi.fn()
    };
    const component = createComponentInteractionHandler({
      config: { applicationId: "app-1", ownerUserId: "owner-1", guildId: "guild-1" },
      logger,
      storage,
      registry,
      reviewStore: createReviewStore({ storage, logger }),
      activity: createEditActivityRepository({ storage, logger }),
      reviewClient,
      discordClient: {
        editThreadMessage: vi.fn(async () => undefined),
        createThreadMessage: vi.fn(async () => ({ id: "message-2" }))
      },
      exportWorkflow
    });

    const result = component.handle(exportInteraction("pdf"));
    expect(result?.response).toEqual({ type: 5, data: { flags: 64 } });
    await result?.afterResponse?.();
    expect(run).toHaveBeenCalledWith({
      interaction: exportInteraction("pdf"),
      documentId: "document-1",
      format: "pdf"
    });
    expect(reviewClient.decideReview).not.toHaveBeenCalled();
    expect(reviewClient.pollJob).not.toHaveBeenCalled();
  });
});
