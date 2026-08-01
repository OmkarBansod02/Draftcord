import type { Message } from "discord.js";
import type { Logger } from "pino";

import {
  formatReviewProposal,
  createWorkspaceControlComponents,
  type DiscordActionRow
} from "../discord/review-components.js";
import type { DiscordComponentMessageClient } from "../discord/api.js";
import { createWorkspaceWelcomeMessage } from "../discord/document-threads.js";
import {
  SuperDocsReviewError,
  type SuperDocsProposedChange,
  type SuperDocsReviewClient,
  type SuperDocsReviewJob
} from "../superdocs/review-client.js";
import type { EditActivityRepository } from "./edit-activity.js";
import type { DocumentEditQueue } from "./edit-queue.js";
import type {
  DocumentStorage,
  StoredDocumentMetadata
} from "./document-storage.js";
import type { DocumentWorkspaceRegistry } from "./workspace-registry.js";
import {
  isUnresolvedReview,
  sanitizeReviewText,
  type PendingReview,
  type ReviewStore,
  type SafeProposedChange
} from "./review-store.js";

const ALLOWED_MENTIONS = { parse: [] as never[], repliedUser: false };
const REVIEW_EXPIRY_MS = 55 * 60_000;

export interface ReviewMessageWorkflow {
  submit(
    message: Message,
    metadata: StoredDocumentMetadata,
    instruction: string
  ): void;
}

export function safeProposedChanges(
  changes: readonly SuperDocsProposedChange[]
): SafeProposedChange[] {
  return changes.map((change) => ({
    changeId: change.change_id,
    operation: change.operation,
    ...(change.old_html
      ? { oldText: sanitizeReviewText(change.old_html, 450) }
      : {}),
    ...(change.new_html
      ? { newText: sanitizeReviewText(change.new_html, 450) }
      : {}),
    ...(change.ai_explanation
      ? { explanation: sanitizeReviewText(change.ai_explanation, 350) }
      : {}),
    ...(change.chunk_position !== null && change.chunk_position !== undefined
      ? { chunkPosition: change.chunk_position }
      : {})
  }));
}

function errorCategory(error: unknown): string {
  return error instanceof SuperDocsReviewError
    ? error.category
    : "review_unexpected";
}

function isAmbiguousCreation(error: unknown): boolean {
  return error instanceof SuperDocsReviewError &&
    [
      "review_create_timeout",
      "review_create_network",
      "review_create_server_error",
      "review_create_invalid_response"
    ].includes(error.category);
}

async function editReviewMessage(
  statusMessage: Awaited<ReturnType<Message["reply"]>>,
  content: string,
  components: DiscordActionRow[] = []
): Promise<void> {
  await statusMessage.edit({
    content: content.slice(0, 2_000),
    components,
    allowedMentions: ALLOWED_MENTIONS
  });
}

function completedResponse(job: SuperDocsReviewJob): string {
  return sanitizeReviewText(
    job.result?.response ?? "SuperDocs proposed no document changes.",
    900
  );
}

export function createReviewMessageWorkflow({
  config,
  logger,
  storage,
  registry,
  activity,
  queue,
  reviewStore,
  reviewClient,
  discordClient
}: {
  config: { ownerUserId: string };
  logger: Logger;
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  activity: EditActivityRepository;
  queue: DocumentEditQueue;
  reviewStore: ReviewStore;
  reviewClient: SuperDocsReviewClient;
  discordClient?: DiscordComponentMessageClient;
}): ReviewMessageWorkflow {
  const claimedMessageIds = new Set<string>();

  async function fail(
    message: Message,
    metadata: StoredDocumentMetadata,
    activityId: string,
    review: PendingReview | undefined,
    statusMessage: Awaited<ReturnType<Message["reply"]>>,
    error: unknown
  ): Promise<void> {
    const category = errorCategory(error);
    // Once startReview returns a job ID, generation has not modified the
    // document: ask_every_time still requires a component decision. A GET
    // polling failure is therefore a generation failure, not an ambiguous
    // approval decision. Only an uncertain POST /chat/async creation remains
    // ambiguous here and it is never retried automatically.
    const ambiguous = isAmbiguousCreation(error);
    const now = new Date().toISOString();
    if (review) {
      await reviewStore.replace(
        {
          ...review,
          status: ambiguous ? "ambiguous" : "failed",
          safeErrorCategory: category,
          updatedAt: now
        },
        ["generating", "pending"]
      ).catch(() => undefined);
    }
    const failed = await storage.updateMetadata(metadata.documentId, {
      status: "review_failed",
      pendingReviewId: null,
      pendingReviewMessageId: null,
      lastReviewErrorCategory: category
    }).catch(() => undefined);
    if (failed) registry.register(failed);
    if (failed && discordClient && failed.discordThreadId && failed.modeControlMessageId) {
      await discordClient.editThreadMessage(
        failed.discordThreadId,
        failed.modeControlMessageId,
        createWorkspaceWelcomeMessage({
          title: failed.title,
          originalFilename: failed.originalFilename,
          documentId: failed.documentId,
          byteSize: failed.byteSize,
          chunkCount: failed.superdocsChunkCount,
          editMode: failed.editMode
        }),
        createWorkspaceControlComponents(failed.documentId, failed.editMode)
      ).catch(() => undefined);
    }
    await activity.append(metadata.documentId, {
      activityId,
      type: "document_review",
      discordMessageId: message.id,
      discordThreadId: message.channelId,
      requestedByUserId: config.ownerUserId,
      status: ambiguous ? "ambiguous" : "review_failed",
      createdAt: review?.createdAt ?? now,
      completedAt: now,
      ...(review ? { reviewId: review.reviewId } : {}),
      errorCategory: category
    }).catch(() => undefined);
    logger.error(
      {
        event: "document_review_failed",
        documentId: metadata.documentId,
        reviewId: review?.reviewId,
        discordMessageId: message.id,
        discordThreadId: message.channelId,
        errorCategory: category
      },
      "Document review generation failed"
    );
    await editReviewMessage(
      statusMessage,
      ambiguous
        ? "⚠️ The review request outcome is uncertain and was not retried. The document requires manual investigation before another edit."
        : "❌ Draftcord could not prepare a safe review proposal. No change was reported as applied; send a new instruction to retry."
    ).catch(() => undefined);
  }

  async function run(
    message: Message,
    metadataSnapshot: StoredDocumentMetadata,
    instruction: string,
    activityId: string,
    statusPromise: Promise<Awaited<ReturnType<Message["reply"]>>>
  ): Promise<void> {
    let statusMessage: Awaited<ReturnType<Message["reply"]>>;
    try {
      statusMessage = await statusPromise;
    } catch {
      logger.error(
        {
          event: "document_review_failed",
          documentId: metadataSnapshot.documentId,
          discordMessageId: message.id,
          errorCategory: "discord_status_create_failed"
        },
        "Review status message could not be created"
      );
      claimedMessageIds.delete(message.id);
      return;
    }

    let review: PendingReview | undefined;
    try {
      const previousActivity = await activity.getState(
        metadataSnapshot.documentId,
        message.id
      );
      if (previousActivity.state !== "none") {
        await editReviewMessage(
          statusMessage,
          previousActivity.state === "terminal"
            ? "ℹ️ This Discord message was already processed. No second review request was sent."
            : "⚠️ This review may have started before Draftcord restarted. It was not replayed to avoid a duplicate edit."
        );
        return;
      }

      const metadata = await storage.readMetadata(metadataSnapshot.documentId);
      const existingReview = await reviewStore.read(metadata.documentId);
      if (isUnresolvedReview(existingReview)) {
        await editReviewMessage(
          statusMessage,
          existingReview && ["ambiguous", "reconciliation_required"].includes(existingReview.status)
            ? "⚠️ An earlier review has an uncertain or paused outcome. It must be investigated manually before another document edit can start."
            : "⏳ Approve or reject the current proposal before sending another document edit."
        );
        return;
      }
      if (
        metadata.discordThreadId !== message.channelId ||
        !metadata.superdocsSessionId ||
        !["ready", "edit_failed", "review_failed"].includes(metadata.status)
      ) {
        await editReviewMessage(
          statusMessage,
          "⏳ This document workspace must resolve its current operation before another review can start."
        );
        return;
      }

      const createdAt = new Date().toISOString();
      await activity.append(metadata.documentId, {
        activityId,
        type: "document_review",
        discordMessageId: message.id,
        discordThreadId: message.channelId,
        requestedByUserId: config.ownerUserId,
        instruction,
        status: "review_started",
        createdAt
      });
      const generating = await storage.updateMetadata(metadata.documentId, {
        status: "review_generating",
        lastReviewErrorCategory: null
      });
      registry.register(generating);
      logger.info(
        {
          event: "document_review_started",
          documentId: metadata.documentId,
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          ownerUserId: config.ownerUserId
        },
        "Document review started"
      );

      const { jobId } = await reviewClient.startReview({
        sessionId: metadata.superdocsSessionId,
        instruction
      });
      const reviewId = reviewStore.createReviewId();
      const reviewMessageId = statusMessage.id;
      if (!reviewMessageId) throw new Error("Discord review message has no ID");
      review = await reviewStore.create({
        reviewId,
        documentId: metadata.documentId,
        discordThreadId: message.channelId,
        discordInstructionMessageId: message.id,
        discordReviewMessageId: reviewMessageId,
        requestedByUserId: config.ownerUserId,
        instructionPreview: sanitizeReviewText(instruction, 500),
        superdocsJobId: jobId,
        changeIds: [],
        proposedChanges: [],
        status: "generating",
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(Date.now() + REVIEW_EXPIRY_MS).toISOString()
      });
      const pollingResult = await reviewClient.pollJob(jobId);

      if (pollingResult.status === "completed") {
        const response = completedResponse(pollingResult);
        await reviewStore.replace({ ...review, status: "completed" }, ["generating"]);
        const ready = await storage.updateMetadata(metadata.documentId, {
          status: "ready",
          lastEditDiscordMessageId: message.id,
          lastEditSummary: response,
          lastReviewErrorCategory: null,
          pendingReviewId: null,
          pendingReviewMessageId: null
        });
        registry.register(ready);
        await activity.append(metadata.documentId, {
          activityId,
          type: "document_review",
          reviewId,
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          requestedByUserId: config.ownerUserId,
          status: "no_change",
          createdAt,
          completedAt: new Date().toISOString(),
          changesSummary: response,
          changedSectionCount: 0
        });
        await editReviewMessage(
          statusMessage,
          `ℹ️ No document changes proposed\n\n${response}`
        );
        return;
      }
      if (pollingResult.status === "failed") {
        throw new SuperDocsReviewError("review_job_failed", "Review job failed");
      }
      if (pollingResult.status === "cancelled") {
        throw new SuperDocsReviewError("review_job_cancelled", "Review job was cancelled");
      }
      if (pollingResult.metadata?.awaiting_kind === "continue_prompt") {
        const now = new Date().toISOString();
        await reviewStore.replace({
          ...review,
          status: "reconciliation_required",
          safeErrorCategory: "continue_prompt_unsupported",
          updatedAt: now
        }, ["generating"]);
        const paused = await storage.updateMetadata(metadata.documentId, {
          status: "review_failed",
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastReviewErrorCategory: "continue_prompt_unsupported"
        });
        registry.register(paused);
        await activity.append(metadata.documentId, {
          activityId,
          type: "document_review",
          reviewId,
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          requestedByUserId: config.ownerUserId,
          status: "reconciliation_required",
          createdAt,
          completedAt: now,
          errorCategory: "continue_prompt_unsupported"
        });
        await editReviewMessage(
          statusMessage,
          "⚠️ This large edit paused before completion. Automatic continue controls are not supported, so Draftcord did not approve or continue it. Manual investigation is required."
        );
        return;
      }

      const changes = safeProposedChanges(
        pollingResult.metadata?.pending_changes ?? []
      );
      if (changes.length === 0) {
        const response = completedResponse(pollingResult);
        await reviewStore.replace({ ...review, status: "completed" }, ["generating"]);
        const ready = await storage.updateMetadata(metadata.documentId, {
          status: "ready",
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastEditDiscordMessageId: message.id,
          lastEditSummary: response
        });
        registry.register(ready);
        await activity.append(metadata.documentId, {
          activityId,
          type: "document_review",
          reviewId,
          discordMessageId: message.id,
          discordThreadId: message.channelId,
          requestedByUserId: config.ownerUserId,
          status: "no_change",
          createdAt,
          completedAt: new Date().toISOString(),
          changesSummary: response,
          changedSectionCount: 0
        });
        await editReviewMessage(statusMessage, "ℹ️ No document changes were proposed.");
        return;
      }

      review = await reviewStore.replace({
        ...review,
        changeIds: changes.map((change) => change.changeId),
        proposedChanges: changes,
        status: "pending"
      }, ["generating"]);
      const awaiting = await storage.updateMetadata(metadata.documentId, {
        status: "awaiting_approval",
        pendingReviewId: reviewId,
        pendingReviewMessageId: reviewMessageId,
        lastReviewErrorCategory: null
      });
      registry.register(awaiting);
      if (discordClient && metadata.modeControlMessageId) {
        await discordClient.editThreadMessage(
          message.channelId,
          metadata.modeControlMessageId,
          createWorkspaceWelcomeMessage({
            title: metadata.title,
            originalFilename: metadata.originalFilename,
            documentId: metadata.documentId,
            byteSize: metadata.byteSize,
            chunkCount: metadata.superdocsChunkCount,
            editMode: metadata.editMode
          }),
          createWorkspaceControlComponents(metadata.documentId, metadata.editMode, true)
        ).catch(() => {
          logger.warn(
            {
              event: "mode_controls_disable_failed",
              documentId: metadata.documentId,
              discordThreadId: message.channelId,
              errorCategory: "discord_status_edit_failed"
            },
            "Mode controls could not be disabled during review"
          );
        });
      }
      const proposal = formatReviewProposal(review);
      await editReviewMessage(statusMessage, proposal.content, proposal.components);
      await activity.append(metadata.documentId, {
        activityId,
        type: "document_review",
        reviewId,
        discordMessageId: message.id,
        discordThreadId: message.channelId,
        requestedByUserId: config.ownerUserId,
        status: "proposal_ready",
        createdAt,
        changesSummary: `${changes.length} proposed change${changes.length === 1 ? "" : "s"}`,
        changedSectionCount: changes.length
      });
      logger.info(
        {
          event: "document_proposal_ready",
          documentId: metadata.documentId,
          reviewId,
          discordMessageId: reviewMessageId,
          discordThreadId: message.channelId,
          proposalCount: changes.length
        },
        "Document proposal ready"
      );
    } catch (error) {
      await fail(
        message,
        metadataSnapshot,
        activityId,
        review,
        statusMessage,
        error
      );
    } finally {
      claimedMessageIds.delete(message.id);
    }
  }

  return {
    submit(message, metadata, instruction) {
      if (claimedMessageIds.has(message.id)) return;
      claimedMessageIds.add(message.id);
      const activityId = activity.createActivityId();
      let statusPromise!: Promise<Awaited<ReturnType<Message["reply"]>>>;
      const queued = queue.enqueue(metadata.documentId, () =>
        run(message, metadata, instruction, activityId, statusPromise)
      );
      if (!queued.accepted) {
        claimedMessageIds.delete(message.id);
        void message.reply({
          content: "⏳ This document is busy. Resolve the current operation before sending another edit.",
          allowedMentions: ALLOWED_MENTIONS
        }).catch(() => undefined);
        return;
      }
      statusPromise = message.reply({
        content: queued.position
          ? `⏳ Draftcord queued this review request. Queue position: ${queued.position}.`
          : "🛡️ Draftcord is preparing changes for review…",
        allowedMentions: ALLOWED_MENTIONS
      });
    }
  };
}
