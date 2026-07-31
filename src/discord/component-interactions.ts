import type { Logger } from "pino";

import {
  sendInteractionFollowup,
  type DiscordComponentMessageClient
} from "./api.js";
import {
  createModeComponents
} from "./review-components.js";
import { createWorkspaceWelcomeMessage } from "./document-threads.js";
import type {
  DiscordInteraction,
  DiscordInteractionResponse
} from "./types.js";
import type { DocumentStorage } from "../documents/document-storage.js";
import type { EditMode } from "../documents/edit-mode.js";
import type { DocumentWorkspaceRegistry } from "../documents/workspace-registry.js";
import type { ReviewStore } from "../documents/review-store.js";
import type { EditActivityRepository } from "../documents/edit-activity.js";
import { createReviewDecisionProcessor } from "../documents/review-decisions.js";
import type { SuperDocsReviewClient } from "../superdocs/review-client.js";

const MESSAGE_COMPONENT = 3;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_MESSAGE_UPDATE = 6;
const EPHEMERAL_FLAG = 1 << 6;
const BLOCKED_MODE_STATUSES = new Set([
  "editing",
  "review_generating",
  "awaiting_approval",
  "approval_processing"
]);

export interface ComponentInteractionResult {
  response: DiscordInteractionResponse;
  afterResponse?: () => Promise<void>;
}

export interface ComponentInteractionHandler {
  handle(interaction: DiscordInteraction): ComponentInteractionResult | undefined;
}

function ephemeral(content: string): DiscordInteractionResponse {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content,
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] }
    }
  };
}

function userId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

type ParsedControl =
  | { kind: "mode"; mode: EditMode; documentId: string }
  | { kind: "review"; decision: "approve" | "reject"; reviewId: string };

export function parseDraftcordCustomId(customId: string): ParsedControl | undefined {
  const mode = /^draftcord:mode:(auto_apply|review):([A-Za-z0-9_-]{1,64})$/.exec(customId);
  if (mode) {
    return {
      kind: "mode",
      mode: mode[1] as EditMode,
      documentId: mode[2] as string
    };
  }
  const review = /^draftcord:review:(approve|reject):([A-Za-z0-9_-]{1,64})$/.exec(customId);
  if (review) {
    return {
      kind: "review",
      decision: review[1] as "approve" | "reject",
      reviewId: review[2] as string
    };
  }
  return undefined;
}

export function createComponentInteractionHandler({
  config,
  logger,
  storage,
  registry,
  reviewStore,
  activity,
  reviewClient,
  discordClient,
  followup = sendInteractionFollowup
}: {
  config: {
    applicationId: string;
    ownerUserId: string;
    guildId: string;
  };
  logger: Logger;
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  reviewStore: ReviewStore;
  activity: EditActivityRepository;
  reviewClient: SuperDocsReviewClient;
  discordClient: DiscordComponentMessageClient;
  followup?: typeof sendInteractionFollowup;
}): ComponentInteractionHandler {
  const modeLocks = new Set<string>();
  const decisions = createReviewDecisionProcessor({
    config,
    logger,
    storage,
    registry,
    activity,
    reviewStore,
    reviewClient,
    discordClient
  });

  async function notify(interaction: DiscordInteraction, content: string): Promise<void> {
    if (!interaction.token) return;
    await followup({
      applicationId: config.applicationId,
      interactionToken: interaction.token,
      content,
      ephemeral: true
    }).catch(() => undefined);
  }

  return {
    handle(interaction) {
      if (interaction.type !== MESSAGE_COMPONENT) return undefined;
      const invokingUserId = userId(interaction);
      const parsed = interaction.data?.component_type === 2 && interaction.data.custom_id
        ? parseDraftcordCustomId(interaction.data.custom_id)
        : undefined;
      logger.info(
        {
          event: parsed?.kind === "review"
            ? "review_component_received"
            : "mode_component_received",
          interactionId: interaction.id,
          interactionType: interaction.type,
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          discordMessageId: interaction.message?.id,
          ownerUserId: invokingUserId
        },
        "Draftcord component interaction received"
      );

      if (!parsed) {
        return { response: ephemeral("That Draftcord control is not recognized.") };
      }
      if (
        invokingUserId !== config.ownerUserId ||
        interaction.guild_id !== config.guildId
      ) {
        return { response: ephemeral("Only the configured Draftcord owner can use this control.") };
      }
      if (interaction.application_id !== config.applicationId) {
        return { response: ephemeral("That control belongs to a different application.") };
      }
      if (!interaction.channel_id || !interaction.message?.id) {
        return { response: ephemeral("That control is missing its document context.") };
      }

      if (parsed.kind === "review") {
        const context = {
          reviewId: parsed.reviewId,
          decision: parsed.decision,
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          messageId: interaction.message.id,
          userId: invokingUserId,
          ...(interaction.id ? { interactionId: interaction.id } : {})
        };
        return {
          response: { type: DEFERRED_MESSAGE_UPDATE },
          afterResponse: async () => {
            const result = await decisions.process(context);
            await notify(interaction, result);
          }
        };
      }

      return {
        response: { type: DEFERRED_MESSAGE_UPDATE },
        afterResponse: async () => {
          const metadata = await storage.readMetadata(parsed.documentId).catch(() => undefined);
          if (
            !metadata ||
            metadata.documentId !== parsed.documentId ||
            metadata.guildId !== config.guildId ||
            metadata.uploadedByUserId !== invokingUserId ||
            metadata.discordThreadId !== interaction.channel_id ||
            metadata.modeControlMessageId !== interaction.message?.id
          ) {
            await notify(interaction, "That mode control does not match this document workspace.");
            return;
          }
          if (BLOCKED_MODE_STATUSES.has(metadata.status)) {
            await notify(
              interaction,
              "Resolve the document's current edit or review operation before changing modes."
            );
            return;
          }
          const threadId = metadata.discordThreadId as string;
          const controlMessageId = metadata.modeControlMessageId as string;
          if (modeLocks.has(metadata.documentId)) {
            await notify(interaction, "A mode change is already processing.");
            return;
          }
          if (metadata.editMode === parsed.mode) {
            await notify(interaction, `This workspace is already in ${parsed.mode === "review" ? "Review Mode" : "Auto Apply"}.`);
            return;
          }
          modeLocks.add(metadata.documentId);
          try {
            const updated = await storage.updateMetadata(metadata.documentId, {
              editMode: parsed.mode
            });
            registry.register(updated);
            try {
              await discordClient.editThreadMessage(
                threadId,
                controlMessageId,
                createWorkspaceWelcomeMessage({
                  title: metadata.title,
                  originalFilename: metadata.originalFilename,
                  documentId: metadata.documentId,
                  byteSize: metadata.byteSize,
                  chunkCount: metadata.superdocsChunkCount,
                  editMode: parsed.mode
                }),
                createModeComponents(metadata.documentId, parsed.mode)
              );
            } catch {
              const rolledBack = await storage.updateMetadata(metadata.documentId, {
                editMode: metadata.editMode
              }).catch(() => undefined);
              if (rolledBack) registry.register(rolledBack);
              await notify(interaction, "Discord could not update the mode controls, so the mode was not changed.");
              return;
            }
            logger.info(
              {
                event: "document_edit_mode_changed",
                documentId: metadata.documentId,
                discordThreadId: metadata.discordThreadId,
                discordMessageId: metadata.modeControlMessageId,
                interactionId: interaction.id,
                ownerUserId: invokingUserId,
                editMode: parsed.mode
              },
              "Document edit mode changed"
            );
            await notify(
              interaction,
              `Editing mode changed to ${parsed.mode === "review" ? "Review Mode" : "Auto Apply"}.`
            );
          } finally {
            modeLocks.delete(metadata.documentId);
          }
        }
      };
    }
  };
}
