import type { EditActivityRepository } from "./edit-activity.js";
import type { DocumentStorage } from "./document-storage.js";
import type { ReviewStatus, ReviewStore } from "./review-store.js";
import type { SuperDocsReviewClient, SuperDocsReviewJob } from "../superdocs/review-client.js";

const MANUALLY_RECOVERABLE_STATUSES = [
  "ambiguous",
  "reconciliation_required"
] as const satisfies readonly ReviewStatus[];

export interface ManualReviewRecoveryResult {
  documentId: string;
  reviewId: string;
  persistedReviewStatus: ReviewStatus;
  jobStatus: SuperDocsReviewJob["status"];
  applied: boolean;
  outcome:
    | "inspection_only"
    | "not_terminal"
    | "completed_approved"
    | "completed_rejected"
    | "failed"
    | "cancelled";
}

export async function inspectAndRecoverReview({
  documentId,
  applyKnownTerminal,
  storage,
  reviewStore,
  reviewClient,
  activity
}: {
  documentId: string;
  applyKnownTerminal: boolean;
  storage: DocumentStorage;
  reviewStore: ReviewStore;
  reviewClient: Pick<SuperDocsReviewClient, "getJob">;
  activity: EditActivityRepository;
}): Promise<ManualReviewRecoveryResult> {
  // Persisted state is always loaded and validated before any external lookup.
  const metadata = await storage.readMetadata(documentId);
  const review = await reviewStore.read(documentId);
  if (!review || review.documentId !== metadata.documentId) {
    throw new Error("No persisted review matches this document.");
  }
  if (!MANUALLY_RECOVERABLE_STATUSES.includes(
    review.status as (typeof MANUALLY_RECOVERABLE_STATUSES)[number]
  )) {
    throw new Error(`Review status ${review.status} is not eligible for manual recovery.`);
  }
  if (!metadata.superdocsSessionId) {
    throw new Error("The persisted SuperDocs session mapping is missing.");
  }
  if (metadata.pendingReviewId && metadata.pendingReviewId !== review.reviewId) {
    throw new Error("Document metadata points to a different pending review.");
  }

  // This recovery path intentionally has access only to GET /jobs/{jobId}.
  // It cannot submit, retry, approve, reject, or continue a modifying request.
  const job = await reviewClient.getJob(review.superdocsJobId);
  const base = {
    documentId,
    reviewId: review.reviewId,
    persistedReviewStatus: review.status,
    jobStatus: job.status
  };
  if (!applyKnownTerminal) {
    return { ...base, applied: false, outcome: "inspection_only" };
  }
  if (!["completed", "failed", "cancelled"].includes(job.status)) {
    return { ...base, applied: false, outcome: "not_terminal" };
  }

  const currentMetadata = await storage.readMetadata(documentId);
  const currentReview = await reviewStore.read(documentId);
  if (
    !currentReview ||
    currentReview.reviewId !== review.reviewId ||
    currentReview.updatedAt !== review.updatedAt ||
    currentMetadata.updatedAt !== metadata.updatedAt
  ) {
    throw new Error("Persisted review state changed during inspection; nothing was recovered.");
  }

  const recoveredAt = new Date().toISOString();
  if (job.status === "completed") {
    if (!review.decision || !review.decidedAt) {
      throw new Error("A completed job cannot be reconciled without its persisted decision.");
    }
    if (metadata.lastReviewDecisionAt) {
      throw new Error("Document metadata already records a terminal review decision.");
    }
    const approved = review.decision === "approved";
    const editCount = (metadata.editCount ?? 0) + (approved ? 1 : 0);
    const summary = approved
      ? `${review.changeIds.length} approved proposed change${review.changeIds.length === 1 ? "" : "s"} (manually reconciled from a completed job)`
      : "Proposed changes were rejected (manually reconciled from a completed job).";

    // Metadata is written first. If a later local write fails, the unresolved
    // review file still blocks export and further edits until reconciliation is
    // rerun or investigated; it never leaves an unsafe retryable state.
    await storage.updateMetadata(documentId, {
      status: "ready",
      ...(approved
        ? {
            editCount,
            lastEditedAt: recoveredAt,
            lastEditDiscordMessageId: review.discordInstructionMessageId,
            lastEditSummary: summary
          }
        : {}),
      pendingReviewId: null,
      pendingReviewMessageId: null,
      lastReviewDecision: review.decision,
      lastReviewDecisionAt: review.decidedAt,
      lastReviewErrorCategory: null
    });
    await reviewStore.replace({
      ...review,
      status: "completed",
      safeErrorCategory: undefined
    }, MANUALLY_RECOVERABLE_STATUSES);
    await activity.append(documentId, {
      activityId: activity.createActivityId(),
      type: "document_review",
      reviewId: review.reviewId,
      discordMessageId: review.discordInstructionMessageId,
      discordThreadId: review.discordThreadId,
      requestedByUserId: review.requestedByUserId,
      status: review.decision,
      createdAt: review.createdAt,
      completedAt: recoveredAt,
      decision: review.decision,
      changesSummary: summary,
      changedSectionCount: approved ? review.changeIds.length : 0,
      errorCategory: "manual_recovery_confirmed_completed",
      ...(review.decisionInteractionId
        ? { discordInteractionId: review.decisionInteractionId }
        : {})
    });
    return {
      ...base,
      applied: true,
      outcome: approved ? "completed_approved" : "completed_rejected"
    };
  }

  const terminalCategory = `manual_recovery_job_${job.status}`;
  await storage.updateMetadata(documentId, {
    status: "review_failed",
    pendingReviewId: null,
    pendingReviewMessageId: null,
    lastReviewErrorCategory: terminalCategory
  });
  await reviewStore.replace({
    ...review,
    status: "failed",
    safeErrorCategory: terminalCategory
  }, MANUALLY_RECOVERABLE_STATUSES);
  await activity.append(documentId, {
    activityId: activity.createActivityId(),
    type: "document_review",
    reviewId: review.reviewId,
    discordMessageId: review.discordInstructionMessageId,
    discordThreadId: review.discordThreadId,
    requestedByUserId: review.requestedByUserId,
    status: "review_failed",
    createdAt: review.createdAt,
    completedAt: recoveredAt,
    ...(review.decision ? { decision: review.decision } : {}),
    errorCategory: terminalCategory,
    ...(review.decisionInteractionId
      ? { discordInteractionId: review.decisionInteractionId }
      : {})
  });
  return {
    ...base,
    applied: true,
    outcome: job.status === "failed" ? "failed" : "cancelled"
  };
}

export async function recoverReviewFromOperatorConfirmation({
  documentId,
  expectedReviewId,
  confirmedOutcome,
  decisionInteractionId,
  storage,
  reviewStore,
  activity
}: {
  documentId: string;
  expectedReviewId: string;
  confirmedOutcome: "approved_applied" | "unchanged";
  decisionInteractionId?: string;
  storage: DocumentStorage;
  reviewStore: ReviewStore;
  activity: EditActivityRepository;
}): Promise<{
  documentId: string;
  reviewId: string;
  applied: true;
  outcome: "completed_approved" | "confirmed_unchanged";
}> {
  const metadata = await storage.readMetadata(documentId);
  const review = await reviewStore.read(documentId);
  if (!review || review.documentId !== metadata.documentId) {
    throw new Error("No persisted review matches this document.");
  }
  if (review.reviewId !== expectedReviewId) {
    throw new Error("The expected review ID does not match the persisted review.");
  }
  if (!MANUALLY_RECOVERABLE_STATUSES.includes(
    review.status as (typeof MANUALLY_RECOVERABLE_STATUSES)[number]
  )) {
    throw new Error(`Review status ${review.status} is not eligible for manual recovery.`);
  }
  if (!metadata.superdocsSessionId) {
    throw new Error("The persisted SuperDocs session mapping is missing.");
  }
  if (metadata.pendingReviewId && metadata.pendingReviewId !== review.reviewId) {
    throw new Error("Document metadata points to a different pending review.");
  }
  if (metadata.lastReviewDecisionAt) {
    throw new Error("Document metadata already records a terminal review decision.");
  }
  if (
    decisionInteractionId &&
    review.decisionInteractionId &&
    review.decisionInteractionId !== decisionInteractionId
  ) {
    throw new Error("The supplied interaction ID conflicts with the persisted decision audit.");
  }

  const recoveredAt = new Date().toISOString();
  const auditedReview = decisionInteractionId && !review.decisionInteractionId
    ? { ...review, decisionInteractionId }
    : review;
  if (confirmedOutcome === "approved_applied") {
    if (review.decision !== "approved" || !review.decidedAt) {
      throw new Error("The persisted review does not contain an approved decision to reconcile.");
    }
    const summary = `${review.changeIds.length} approved proposed change${review.changeIds.length === 1 ? "" : "s"} (operator confirmed in the live session)`;
    await storage.updateMetadata(documentId, {
      status: "ready",
      editCount: (metadata.editCount ?? 0) + 1,
      lastEditedAt: recoveredAt,
      lastEditDiscordMessageId: review.discordInstructionMessageId,
      lastEditSummary: summary,
      pendingReviewId: null,
      pendingReviewMessageId: null,
      lastReviewDecision: "approved",
      lastReviewDecisionAt: review.decidedAt,
      lastReviewErrorCategory: null
    });
    await reviewStore.replace({
      ...auditedReview,
      status: "completed",
      safeErrorCategory: undefined
    }, MANUALLY_RECOVERABLE_STATUSES);
    await activity.append(documentId, {
      activityId: activity.createActivityId(),
      type: "document_review",
      reviewId: review.reviewId,
      discordMessageId: review.discordInstructionMessageId,
      discordThreadId: review.discordThreadId,
      requestedByUserId: review.requestedByUserId,
      status: "approved",
      createdAt: review.createdAt,
      completedAt: recoveredAt,
      decision: "approved",
      changesSummary: summary,
      changedSectionCount: review.changeIds.length,
      errorCategory: "manual_recovery_operator_confirmed_applied",
      ...(auditedReview.decisionInteractionId
        ? { discordInteractionId: auditedReview.decisionInteractionId }
        : {})
    });
    return {
      documentId,
      reviewId: review.reviewId,
      applied: true,
      outcome: "completed_approved"
    };
  }

  const terminalCategory = "manual_recovery_operator_confirmed_unchanged";
  await storage.updateMetadata(documentId, {
    status: "review_failed",
    pendingReviewId: null,
    pendingReviewMessageId: null,
    lastReviewErrorCategory: terminalCategory
  });
  await reviewStore.replace({
    ...auditedReview,
    status: "failed",
    safeErrorCategory: terminalCategory
  }, MANUALLY_RECOVERABLE_STATUSES);
  await activity.append(documentId, {
    activityId: activity.createActivityId(),
    type: "document_review",
    reviewId: review.reviewId,
    discordMessageId: review.discordInstructionMessageId,
    discordThreadId: review.discordThreadId,
    requestedByUserId: review.requestedByUserId,
    status: "review_failed",
    createdAt: review.createdAt,
    completedAt: recoveredAt,
    ...(review.decision ? { decision: review.decision } : {}),
    changesSummary: "Operator confirmed that the live session remains unchanged; no decision was replayed.",
    changedSectionCount: 0,
    errorCategory: terminalCategory,
    ...(auditedReview.decisionInteractionId
      ? { discordInteractionId: auditedReview.decisionInteractionId }
      : {})
  });
  return {
    documentId,
    reviewId: review.reviewId,
    applied: true,
    outcome: "confirmed_unchanged"
  };
}
