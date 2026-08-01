import "dotenv/config";

import pino from "pino";

import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import {
  inspectAndRecoverReview,
  recoverReviewFromOperatorConfirmation
} from "../src/documents/manual-review-recovery.js";
import { createReviewStore } from "../src/documents/review-store.js";
import { createSuperDocsConfig } from "../src/superdocs/config.js";
import {
  createSuperDocsReviewClient,
  SuperDocsReviewError
} from "../src/superdocs/review-client.js";

const [documentId, ...flags] = process.argv.slice(2);
const applyKnownTerminal = flags.includes("--apply-known-terminal");
const confirmApplied = flags.includes("--confirm-applied");
const confirmUnchanged = flags.includes("--confirm-unchanged");
const expectedReviewId = flags
  .find((flag) => flag.startsWith("--expected-review-id="))
  ?.slice("--expected-review-id=".length);
const decisionInteractionId = flags
  .find((flag) => flag.startsWith("--decision-interaction-id="))
  ?.slice("--decision-interaction-id=".length);
const knownFlags = flags.every((flag) =>
  ["--apply-known-terminal", "--confirm-applied", "--confirm-unchanged"].includes(flag) ||
  flag.startsWith("--expected-review-id=") ||
  flag.startsWith("--decision-interaction-id=")
);
const confirmationCount = Number(confirmApplied) + Number(confirmUnchanged);
if (
  !documentId ||
  !knownFlags ||
  confirmationCount > 1 ||
  (confirmationCount > 0 && (applyKnownTerminal || !expectedReviewId)) ||
  (confirmationCount === 0 && (expectedReviewId || decisionInteractionId))
) {
  throw new Error(
    "Usage: tsx scripts/recover-review.ts <document-id> [--apply-known-terminal] OR <document-id> (--confirm-applied|--confirm-unchanged) --expected-review-id=<id> [--decision-interaction-id=<id>]"
  );
}

const logger = pino({ level: "silent" });
const storage = createDocumentStorage({
  ...(process.env.DRAFTCORD_STORAGE_DIR
    ? { rootDirectory: process.env.DRAFTCORD_STORAGE_DIR }
    : {})
});
const reviewStore = createReviewStore({ storage, logger });
const activity = createEditActivityRepository({ storage, logger });

try {
  if (confirmationCount === 1) {
    const result = await recoverReviewFromOperatorConfirmation({
      documentId,
      expectedReviewId: expectedReviewId as string,
      confirmedOutcome: confirmApplied ? "approved_applied" : "unchanged",
      ...(decisionInteractionId ? { decisionInteractionId } : {}),
      storage,
      reviewStore,
      activity
    });
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Operator-confirmed state reconciled locally with an appended audit record. No approval request was sent."
    );
    process.exit(0);
  }

  const apiKey = process.env.SUPERDOCS_API_KEY;
  if (!apiKey) throw new Error("SUPERDOCS_API_KEY is missing.");
  const superdocs = createSuperDocsConfig({
    apiKey,
    apiBaseUrl: process.env.SUPERDOCS_API_BASE_URL,
    modelTier: process.env.SUPERDOCS_MODEL_TIER,
    thinkingDepth: process.env.SUPERDOCS_THINKING_DEPTH
  });
  const reviewClient = createSuperDocsReviewClient({ ...superdocs, logger });
  const result = await inspectAndRecoverReview({
    documentId,
    applyKnownTerminal,
    storage,
    reviewStore,
    reviewClient,
    activity
  });

  console.log(JSON.stringify(result, null, 2));
  if (!applyKnownTerminal) {
    console.log("Inspection only: no local state was changed and no approval request was sent.");
  } else if (!result.applied) {
    console.log("The remote job is not terminal. No local state was changed and no approval request was sent.");
  } else {
    console.log("Known terminal state reconciled locally. No approval request was sent.");
  }
} catch (error) {
  const reason = error instanceof SuperDocsReviewError
    ? `SuperDocs lookup failed (${error.category})`
    : error instanceof Error
      ? error.message
      : "Recovery failed";
  console.error(
    `${reason}. No approval request was sent. Inspect the persisted review before rerunning recovery.`
  );
  process.exitCode = 1;
}
