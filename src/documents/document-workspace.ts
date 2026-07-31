import type { Logger } from "pino";

import {
  DiscordApiError,
  type DiscordDocumentThreadClient
} from "../discord/api.js";
import {
  createDocumentThreadName,
  createDocumentThreadUrl,
  createWorkspaceWelcomeMessage
} from "../discord/document-threads.js";
import {
  SuperDocsClientError,
  type SuperDocsClient,
  type SuperDocsIngestionResult
} from "../superdocs/client.js";
import {
  ingestDocument,
  type IngestDocumentInput,
  type IngestionDependencies
} from "./document-ingestion.js";
import type {
  DocumentStorage,
  StoredDocument,
  StoredDocumentMetadata
} from "./document-storage.js";
import { sanitizeFilenameForDisplay } from "./filename-safety.js";
import { DEFAULT_EDIT_MODE, type EditMode } from "./edit-mode.js";
import { createModeComponents } from "../discord/review-components.js";

export type WorkspaceFailureStage =
  | "superdocs_ingestion"
  | "discord_thread_creation"
  | "discord_thread_setup";

export class DocumentWorkspaceError extends Error {
  constructor(
    public readonly stage: WorkspaceFailureStage,
    public readonly documentId: string,
    public readonly originalRetained: true,
    public readonly errorCategory: string,
    public readonly threadUrl?: string,
    options?: ErrorOptions
  ) {
    super(`Document workspace failed during ${stage}`, options);
    this.name = "DocumentWorkspaceError";
  }
}

export interface DocumentWorkspaceResult {
  storedDocument: StoredDocument;
  metadata: StoredDocumentMetadata;
  superdocs: SuperDocsIngestionResult;
  discordThreadId: string;
  discordThreadName: string;
  discordThreadUrl: string;
}

export interface DocumentWorkspaceDependencies
  extends Pick<IngestionDependencies, "download" | "verify"> {
  logger: Logger;
  storage: DocumentStorage;
  superdocsClient: SuperDocsClient;
  discordClient: DiscordDocumentThreadClient;
  ownerUserId: string;
  documentChannelId: string;
  defaultEditMode?: EditMode;
  onMetadataChanged?: (metadata: StoredDocumentMetadata) => void | Promise<void>;
}

function safeSuperDocsErrorCategory(error: unknown): string {
  return error instanceof SuperDocsClientError
    ? error.category
    : "superdocs_unexpected";
}

function safeDiscordErrorCategory(error: unknown, operation: string): string {
  const category =
    error instanceof DiscordApiError ? error.category : "unexpected";
  return `${operation}_${category}`;
}

async function markFailure(
  storage: DocumentStorage,
  logger: Logger,
  documentId: string,
  status: "superdocs_failed" | "thread_failed" | "thread_setup_failed",
  lastErrorCategory: string,
  logContext: Record<string, unknown>
): Promise<void> {
  try {
    await storage.updateMetadata(documentId, {
      status,
      lastErrorCategory
    });
  } catch {
    logger.error(
      {
        ...logContext,
        event: "document_metadata_failure_update_failed",
        stage: status,
        errorCategory: "metadata_update_failed"
      },
      "Document failure status could not be persisted"
    );
  }
}

export async function createDocumentWorkspace(
  input: IngestDocumentInput,
  {
    logger,
    storage,
    superdocsClient,
    discordClient,
    ownerUserId,
    documentChannelId,
    defaultEditMode = DEFAULT_EDIT_MODE,
    onMetadataChanged,
    download,
    verify
  }: DocumentWorkspaceDependencies
): Promise<DocumentWorkspaceResult> {
  const stored = await ingestDocument({ ...input, editMode: defaultEditMode }, {
    logger,
    storage,
    ...(download ? { download } : {}),
    ...(verify ? { verify } : {})
  });
  const logContext = {
    interactionId: input.interactionId,
    documentId: stored.documentId,
    filename: sanitizeFilenameForDisplay(stored.metadata.originalFilename),
    byteSize: stored.metadata.byteSize
  };
  logger.info(
    {
      event: "local_document_stored",
      ...logContext
    },
    "Local document stored"
  );

  await storage.updateMetadata(stored.documentId, {
    status: "superdocs_ingesting"
  });

  let superdocs: SuperDocsIngestionResult;
  try {
    superdocs = await superdocsClient.ingestStoredDocument({
      documentId: stored.documentId,
      originalPath: stored.originalPath,
      filename: sanitizeFilenameForDisplay(stored.metadata.originalFilename),
      interactionId: input.interactionId
    });
  } catch (error) {
    const errorCategory = safeSuperDocsErrorCategory(error);
    await markFailure(
      storage,
      logger,
      stored.documentId,
      "superdocs_failed",
      errorCategory,
      logContext
    );
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        stage: "superdocs_ingestion",
        errorCategory
      },
      "SuperDocs ingestion failed"
    );
    throw new DocumentWorkspaceError(
      "superdocs_ingestion",
      stored.documentId,
      true,
      errorCategory,
      undefined,
      { cause: error }
    );
  }

  try {
    await storage.updateMetadata(stored.documentId, {
      status: "superdocs_ready",
      superdocsSessionId: superdocs.superdocsSessionId,
      ...(superdocs.superdocsDocumentId
        ? { superdocsDocumentId: superdocs.superdocsDocumentId }
        : {}),
      ...(superdocs.chunkCount !== undefined
        ? { superdocsChunkCount: superdocs.chunkCount }
        : {}),
      lastErrorCategory: null
    });
  } catch (error) {
    const errorCategory = "superdocs_mapping_storage_failed";
    await markFailure(
      storage,
      logger,
      stored.documentId,
      "superdocs_failed",
      errorCategory,
      logContext
    );
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        stage: "superdocs_metadata",
        errorCategory
      },
      "SuperDocs mapping could not be persisted"
    );
    throw new DocumentWorkspaceError(
      "superdocs_ingestion",
      stored.documentId,
      true,
      errorCategory,
      undefined,
      { cause: error }
    );
  }

  try {
    await storage.updateMetadata(stored.documentId, {
      status: "thread_creating"
    });
  } catch (error) {
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        stage: "discord_thread_metadata",
        errorCategory: "thread_status_storage_failed"
      },
      "Discord thread creation status could not be persisted"
    );
    throw new DocumentWorkspaceError(
      "discord_thread_creation",
      stored.documentId,
      true,
      "thread_status_storage_failed",
      undefined,
      { cause: error }
    );
  }

  const requestedThreadName = createDocumentThreadName({
    documentId: stored.documentId,
    originalFilename: stored.metadata.originalFilename,
    ...(stored.metadata.title ? { title: stored.metadata.title } : {})
  });
  const threadStartedAt = Date.now();
  let thread: Awaited<ReturnType<DiscordDocumentThreadClient["createPublicThread"]>>;
  try {
    thread = await discordClient.createPublicThread({
      channelId: documentChannelId,
      name: requestedThreadName
    });
  } catch (error) {
    const errorCategory = safeDiscordErrorCategory(error, "thread_create");
    await markFailure(
      storage,
      logger,
      stored.documentId,
      "thread_failed",
      errorCategory,
      logContext
    );
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        stage: "discord_thread_creation",
        errorCategory
      },
      "Discord thread creation failed"
    );
    throw new DocumentWorkspaceError(
      "discord_thread_creation",
      stored.documentId,
      true,
      errorCategory,
      undefined,
      { cause: error }
    );
  }

  const threadUrl = createDocumentThreadUrl(input.guildId, thread.threadId);
  logger.info(
    {
      event: "discord_thread_created",
      ...logContext,
      discordThreadId: thread.threadId,
      durationMs: Date.now() - threadStartedAt
    },
    "Discord document thread created"
  );

  try {
    const mappedMetadata = await storage.updateMetadata(stored.documentId, {
      discordThreadId: thread.threadId,
      discordThreadName: thread.name
    });
    await onMetadataChanged?.(mappedMetadata);
  } catch (error) {
    const errorCategory = "thread_mapping_storage_failed";
    try {
      await storage.updateMetadata(stored.documentId, {
        status: "thread_setup_failed",
        discordThreadId: thread.threadId,
        discordThreadName: thread.name,
        lastErrorCategory: errorCategory
      });
    } catch {
      logger.error(
        {
          event: "document_metadata_failure_update_failed",
          ...logContext,
          discordThreadId: thread.threadId,
          stage: "thread_setup_failed",
          errorCategory: "metadata_update_failed"
        },
        "Created Discord thread mapping could not be persisted"
      );
    }
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        discordThreadId: thread.threadId,
        stage: "discord_thread_metadata",
        errorCategory
      },
      "Discord thread mapping persistence failed"
    );
    throw new DocumentWorkspaceError(
      "discord_thread_setup",
      stored.documentId,
      true,
      errorCategory,
      threadUrl,
      { cause: error }
    );
  }

  let setupOperation = "thread_member_add";
  try {
    let startedAt = Date.now();
    await discordClient.addThreadMember(thread.threadId, ownerUserId);
    logger.info(
      {
        event: "discord_thread_member_added",
        ...logContext,
        discordThreadId: thread.threadId,
        durationMs: Date.now() - startedAt
      },
      "Discord thread owner added"
    );

    setupOperation = "thread_message_create";
    startedAt = Date.now();
    const welcomeMessage = await discordClient.createThreadMessage(
      thread.threadId,
      createWorkspaceWelcomeMessage({
        title: stored.metadata.title,
        originalFilename: stored.metadata.originalFilename,
        documentId: stored.documentId,
        byteSize: stored.metadata.byteSize,
        chunkCount: superdocs.chunkCount,
        editMode: defaultEditMode
      }),
      createModeComponents(stored.documentId, defaultEditMode)
    );
    const controlMetadata = await storage.updateMetadata(stored.documentId, {
      modeControlMessageId: welcomeMessage.id
    });
    await onMetadataChanged?.(controlMetadata);
    logger.info(
      {
        event: "discord_thread_message_created",
        ...logContext,
        discordThreadId: thread.threadId,
        durationMs: Date.now() - startedAt
      },
      "Discord thread welcome message created"
    );
  } catch (error) {
    const errorCategory = safeDiscordErrorCategory(error, setupOperation);
    await markFailure(
      storage,
      logger,
      stored.documentId,
      "thread_setup_failed",
      errorCategory,
      { ...logContext, discordThreadId: thread.threadId }
    );
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        discordThreadId: thread.threadId,
        stage: "discord_thread_setup",
        errorCategory
      },
      "Discord thread setup failed"
    );
    throw new DocumentWorkspaceError(
      "discord_thread_setup",
      stored.documentId,
      true,
      errorCategory,
      threadUrl,
      { cause: error }
    );
  }

  let metadata: StoredDocumentMetadata;
  try {
    metadata = await storage.updateMetadata(stored.documentId, {
      status: "ready",
      lastErrorCategory: null
    });
    await onMetadataChanged?.(metadata);
  } catch (error) {
    const errorCategory = "workspace_ready_status_storage_failed";
    await markFailure(
      storage,
      logger,
      stored.documentId,
      "thread_setup_failed",
      errorCategory,
      { ...logContext, discordThreadId: thread.threadId }
    );
    logger.error(
      {
        event: "document_workspace_failed",
        ...logContext,
        discordThreadId: thread.threadId,
        stage: "discord_thread_metadata",
        errorCategory
      },
      "Ready workspace status could not be persisted"
    );
    throw new DocumentWorkspaceError(
      "discord_thread_setup",
      stored.documentId,
      true,
      errorCategory,
      threadUrl,
      { cause: error }
    );
  }
  logger.info(
    {
      event: "document_workspace_ready",
      ...logContext,
      superdocsChunkCount: superdocs.chunkCount,
      discordThreadId: thread.threadId
    },
    "Document workspace ready"
  );

  return {
    storedDocument: { ...stored, metadata },
    metadata,
    superdocs,
    discordThreadId: thread.threadId,
    discordThreadName: thread.name,
    discordThreadUrl: threadUrl
  };
}
