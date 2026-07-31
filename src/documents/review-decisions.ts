import type { Logger } from "pino";

import type { DiscordComponentMessageClient } from "../discord/api.js";
import {
  disabledDecisionMessage,
  formatReviewProposal,
  createModeComponents
} from "../discord/review-components.js";
import { createWorkspaceWelcomeMessage } from "../discord/document-threads.js";
import {
  SuperDocsReviewError,
  type SuperDocsReviewClient,
  type SuperDocsReviewJob
} from "../superdocs/review-client.js";
import type { EditActivityRepository } from "./edit-activity.js";
import type { DocumentStorage } from "./document-storage.js";
import type { DocumentWorkspaceRegistry } from "./workspace-registry.js";
import {
  safeProposedChanges
} from "./review-workflow.js";
import type {
  PendingReview,
  ReviewDecision,
  ReviewStore
} from "./review-store.js";

export interface ReviewDecisionContext {
  reviewId: string;
  decision: "approve" | "reject";
  guildId: string;
  channelId: string;
  messageId: string;
  userId: string;
  interactionId?: string;
}

function decisionValue(decision: "approve" | "reject"): ReviewDecision {
  return decision === "approve" ? "approved" : "rejected";
}

function terminalResult(review: PendingReview): string {
  if (review.status === "decision_processing") {
    return "That review decision is already processing.";
  }
  if (["approved", "rejected", "completed"].includes(review.status)) {
    return "That review has already been resolved.";
  }
  if (["expired", "failed", "ambiguous"].includes(review.status)) {
    return "That review control is no longer active.";
  }
  return "That review is not ready for a decision.";
}

function jobFailure(job: SuperDocsReviewJob): Error | undefined {
  if (job.status === "failed") {
    return new SuperDocsReviewError("review_job_failed", "Review decision job failed");
  }
  if (job.status === "cancelled") {
    return new SuperDocsReviewError(
      "review_job_cancelled",
      "Review decision job was cancelled"
    );
  }
  return undefined;
}

export function createReviewDecisionProcessor({
  config,
  logger,
  storage,
  registry,
  activity,
  reviewStore,
  reviewClient,
  discordClient
}: {
  config: { ownerUserId: string; guildId: string };
  logger: Logger;
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  activity: EditActivityRepository;
  reviewStore: ReviewStore;
  reviewClient: SuperDocsReviewClient;
  discordClient: DiscordComponentMessageClient;
}): { process(context: ReviewDecisionContext): Promise<string> } {
  const locks = new Set<string>();

  async function restoreModeControls(
    metadata: Awaited<ReturnType<DocumentStorage["readMetadata"]>>
  ): Promise<void> {
    if (!metadata.discordThreadId || !metadata.modeControlMessageId) return;
    await discordClient.editThreadMessage(
      metadata.discordThreadId,
      metadata.modeControlMessageId,
      createWorkspaceWelcomeMessage({
        title: metadata.title,
        originalFilename: metadata.originalFilename,
        documentId: metadata.documentId,
        byteSize: metadata.byteSize,
        chunkCount: metadata.superdocsChunkCount,
        editMode: metadata.editMode
      }),
      createModeComponents(metadata.documentId, metadata.editMode)
    ).catch(() => undefined);
  }

  return {
    async process(context) {
      const review = await reviewStore.find(context.reviewId);
      if (!review) return "That review control is invalid or no longer available.";
      const metadata = await storage.readMetadata(review.documentId).catch(() => undefined);
      if (
        !metadata ||
        context.userId !== config.ownerUserId ||
        metadata.uploadedByUserId !== context.userId ||
        context.guildId !== config.guildId ||
        metadata.guildId !== context.guildId ||
        context.channelId !== review.discordThreadId ||
        metadata.discordThreadId !== context.channelId ||
        context.messageId !== review.discordReviewMessageId ||
        !metadata.superdocsSessionId
      ) {
        return "That review control does not match this document workspace.";
      }
      if (review.status !== "pending") {
        logger.info(
          {
            event: "duplicate_review_decision_ignored",
            documentId: metadata.documentId,
            reviewId: review.reviewId,
            decision: context.decision
          },
          "Duplicate review decision ignored"
        );
        return terminalResult(review);
      }
      if (
        metadata.pendingReviewId !== review.reviewId ||
        metadata.pendingReviewMessageId !== context.messageId
      ) {
        return "That review control does not match the active document review.";
      }
      if (Date.parse(review.expiresAt) <= Date.now()) {
        await reviewStore.replace({
          ...review,
          status: "expired",
          safeErrorCategory: "review_expired"
        }, ["pending"]).catch(() => undefined);
        const expired = await storage.updateMetadata(metadata.documentId, {
          status: "review_failed",
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastReviewErrorCategory: "review_expired"
        }).catch(() => undefined);
        if (expired) registry.register(expired);
        logger.info(
          { event: "review_expired", documentId: metadata.documentId, reviewId: review.reviewId },
          "Pending review expired"
        );
        return "That review has expired and cannot be submitted.";
      }
      if (locks.has(metadata.documentId)) return "That review decision is already processing.";
      locks.add(metadata.documentId);
      const decidedAt = new Date().toISOString();
      const decision = decisionValue(context.decision);
      let claimed: PendingReview;
      try {
        claimed = await reviewStore.replace({
          ...review,
          status: "decision_processing",
          decision,
          decidedAt
        }, ["pending"]);
      } catch {
        locks.delete(metadata.documentId);
        return "That review decision is already processing or resolved.";
      }

      logger.info(
        {
          event: "review_decision_claimed",
          documentId: metadata.documentId,
          reviewId: review.reviewId,
          discordMessageId: context.messageId,
          discordThreadId: context.channelId,
          interactionId: context.interactionId,
          ownerUserId: context.userId,
          decision: context.decision,
          proposalCount: claimed.changeIds.length
        },
        "Review decision claimed"
      );

      try {
        const processingMetadata = await storage.updateMetadata(metadata.documentId, {
          status: "approval_processing",
          lastReviewErrorCategory: null
        });
        registry.register(processingMetadata);
        await discordClient.editThreadMessage(
          context.channelId,
          context.messageId,
          context.decision === "approve"
            ? "⏳ Applying approved changes…"
            : "⏳ Rejecting proposed changes…",
          []
        );
      } catch {
        await reviewStore.replace({
          ...claimed,
          status: "pending",
          decision: undefined,
          decidedAt: undefined
        }, ["decision_processing"]).catch(() => undefined);
        const restored = await storage.updateMetadata(metadata.documentId, {
          status: "awaiting_approval",
          lastReviewErrorCategory: "discord_status_edit_failed"
        }).catch(() => undefined);
        if (restored) registry.register(restored);
        locks.delete(metadata.documentId);
        return "Discord could not lock the review controls, so no decision was sent.";
      }

      let outboundSent = false;
      try {
        await reviewClient.decideReview({
          sessionId: metadata.superdocsSessionId as string,
          jobId: claimed.superdocsJobId,
          changeIds: claimed.changeIds,
          approved: context.decision === "approve"
        });
        outboundSent = true;
        const job = await reviewClient.pollJob(claimed.superdocsJobId);
        const failure = jobFailure(job);
        if (failure) throw failure;

        if (job.status === "awaiting_approval") {
          if (job.metadata?.awaiting_kind === "continue_prompt") {
            throw new SuperDocsReviewError(
              "continue_prompt_unsupported",
              "Large edit continue prompt is unsupported"
            );
          }
          const changes = safeProposedChanges(job.metadata?.pending_changes ?? []);
          if (changes.length === 0) {
            throw new SuperDocsReviewError(
              "review_job_failed",
              "A repeated review round contained no pending changes"
            );
          }
          const nextRound = await reviewStore.replace({
            ...claimed,
            status: "pending",
            changeIds: changes.map((change) => change.changeId),
            proposedChanges: changes,
            decision: undefined,
            decidedAt: undefined,
            safeErrorCategory: undefined,
            expiresAt: new Date(Date.now() + 55 * 60_000).toISOString()
          }, ["decision_processing"]);
          const awaiting = await storage.updateMetadata(metadata.documentId, {
            status: "awaiting_approval",
            pendingReviewId: nextRound.reviewId,
            pendingReviewMessageId: nextRound.discordReviewMessageId,
            lastReviewErrorCategory: null
          });
          registry.register(awaiting);
          const proposal = formatReviewProposal(nextRound);
          await discordClient.editThreadMessage(
            context.channelId,
            context.messageId,
            proposal.content,
            proposal.components
          );
          await activity.append(metadata.documentId, {
            activityId: activity.createActivityId(),
            type: "document_review",
            reviewId: nextRound.reviewId,
            discordMessageId: nextRound.discordInstructionMessageId,
            discordThreadId: context.channelId,
            requestedByUserId: context.userId,
            status: "proposal_ready",
            createdAt: nextRound.createdAt,
            changesSummary: `${changes.length} proposed change${changes.length === 1 ? "" : "s"}`,
            changedSectionCount: changes.length
          });
          logger.info(
            {
              event: "document_proposal_ready",
              documentId: metadata.documentId,
              reviewId: nextRound.reviewId,
              discordMessageId: context.messageId,
              discordThreadId: context.channelId,
              proposalCount: changes.length
            },
            "Another document proposal round is ready"
          );
          return "A new proposal round is ready for review.";
        }

        if (job.status !== "completed") {
          throw new SuperDocsReviewError(
            "review_job_failed",
            "Review decision did not reach a terminal state"
          );
        }

        const currentMetadata = await storage.readMetadata(metadata.documentId);
        const editCount = context.decision === "approve"
          ? (currentMetadata.editCount ?? 0) + 1
          : currentMetadata.editCount ?? 0;
        const summary = context.decision === "approve"
          ? `${claimed.changeIds.length} approved proposed change${claimed.changeIds.length === 1 ? "" : "s"}`
          : "Proposed changes rejected; the document remains unchanged.";
        await reviewStore.replace({
          ...claimed,
          status: "completed",
          decision,
          decidedAt
        }, ["decision_processing"]);
        const ready = await storage.updateMetadata(metadata.documentId, {
          status: "ready",
          ...(context.decision === "approve"
            ? {
                editCount,
                lastEditedAt: decidedAt,
                lastEditDiscordMessageId: claimed.discordInstructionMessageId,
                lastEditSummary: summary
              }
            : {}),
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastReviewDecision: decision,
          lastReviewDecisionAt: decidedAt,
          lastReviewErrorCategory: null
        });
        registry.register(ready);
        await activity.append(metadata.documentId, {
          activityId: activity.createActivityId(),
          type: "document_review",
          reviewId: review.reviewId,
          discordMessageId: claimed.discordInstructionMessageId,
          discordThreadId: context.channelId,
          requestedByUserId: context.userId,
          status: decision,
          createdAt: claimed.createdAt,
          completedAt: decidedAt,
          decision,
          changesSummary: summary,
          changedSectionCount:
            context.decision === "approve" ? claimed.changeIds.length : 0
        });
        const final = context.decision === "approve"
          ? [
              "✅ Approved and applied",
              "",
              `Approved changes: ${claimed.changeIds.length}`,
              `Edit number: ${editCount}`,
              "",
              "The revised document is saved in the active SuperDocs session."
            ].join("\n")
          : [
              "❌ Proposed changes rejected",
              "",
              "No proposed changes were applied.",
              "The document remains unchanged."
            ].join("\n");
        const payload = disabledDecisionMessage(final);
        await discordClient.editThreadMessage(
          context.channelId,
          context.messageId,
          payload.content,
          payload.components
        ).catch(() => {
          logger.error(
            {
              event: "review_terminal_message_update_failed",
              documentId: metadata.documentId,
              reviewId: review.reviewId,
              discordMessageId: context.messageId,
              errorCategory: "discord_status_edit_failed"
            },
            "Completed review message could not be updated"
          );
        });
        await restoreModeControls(ready);
        logger.info(
          {
            event: decision === "approved" ? "review_approved" : "review_rejected",
            documentId: metadata.documentId,
            reviewId: review.reviewId,
            discordMessageId: context.messageId,
            proposalCount: claimed.changeIds.length
          },
          decision === "approved" ? "Review approved" : "Review rejected"
        );
        return decision === "approved"
          ? "Approved changes were applied."
          : "Proposed changes were rejected.";
      } catch (error) {
        const category = error instanceof SuperDocsReviewError
          ? error.category
          : "review_decision_unexpected";
        const ambiguousDecisionRequest = [
          "review_decision_timeout",
          "review_decision_network",
          "review_decision_server_error"
        ].includes(category);
        const ambiguous = category === "continue_prompt_unsupported" ||
          ambiguousDecisionRequest || (outboundSent &&
          category !== "review_job_failed" &&
          category !== "review_job_cancelled");
        await reviewStore.replace({
          ...claimed,
          status: ambiguous ? "ambiguous" : "failed",
          safeErrorCategory: category
        }, ["decision_processing", "pending"]).catch(() => undefined);
        const failed = await storage.updateMetadata(metadata.documentId, {
          status: "review_failed",
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastReviewErrorCategory: category
        }).catch(() => undefined);
        if (failed) registry.register(failed);
        await activity.append(metadata.documentId, {
          activityId: activity.createActivityId(),
          type: "document_review",
          reviewId: review.reviewId,
          discordMessageId: claimed.discordInstructionMessageId,
          discordThreadId: context.channelId,
          requestedByUserId: context.userId,
          status: ambiguous ? "ambiguous" : "review_failed",
          createdAt: claimed.createdAt,
          completedAt: new Date().toISOString(),
          decision,
          errorCategory: category
        }).catch(() => undefined);
        const payload = disabledDecisionMessage(
          category === "continue_prompt_unsupported"
            ? "⚠️ This large edit paused again. Continue controls are not supported, so Draftcord did not send another approval. Manual investigation is required."
            : ambiguous
            ? "⚠️ The review decision outcome is uncertain and will not be retried automatically. Manual investigation is required."
            : "❌ The review decision could not be completed. No edit count was recorded."
        );
        await discordClient.editThreadMessage(
          context.channelId,
          context.messageId,
          payload.content,
          payload.components
        ).catch(() => undefined);
        if (failed) await restoreModeControls(failed);
        logger.error(
          {
            event: "review_decision_failed",
            documentId: metadata.documentId,
            reviewId: review.reviewId,
            decision: context.decision,
            errorCategory: category
          },
          "Review decision failed"
        );
        return ambiguous
          ? "The decision outcome is uncertain and requires manual investigation."
          : "The review decision failed safely.";
      } finally {
        locks.delete(metadata.documentId);
      }
    }
  };
}
