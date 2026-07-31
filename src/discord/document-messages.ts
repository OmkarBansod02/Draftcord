import type { Logger } from "pino";
import type { Message } from "discord.js";

import type {
  EditActivityRecord,
  EditActivityRepository
} from "../documents/edit-activity.js";
import { sanitizeActivityText } from "../documents/edit-activity.js";
import type { DocumentEditQueue } from "../documents/edit-queue.js";
import type {
  DocumentStorage,
  StoredDocumentMetadata
} from "../documents/document-storage.js";
import type { DocumentWorkspaceRegistry } from "../documents/workspace-registry.js";
import {
  createReviewMessageWorkflow,
  type ReviewMessageWorkflow
} from "../documents/review-workflow.js";
import type { ReviewStore } from "../documents/review-store.js";
import type { SuperDocsReviewClient } from "../superdocs/review-client.js";
import type { DiscordComponentMessageClient } from "./api.js";
import {
  SuperDocsClientError,
  type SuperDocsEditingClient
} from "../superdocs/client.js";

export const MAX_DISCORD_EDIT_INSTRUCTION_LENGTH = 8_000;
const MAX_DISCORD_MESSAGE_LENGTH = 2_000;
const ALLOWED_MENTIONS = { parse: [] as never[], repliedUser: false };

export interface DocumentMessageHandlerConfig {
  guildId: string;
  ownerUserId: string;
}

export interface DocumentMessageHandlerDependencies {
  config: DocumentMessageHandlerConfig;
  logger: Logger;
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  activity: EditActivityRepository;
  queue: DocumentEditQueue;
  superdocsClient: SuperDocsEditingClient;
  reviewStore?: ReviewStore;
  reviewClient?: SuperDocsReviewClient;
  reviewWorkflow?: ReviewMessageWorkflow;
  discordClient?: DiscordComponentMessageClient;
}

function safeText(value: string, maximumLength: number): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("@", "＠")
    .trim();
  if (normalized.length <= maximumLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function discordContent(value: string): string {
  return safeText(value, MAX_DISCORD_MESSAGE_LENGTH - 1);
}

function errorCategory(error: unknown): string {
  if (error instanceof SuperDocsClientError) return error.category;
  return "unexpected_edit_failure";
}

function unavailableMessage(metadata: StoredDocumentMetadata): string {
  if (!metadata.superdocsSessionId) {
    return "⚠️ This document workspace is missing its SuperDocs session mapping and cannot be edited.";
  }
  return "⏳ This document workspace is temporarily unavailable for editing. Please try again after its current setup or recovery step finishes.";
}

function finalSuccessMessage(input: {
  instruction: string;
  summary: string;
  changedSectionCount: number;
  editNumber: number;
}): string {
  return discordContent(
    [
      "✅ Document updated",
      "",
      "Instruction:",
      safeText(input.instruction, 550),
      "",
      "Summary:",
      safeText(input.summary, 750),
      "",
      `Changed sections: ${input.changedSectionCount}`,
      `Edit number: ${input.editNumber}`,
      "",
      "The revised document is saved in the active SuperDocs session."
    ].join("\n")
  );
}

function finalNoChangeMessage(instruction: string, response?: string): string {
  return discordContent(
    [
      "ℹ️ No document changes applied",
      "",
      "Instruction:",
      safeText(instruction, 550),
      "",
      "SuperDocs response:",
      safeText(response ?? "No document changes were needed.", 850)
    ].join("\n")
  );
}

function finalFailureMessage(activityId: string, approvalRequired: boolean): string {
  if (approvalRequired) {
    return discordContent(
      [
        "⚠️ Document edit needs approval",
        "",
        "No edit was reported as applied. Approval workflows are not supported in this phase.",
        "Send a new instruction after the workspace has been reviewed.",
        "",
        `Reference: ${activityId.slice(0, 8)}`
      ].join("\n")
    );
  }
  return discordContent(
    [
      "❌ Document edit failed",
      "",
      "The original document and existing SuperDocs session were preserved.",
      "Send a new instruction to retry.",
      "",
      `Reference: ${activityId.slice(0, 8)}`
    ].join("\n")
  );
}

async function safeReply(message: Message, content: string): Promise<void> {
  await message.reply({ content: discordContent(content), allowedMentions: ALLOWED_MENTIONS });
}

export function createDocumentMessageHandler({
  config,
  logger,
  storage,
  registry,
  activity,
  queue,
  superdocsClient,
  reviewStore,
  reviewClient,
  discordClient,
  reviewWorkflow = reviewStore && reviewClient
    ? createReviewMessageWorkflow({
        config,
        logger,
        storage,
        registry,
        activity,
        queue,
        reviewStore,
        reviewClient,
        discordClient
      })
    : undefined
}: DocumentMessageHandlerDependencies): (message: Message) => void {
  const claimedMessageIds = new Set<string>();

  async function updateStatus(
    message: Message,
    statusMessage: Awaited<ReturnType<Message["reply"]>>,
    content: string,
    superdocsCompleted: boolean
  ): Promise<void> {
    try {
      await statusMessage.edit({
        content: discordContent(content),
        allowedMentions: ALLOWED_MENTIONS
      });
      logger.info(
        {
          event: "discord_edit_status_updated",
          discordMessageId: message.id,
          discordThreadId: message.channelId
        },
        "Discord edit status updated"
      );
    } catch {
      logger.error(
        {
          event: "document_edit_failed",
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          errorCategory: "discord_status_edit_failed"
        },
        "Discord edit status could not be updated"
      );
      if (!superdocsCompleted || !message.channel.isSendable()) return;
      try {
        await message.channel.send({
          content:
            "✅ The document edit completed, but Draftcord could not update its original status reply.",
          allowedMentions: ALLOWED_MENTIONS
        });
      } catch {
        // One fallback delivery is the maximum; the completed edit is never repeated.
      }
    }
  }

  async function runEdit(
    message: Message,
    metadataSnapshot: StoredDocumentMetadata,
    instruction: string,
    activityId: string,
    statusPromise: Promise<Awaited<ReturnType<Message["reply"]>>>
  ): Promise<void> {
    const logContext = {
      documentId: metadataSnapshot.documentId,
      discordMessageId: message.id,
      discordThreadId: message.channelId,
      ownerUserId: config.ownerUserId
    };
    let statusMessage: Awaited<ReturnType<Message["reply"]>> | undefined;
    let activityStarted = false;

    try {
      const existing = await activity.getState(
        metadataSnapshot.documentId,
        message.id
      );
      try {
        statusMessage = await statusPromise;
      } catch {
        logger.error(
          {
            event: "document_edit_failed",
            ...logContext,
            errorCategory: "discord_status_create_failed"
          },
          "Discord edit status could not be created"
        );
        if (existing.state === "none") {
          const now = new Date().toISOString();
          await activity.append(metadataSnapshot.documentId, {
            activityId,
            type: "document_edit",
            discordMessageId: message.id,
            discordThreadId: message.channelId,
            requestedByUserId: config.ownerUserId,
            status: "failed",
            createdAt: now,
            completedAt: now,
            errorCategory: "discord_status_create_failed"
          });
        }
        return;
      }

      if (existing.state === "terminal") {
        logger.info(
          { event: "duplicate_edit_ignored", ...logContext },
          "Duplicate document edit ignored"
        );
        await updateStatus(
          message,
          statusMessage,
          "ℹ️ This Discord message was already processed. No second document edit was sent.",
          false
        );
        return;
      }
      if (existing.state === "started") {
        logger.warn(
          { event: "ambiguous_edit_not_replayed", ...logContext },
          "Ambiguous document edit was not replayed"
        );
        await updateStatus(
          message,
          statusMessage,
          "⚠️ This edit may have completed before Draftcord restarted. It was not replayed to avoid a duplicate change and requires manual investigation.",
          false
        );
        return;
      }

      const metadata = await storage.readMetadata(metadataSnapshot.documentId);
      const locallyQueuedEdit = queue.has(metadata.documentId);
      if (
        metadata.discordThreadId !== message.channelId ||
        !metadata.superdocsSessionId ||
        (!["ready", "edit_failed"].includes(metadata.status) &&
          !(metadata.status === "editing" && locallyQueuedEdit))
      ) {
        registry.register(metadata);
        await updateStatus(
          message,
          statusMessage,
          unavailableMessage(metadata),
          false
        );
        return;
      }

      const createdAt = new Date().toISOString();
      const startedRecord: EditActivityRecord = {
        activityId,
        type: "document_edit",
        discordMessageId: message.id,
        discordThreadId: message.channelId,
        requestedByUserId: config.ownerUserId,
        instruction,
        status: "started",
        createdAt
      };
      await activity.append(metadata.documentId, startedRecord);
      activityStarted = true;

      const editingMetadata = await storage.updateMetadata(metadata.documentId, {
        status: "editing",
        lastEditErrorCategory: null
      });
      registry.register(editingMetadata);
      const startedAt = Date.now();
      logger.info(
        { event: "document_edit_started", ...logContext },
        "Document edit started"
      );

      const result = await superdocsClient.editDocument({
        sessionId: metadata.superdocsSessionId,
        instruction
      });
      const changedSectionCount = result.documentChanges?.chunkDiffs.length ?? 0;
      logger.info(
        {
          event: "superdocs_edit_completed",
          ...logContext,
          changedSectionCount,
          durationMs: Date.now() - startedAt
        },
        "SuperDocs edit completed"
      );

      if (result.documentChanges?.requiresApproval) {
        throw new SuperDocsClientError(
          "edit_approval_required",
          "SuperDocs unexpectedly required approval"
        );
      }

      const completedAt = new Date().toISOString();
      if (changedSectionCount > 0) {
        const summary = sanitizeActivityText(
          result.documentChanges?.changesSummary ??
            result.response ??
            "SuperDocs applied the requested document changes.",
          1_000
        );
        const editNumber = (metadata.editCount ?? 0) + 1;
        const readyMetadata = await storage.updateMetadata(metadata.documentId, {
          status: "ready",
          editCount: editNumber,
          lastEditedAt: completedAt,
          lastEditDiscordMessageId: message.id,
          lastEditSummary: summary,
          lastEditErrorCategory: null
        });
        registry.register(readyMetadata);
        await activity.append(metadata.documentId, {
          ...startedRecord,
          instruction: undefined,
          status: "succeeded",
          completedAt,
          changesSummary: summary,
          changedSectionCount
        });
        await updateStatus(
          message,
          statusMessage,
          finalSuccessMessage({
            instruction,
            summary,
            changedSectionCount,
            editNumber
          }),
          true
        );
        return;
      }

      const response = sanitizeActivityText(
        result.response ?? "SuperDocs reported no document changes.",
        1_000
      );
      const readyMetadata = await storage.updateMetadata(metadata.documentId, {
        status: "ready",
        lastEditDiscordMessageId: message.id,
        lastEditSummary: response,
        lastEditErrorCategory: null
      });
      registry.register(readyMetadata);
      await activity.append(metadata.documentId, {
        ...startedRecord,
        instruction: undefined,
        status: "no_change",
        completedAt,
        changesSummary: response,
        changedSectionCount: 0
      });
      logger.info(
        { event: "document_edit_no_change", ...logContext },
        "Document edit completed without changes"
      );
      await updateStatus(
        message,
        statusMessage,
        finalNoChangeMessage(instruction, result.response),
        true
      );
    } catch (error) {
      const category = errorCategory(error);
      if (activityStarted) {
        const completedAt = new Date().toISOString();
        await activity
          .append(metadataSnapshot.documentId, {
            activityId,
            type: "document_edit",
            discordMessageId: message.id,
            discordThreadId: message.channelId,
            requestedByUserId: config.ownerUserId,
            status: "failed",
            createdAt: completedAt,
            completedAt,
            errorCategory: category
          })
          .catch(() => undefined);
        const failedMetadata = await storage
          .updateMetadata(metadataSnapshot.documentId, {
            status: "edit_failed",
            lastEditDiscordMessageId: message.id,
            lastEditErrorCategory: category
          })
          .catch(() => undefined);
        if (failedMetadata) registry.register(failedMetadata);
      }
      logger.error(
        { event: "document_edit_failed", ...logContext, errorCategory: category },
        "Document edit failed"
      );
      if (statusMessage) {
        await updateStatus(
          message,
          statusMessage,
          finalFailureMessage(activityId, category === "edit_approval_required"),
          false
        );
      }
    } finally {
      claimedMessageIds.delete(message.id);
    }
  }

  return (message) => {
    if (
      message.guildId !== config.guildId ||
      message.author.bot ||
      Boolean(message.webhookId) ||
      message.system ||
      !message.channel.isThread()
    ) {
      return;
    }

    const metadata = registry.resolve(message.channelId);
    if (!metadata || message.author.id !== config.ownerUserId) return;

    const instruction = message.content.trim();
    if (!instruction) return;

    if (metadata.editMode === "review") {
      if (!reviewWorkflow) {
        void safeReply(
          message,
          "⚠️ Review Mode is temporarily unavailable. No SuperDocs request was sent."
        ).catch(() => undefined);
        return;
      }
      if (
        !metadata.superdocsSessionId ||
        !["ready", "edit_failed", "review_failed"].includes(metadata.status)
      ) {
        const content = ["awaiting_approval", "approval_processing"].includes(metadata.status)
          ? "⏳ Approve or reject the current proposal before sending another document edit."
          : unavailableMessage(metadata);
        void safeReply(message, content).catch(() => undefined);
        return;
      }
      reviewWorkflow.submit(message, metadata, instruction);
      return;
    }

    if (claimedMessageIds.has(message.id)) {
      logger.info(
        {
          event: "duplicate_edit_ignored",
          documentId: metadata.documentId,
          discordMessageId: message.id,
          discordThreadId: message.channelId
        },
        "Duplicate document edit ignored"
      );
      return;
    }

    if (instruction.length > MAX_DISCORD_EDIT_INSTRUCTION_LENGTH) {
      void safeReply(
        message,
        `❌ Edit instructions must be ${MAX_DISCORD_EDIT_INSTRUCTION_LENGTH.toLocaleString("en-US")} characters or fewer.`
      ).catch(() => undefined);
      return;
    }

    if (
      !metadata.superdocsSessionId ||
      (!["ready", "edit_failed"].includes(metadata.status) &&
        !(metadata.status === "editing" && queue.has(metadata.documentId)))
    ) {
      void safeReply(message, unavailableMessage(metadata)).catch(() => undefined);
      return;
    }

    logger.info(
      {
        event: "document_message_received",
        documentId: metadata.documentId,
        discordMessageId: message.id,
        discordThreadId: message.channelId,
        ownerUserId: config.ownerUserId
      },
      "Document edit message received"
    );

    claimedMessageIds.add(message.id);
    const activityId = activity.createActivityId();
    let statusPromise!: Promise<Awaited<ReturnType<Message["reply"]>>>;
    const queued = queue.enqueue(metadata.documentId, () =>
      runEdit(
        message,
        metadata,
        instruction,
        activityId,
        statusPromise
      )
    );

    if (!queued.accepted) {
      const now = new Date().toISOString();
      void activity
        .append(metadata.documentId, {
          activityId,
          type: "document_edit",
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          requestedByUserId: config.ownerUserId,
          instruction,
          status: "failed",
          createdAt: now,
          completedAt: now,
          errorCategory: "queue_full"
        })
        .finally(() => claimedMessageIds.delete(message.id));
      logger.warn(
        {
          event: "document_edit_failed",
          documentId: metadata.documentId,
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          errorCategory: "queue_full"
        },
        "Document edit queue is full"
      );
      void safeReply(
        message,
        "⏳ This document has reached its edit queue limit. Please send the instruction again after the pending edits finish."
      ).catch(() => undefined);
      return;
    }

    const position = queued.position ?? 0;
    void message.channel.sendTyping().catch(() => undefined);
    statusPromise = message.reply({
      content:
        position === 0
          ? "✍️ Draftcord is editing the document…"
          : `⏳ Draftcord queued this edit. Queue position: ${position}.`,
      allowedMentions: ALLOWED_MENTIONS
    });
    void statusPromise.then(() => {
      logger.info(
        {
          event: "discord_edit_status_created",
          documentId: metadata.documentId,
          discordMessageId: message.id,
          discordThreadId: message.channelId
        },
        "Discord edit status created"
      );
      if (position > 0) {
        logger.info(
          {
            event: "document_edit_queued",
            documentId: metadata.documentId,
            discordMessageId: message.id,
            discordThreadId: message.channelId,
            queuePosition: position
          },
          "Document edit queued"
        );
      }
    }).catch(() => undefined);
  };
}
