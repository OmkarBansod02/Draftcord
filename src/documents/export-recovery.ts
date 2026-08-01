import type { Logger } from "pino";

import type { DocumentStorage } from "./document-storage.js";
import { isUnresolvedReview, type ReviewStore } from "./review-store.js";
import type { DocumentWorkspaceRegistry } from "./workspace-registry.js";

export async function reconcileStaleExports({
  storage,
  registry,
  reviewStore,
  logger
}: {
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  reviewStore: ReviewStore;
  logger: Logger;
}): Promise<void> {
  for (const metadata of registry.list()) {
    if (metadata.status !== "exporting") continue;

    const review = await reviewStore.read(metadata.documentId).catch(() => undefined);
    if (
      !metadata.superdocsSessionId ||
      metadata.pendingReviewId ||
      isUnresolvedReview(review)
    ) {
      logger.warn(
        {
          event: "stale_export_not_recovered",
          documentId: metadata.documentId,
          errorCategory: "export_recovery_state_ambiguous"
        },
        "Stale export state could not be recovered automatically"
      );
      continue;
    }

    const recovered = await storage.updateMetadata(metadata.documentId, {
      status: "ready",
      lastExportErrorCategory: "stale_export_recovered"
    }).catch(() => undefined);
    if (!recovered) continue;
    registry.register(recovered);
    logger.warn(
      {
        event: "stale_export_recovered",
        documentId: metadata.documentId,
        errorCategory: "stale_export_recovered"
      },
      "Stale export state was restored to ready"
    );
  }
}

