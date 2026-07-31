import { readdir } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import type {
  DocumentStorage,
  StoredDocumentMetadata
} from "./document-storage.js";

export interface WorkspaceRegistryRefreshResult {
  mappedCount: number;
  corruptCount: number;
  duplicateThreadIds: string[];
}

export interface DocumentWorkspaceRegistry {
  resolve(discordThreadId: string): StoredDocumentMetadata | undefined;
  resolveDocument(documentId: string): StoredDocumentMetadata | undefined;
  list(): StoredDocumentMetadata[];
  register(metadata: StoredDocumentMetadata): boolean;
  refresh(): Promise<WorkspaceRegistryRefreshResult>;
}

export function createDocumentWorkspaceRegistry({
  storage,
  logger
}: {
  storage: DocumentStorage;
  logger: Logger;
}): DocumentWorkspaceRegistry {
  const byThreadId = new Map<string, StoredDocumentMetadata>();
  const threadIdByDocumentId = new Map<string, string>();
  const duplicateThreadIds = new Set<string>();

  function register(metadata: StoredDocumentMetadata): boolean {
    const previousThreadId = threadIdByDocumentId.get(metadata.documentId);
    if (previousThreadId && previousThreadId !== metadata.discordThreadId) {
      byThreadId.delete(previousThreadId);
      threadIdByDocumentId.delete(metadata.documentId);
    }

    if (!metadata.discordThreadId) return false;

    const existing = byThreadId.get(metadata.discordThreadId);
    if (existing && existing.documentId !== metadata.documentId) {
      duplicateThreadIds.add(metadata.discordThreadId);
      byThreadId.delete(metadata.discordThreadId);
      threadIdByDocumentId.delete(existing.documentId);
      logger.error(
        {
          event: "duplicate_document_thread_mapping",
          discordThreadId: metadata.discordThreadId,
          documentId: metadata.documentId,
          conflictingDocumentId: existing.documentId,
          errorCategory: "duplicate_thread_mapping"
        },
        "Duplicate Discord thread mapping detected"
      );
      return false;
    }

    if (duplicateThreadIds.has(metadata.discordThreadId)) return false;

    byThreadId.set(metadata.discordThreadId, metadata);
    threadIdByDocumentId.set(metadata.documentId, metadata.discordThreadId);
    return true;
  }

  return {
    resolve(discordThreadId) {
      return byThreadId.get(discordThreadId);
    },

    resolveDocument(documentId) {
      const threadId = threadIdByDocumentId.get(documentId);
      return threadId ? byThreadId.get(threadId) : undefined;
    },

    list() {
      return [...byThreadId.values()];
    },

    register,

    async refresh() {
      byThreadId.clear();
      threadIdByDocumentId.clear();
      duplicateThreadIds.clear();

      const documentsRoot = path.join(storage.rootDirectory, "documents");
      let entries;
      try {
        entries = await readdir(documentsRoot, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return {
            mappedCount: 0,
            corruptCount: 0,
            duplicateThreadIds: []
          };
        }
        throw error;
      }

      let corruptCount = 0;
      for (const entry of entries
        .filter((candidate) => candidate.isDirectory() && !candidate.name.startsWith("."))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        try {
          register(await storage.readMetadata(entry.name));
        } catch {
          corruptCount += 1;
          logger.error(
            {
              event: "document_metadata_corrupt",
              documentId: entry.name,
              errorCategory: "corrupt_metadata"
            },
            "Stored document metadata could not be loaded"
          );
        }
      }

      return {
        mappedCount: byThreadId.size,
        corruptCount,
        duplicateThreadIds: [...duplicateThreadIds]
      };
    }
  };
}
