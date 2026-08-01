import type { Logger } from "pino";

import {
  SuperDocsReviewError,
  type SuperDocsReviewClient
} from "../superdocs/review-client.js";
import type { DocumentStorage } from "./document-storage.js";
import type { ReviewStore } from "./review-store.js";
import type { DocumentWorkspaceRegistry } from "./workspace-registry.js";

export async function reconcilePendingReviews({
  storage,
  registry,
  reviewStore,
  reviewClient,
  logger
}: {
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  reviewStore: ReviewStore;
  reviewClient: SuperDocsReviewClient;
  logger: Logger;
}): Promise<void> {
  const reviews = await reviewStore.list();
  const reviewDocumentIds = new Set(reviews.map((review) => review.documentId));

  for (const review of reviews) {
    if (review.status === "generating" || review.status === "decision_processing") {
      const interruptedDecision = review.status === "decision_processing";
      const recoveryStatus = interruptedDecision
        ? "reconciliation_required"
        : "failed";
      const recoveryCategory = interruptedDecision
        ? "interrupted_decision_reconciliation"
        : "interrupted_review_generation";
      await reviewStore.replace({
        ...review,
        status: recoveryStatus,
        safeErrorCategory: recoveryCategory
      }, [review.status]).catch(() => undefined);
      const metadata = await storage.updateMetadata(review.documentId, {
        status: "review_failed",
        pendingReviewId: null,
        pendingReviewMessageId: null,
        lastReviewErrorCategory: recoveryCategory
      }).catch(() => undefined);
      if (metadata) registry.register(metadata);
      logger.warn(
        {
          event: "ambiguous_review_not_replayed",
          documentId: review.documentId,
          reviewId: review.reviewId,
          errorCategory: recoveryCategory
        },
        interruptedDecision
          ? "Interrupted review decision requires reconciliation and was not replayed"
          : "Interrupted review generation failed safely and was not replayed"
      );
      continue;
    }
    if (review.status !== "pending") continue;

    if (Date.parse(review.expiresAt) <= Date.now()) {
      await reviewStore.replace({
        ...review,
        status: "expired",
        safeErrorCategory: "review_expired"
      }, ["pending"]).catch(() => undefined);
      const metadata = await storage.updateMetadata(review.documentId, {
        status: "review_failed",
        pendingReviewId: null,
        pendingReviewMessageId: null,
        lastReviewErrorCategory: "review_expired"
      }).catch(() => undefined);
      if (metadata) registry.register(metadata);
      logger.info(
        { event: "review_expired", documentId: review.documentId, reviewId: review.reviewId },
        "Pending review expired during startup reconciliation"
      );
      continue;
    }

    try {
      const job = await reviewClient.getJob(review.superdocsJobId);
      if (
        job.status !== "awaiting_approval" ||
        job.metadata?.awaiting_kind === "continue_prompt"
      ) {
        await reviewStore.replace({
          ...review,
          status: "ambiguous",
          safeErrorCategory: "review_job_state_changed"
        }, ["pending"]);
        const metadata = await storage.updateMetadata(review.documentId, {
          status: "review_failed",
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastReviewErrorCategory: "review_job_state_changed"
        });
        registry.register(metadata);
      }
    } catch (error) {
      if (
        error instanceof SuperDocsReviewError &&
        error.category === "review_poll_not_found"
      ) {
        await reviewStore.replace({
          ...review,
          status: "expired",
          safeErrorCategory: "review_job_expired"
        }, ["pending"]).catch(() => undefined);
        const metadata = await storage.updateMetadata(review.documentId, {
          status: "review_failed",
          pendingReviewId: null,
          pendingReviewMessageId: null,
          lastReviewErrorCategory: "review_job_expired"
        }).catch(() => undefined);
        if (metadata) registry.register(metadata);
      }
      // A transient reconciliation failure leaves valid unexpired controls in
      // place; the click path validates the job again before deciding.
    }
  }

  for (const metadata of registry.list()) {
    if (
      ["review_generating", "approval_processing"].includes(metadata.status) &&
      !reviewDocumentIds.has(metadata.documentId)
    ) {
      const failed = await storage.updateMetadata(metadata.documentId, {
        status: "review_failed",
        pendingReviewId: null,
        pendingReviewMessageId: null,
        lastReviewErrorCategory: "interrupted_operation"
      }).catch(() => undefined);
      if (failed) registry.register(failed);
      logger.warn(
        {
          event: "ambiguous_review_not_replayed",
          documentId: metadata.documentId,
          errorCategory: "interrupted_operation"
        },
        "Interrupted review metadata was not replayed"
      );
    }
  }
}
