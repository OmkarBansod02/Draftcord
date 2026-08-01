import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

import {
  DiscordApiError,
  type DiscordExportFileClient,
  editOriginalInteractionResponse
} from "../discord/api.js";
import { createDiscordMessageUrl } from "../discord/document-threads.js";
import type { DiscordInteraction } from "../discord/types.js";
import type { ExportFormat } from "../discord/review-components.js";
import {
  InvalidDocxError,
  verifyDocx
} from "./docx-verifier.js";
import {
  ExportDownloadError,
  downloadExportToTemporaryFile,
  removeTemporaryExport,
  type DownloadedExportFile
} from "./export-download.js";
import {
  createSafeExportFilename,
  exportFilenameWithoutExtension
} from "./export-filenames.js";
import type {
  ExportActivityRecord,
  ExportActivityRepository
} from "./export-activity.js";
import { createExportStorage, type ExportStorage, type StoredExport } from "./export-storage.js";
import type {
  DocumentStorage,
  StoredDocumentMetadata
} from "./document-storage.js";
import { isUnresolvedReview, type ReviewStore } from "./review-store.js";
import type { DocumentWorkspaceRegistry } from "./workspace-registry.js";
import type { DocumentEditQueue } from "./edit-queue.js";
import {
  InvalidPdfError,
  verifyPdfFile
} from "./pdf-verifier.js";
import {
  SuperDocsExportError,
  type SuperDocsExportClient
} from "../superdocs/export-client.js";

export const DEFAULT_MAX_EXPORT_BYTES = 10 * 1024 * 1024;

export function parseMaxExportBytes(
  value: string | undefined = process.env.DRAFTCORD_MAX_EXPORT_BYTES
): number {
  if (value === undefined) return DEFAULT_MAX_EXPORT_BYTES;
  if (!/^\d+$/.test(value.trim())) {
    throw new Error("DRAFTCORD_MAX_EXPORT_BYTES must be a safe positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("DRAFTCORD_MAX_EXPORT_BYTES must be a safe positive integer");
  }
  return parsed;
}

export interface DocumentExportInput {
  interaction: DiscordInteraction;
  documentId: string;
  format: ExportFormat;
}

export interface DocumentExportWorkflow {
  run(input: DocumentExportInput): Promise<void>;
  isActive(documentId: string): boolean;
}

export interface EditOriginalResponse {
  (input: {
    applicationId: string;
    interactionToken: string;
    content: string;
  }): Promise<void>;
}

export interface DocumentExportWorkflowOptions {
  config: {
    applicationId: string;
    ownerUserId: string;
    guildId: string;
  };
  logger: Logger;
  storage: DocumentStorage;
  registry: DocumentWorkspaceRegistry;
  reviewStore: ReviewStore;
  activity: ExportActivityRepository;
  exportClient: SuperDocsExportClient;
  discordClient: DiscordExportFileClient;
  editQueue?: Pick<DocumentEditQueue, "has">;
  maxExportBytes?: number;
  requestTimeoutMs?: number;
  maxRedirects?: number;
  exportStorage?: ExportStorage;
  download?: typeof downloadExportToTemporaryFile;
  editOriginal?: EditOriginalResponse;
}

class DocumentExportError extends Error {
  constructor(
    public readonly category: string,
    message: string,
    public readonly ambiguous = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DocumentExportError";
  }
}

class OversizedExportError extends Error {
  constructor() {
    super("Export exceeds Discord's attachment limit");
    this.name = "OversizedExportError";
  }
}

function attachmentSizeLimit(interaction: DiscordInteraction): number | undefined {
  const candidate = interaction.attachment_size_limit ??
    interaction.data?.attachment_size_limit ??
    interaction.guild?.attachment_size_limit ??
    interaction.message?.attachment_size_limit;
  return candidate !== undefined && Number.isSafeInteger(candidate) && candidate > 0
    ? candidate
    : undefined;
}

function currentEditVersion(metadata: StoredDocumentMetadata): number {
  return metadata.editCount ?? 0;
}

function operationBlockedMessage(
  metadata: StoredDocumentMetadata,
  unresolvedReview: boolean
): string {
  if (unresolvedReview || metadata.pendingReviewId) {
    return "Resolve the pending proposal before exporting.";
  }
  if (metadata.status === "exporting") {
    return "An export is already processing for this document.";
  }
  if (metadata.status === "editing") {
    return "The document is currently being edited. Export it after the operation finishes.";
  }
  if (["review_generating", "awaiting_approval", "approval_processing"].includes(metadata.status)) {
    return "Resolve the pending proposal before exporting.";
  }
  return "The document workspace is not ready for export. Try again after its current operation finishes.";
}

function responseForError(error: unknown): string {
  if (error instanceof OversizedExportError) {
    return "⚠️ The export is larger than Discord’s attachment limit.";
  }
  if (error instanceof DocumentExportError) {
    if (error.category === "workspace_busy") {
      return `⏳ ${error.message}`;
    }
    if (error.category.startsWith("discord_")) {
      return "❌ The export was generated, but Discord could not post it in the document thread. Try again later.";
    }
    if (error.category.startsWith("verify_") || error.category.startsWith("download_")) {
      return "❌ The generated export could not be verified safely. Try again later.";
    }
    return "❌ Draftcord could not generate this export safely. Try again later.";
  }
  return "❌ Draftcord could not complete this export safely. Try again later.";
}

function errorCategory(error: unknown): string {
  if (error instanceof DocumentExportError) return error.category;
  if (error instanceof OversizedExportError) return "attachment_too_large";
  if (error instanceof SuperDocsExportError) return error.category;
  if (error instanceof ExportDownloadError) return error.category;
  if (error instanceof DiscordApiError) return `discord_${error.category}`;
  if (error instanceof InvalidDocxError) return "verify_docx_invalid";
  if (error instanceof InvalidPdfError) return "verify_pdf_invalid";
  return "export_unexpected";
}

function isAmbiguousFailure(error: unknown): boolean {
  if (error instanceof DocumentExportError) return error.ambiguous;
  if (error instanceof SuperDocsExportError) {
    return ["export_timeout", "export_network", "export_server_error"].includes(error.category);
  }
  if (error instanceof DiscordApiError) {
    return ["timeout", "network", "server_error"].includes(error.category);
  }
  return false;
}

function explicitContentTypeIsUnsafe(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType) return false;
  return mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType === "application/xhtml+xml";
}

async function verifyExportFile(
  filePath: string,
  format: ExportFormat,
  contentType?: string
): Promise<void> {
  if (explicitContentTypeIsUnsafe(contentType)) {
    throw new DocumentExportError(
      "verify_content_type",
      "The export response had an unsafe content type"
    );
  }
  try {
    if (format === "pdf") {
      await verifyPdfFile(filePath);
    } else {
      await verifyDocx(await readFile(filePath));
    }
  } catch (error) {
    if (error instanceof DocumentExportError) throw error;
    throw error;
  }
}

function formatLabel(format: ExportFormat): string {
  return format.toUpperCase();
}

function exportThreadContent(
  format: ExportFormat,
  version: number,
  displayFilename: string
): string {
  return [
    "📦 Revised document export",
    "",
    `Format: ${formatLabel(format)}`,
    `Version: ${version} approved/applied edits`,
    `File: ${displayFilename}`
  ].join("\n");
}

function exportReadyContent(
  format: ExportFormat,
  version: number,
  messageUrl: string
): string {
  return [
    "✅ Export ready",
    "",
    `Format: ${formatLabel(format)}`,
    `Version: ${version}`,
    "File posted in this document thread:",
    messageUrl
  ].join("\n");
}

function directLinkContent(
  format: ExportFormat,
  url: string,
  expiresInSeconds: number
): string {
  const minutes = Math.max(1, Math.round(expiresInSeconds / 60));
  return [
    "⚠️ Export is larger than Discord’s attachment limit.",
    "",
    `Use this private ${formatLabel(format)} download link within ${minutes} minutes:`,
    url
  ].join("\n");
}

function cachedInteractionContent(record: ExportActivityRecord): string {
  if (record.status === "succeeded" || record.status === "cached") {
    return "ℹ️ This export interaction was already completed. No second file was posted.";
  }
  if (record.status === "direct_link") {
    return "ℹ️ This export interaction was already handled. The private download link is no longer repeated.";
  }
  return "ℹ️ This export interaction was already handled. Start a new export if needed.";
}

export function createDocumentExportWorkflow({
  config,
  logger,
  storage,
  registry,
  reviewStore,
  activity,
  exportClient,
  discordClient,
  editQueue,
  maxExportBytes = DEFAULT_MAX_EXPORT_BYTES,
  requestTimeoutMs,
  maxRedirects,
  exportStorage = createExportStorage(storage, {
    verifyFile: async (filePath, format) => verifyExportFile(filePath, format)
  }),
  download = downloadExportToTemporaryFile,
  editOriginal = editOriginalInteractionResponse
}: DocumentExportWorkflowOptions): DocumentExportWorkflow {
  if (!Number.isSafeInteger(maxExportBytes) || maxExportBytes <= 0) {
    throw new Error("maxExportBytes must be a safe positive integer");
  }

  const locks = new Set<string>();

  async function editEphemeral(
    interaction: DiscordInteraction,
    content: string
  ): Promise<void> {
    if (!interaction.token) return;
    try {
      await editOriginal({
        applicationId: config.applicationId,
        interactionToken: interaction.token,
        content
      });
    } catch (error) {
      logger.error(
        {
          event: "document_export_response_update_failed",
          interactionId: interaction.id,
          errorCategory: error instanceof DiscordApiError
            ? error.category
            : "discord_status_edit_failed"
        },
        "Export interaction response could not be updated"
      );
    }
  }

  async function restoreStatus(
    metadata: StoredDocumentMetadata,
    safeErrorCategory?: string,
    statusOverride?: StoredDocumentMetadata["status"]
  ): Promise<StoredDocumentMetadata | undefined> {
    const restored = await storage.updateMetadata(metadata.documentId, {
      status: statusOverride ?? (metadata.status === "exporting" ? "ready" : metadata.status),
      ...(safeErrorCategory
        ? { lastExportErrorCategory: safeErrorCategory }
        : { lastExportErrorCategory: null })
    }).catch((error) => {
      logger.error(
        {
          event: "document_export_failed",
          documentId: metadata.documentId,
          errorCategory: "export_status_restore_failed"
        },
        "Export status could not be restored"
      );
      return undefined;
    });
    if (restored) registry.register(restored);
    return restored;
  }

  async function appendTerminal(
    documentId: string,
    started: ExportActivityRecord,
    status: ExportActivityRecord["status"],
    extra: Partial<ExportActivityRecord> = {}
  ): Promise<void> {
    await activity.append(documentId, {
      ...started,
      status,
      completedAt: new Date().toISOString(),
      ...extra
    }).catch(() => undefined);
  }

  async function run(input: DocumentExportInput): Promise<void> {
    const { interaction, documentId, format } = input;
    const interactionId = interaction.id;
    if (!interactionId || !interaction.token) {
      return;
    }
    if (format !== "docx" && format !== "pdf") {
      await editEphemeral(interaction, "That export format is not recognized.");
      return;
    }

    const priorActivity = await activity.getState(documentId, interactionId).catch(() => ({ state: "none" as const }));
    if (priorActivity.state === "terminal") {
      logger.info(
        {
          event: "duplicate_export_ignored",
          documentId,
          interactionId,
          format
        },
        "Duplicate export interaction ignored"
      );
      await editEphemeral(interaction, cachedInteractionContent(priorActivity.record));
      return;
    }
    if (priorActivity.state === "started") {
      logger.warn(
        {
          event: "duplicate_export_ignored",
          documentId,
          interactionId,
          format,
          errorCategory: "started_export_not_replayed"
        },
        "Started export interaction was not replayed"
      );
      await editEphemeral(
        interaction,
        "⚠️ This export may have started before Draftcord restarted. It was not replayed to avoid a duplicate file."
      );
      return;
    }

    if (locks.has(documentId)) {
      await editEphemeral(interaction, "⏳ Another export is already processing for this document.");
      return;
    }

    let metadata = await storage.readMetadata(documentId).catch(() => undefined);
    const invokingUserId = interaction.member?.user?.id ?? interaction.user?.id;
    if (
      !metadata ||
      metadata.documentId !== documentId ||
      metadata.guildId !== config.guildId ||
      metadata.uploadedByUserId !== config.ownerUserId ||
      interaction.application_id !== config.applicationId ||
      interaction.guild_id !== config.guildId ||
      invokingUserId !== config.ownerUserId ||
      !interaction.channel_id ||
      metadata.discordThreadId !== interaction.channel_id ||
      metadata.modeControlMessageId !== interaction.message?.id ||
      registry.resolve(interaction.channel_id)?.documentId !== documentId
    ) {
      await editEphemeral(interaction, "That export control does not match this document workspace.");
      return;
    }

    const review = await reviewStore.read(documentId).catch(() => undefined);
    const unresolved = isUnresolvedReview(review);
    if (!metadata.superdocsSessionId) {
      await editEphemeral(interaction, "This document workspace is missing its SuperDocs session mapping.");
      return;
    }
    if (unresolved || metadata.pendingReviewId) {
      await editEphemeral(interaction, operationBlockedMessage(metadata, true));
      return;
    }
    if (metadata.status === "exporting" || locks.has(documentId)) {
      await editEphemeral(interaction, operationBlockedMessage(metadata, false));
      return;
    }
    if (editQueue?.has(documentId)) {
      await editEphemeral(
        interaction,
        "The document is currently being edited. Export it after the operation finishes."
      );
      return;
    }
    if (!["ready", "edit_failed", "review_failed"].includes(metadata.status)) {
      await editEphemeral(interaction, operationBlockedMessage(metadata, false));
      return;
    }

    locks.add(documentId);
    const priorStatus = metadata.status;
    const version = currentEditVersion(metadata);
    const sessionId = metadata.superdocsSessionId;
    const started: ExportActivityRecord = {
      activityId: activity.createActivityId(),
      type: "document_export",
      discordInteractionId: interactionId,
      discordThreadId: interaction.channel_id,
      requestedByUserId: config.ownerUserId,
      format,
      editVersion: version,
      status: "started",
      createdAt: new Date().toISOString()
    };
    let statusClaimed = false;
    let temporary: DownloadedExportFile | undefined;
    let signedExport: Awaited<ReturnType<SuperDocsExportClient["createExport"]>> | undefined;
    let activityStarted = false;

    try {
      const claimed = await storage.updateMetadata(documentId, {
        status: "exporting",
        lastExportErrorCategory: null
      });
      metadata = claimed;
      registry.register(claimed);
      statusClaimed = true;
      await activity.append(documentId, started);
      activityStarted = true;
      logger.info(
        {
          event: "document_export_claimed",
          documentId,
          interactionId,
          discordThreadId: interaction.channel_id,
          format,
          editVersion: version
        },
        "Document export claimed"
      );

      const displayFilename = createSafeExportFilename(metadata, format);
      let stored = await exportStorage.readCachedExport({
        documentId,
        format,
        editVersion: version,
        maxBytes: maxExportBytes
      });
      const cacheHit = Boolean(stored);
      if (cacheHit) {
        logger.info(
          {
            event: "document_export_cache_hit",
            documentId,
            interactionId,
            format,
            editVersion: version,
            cacheHit: true,
            byteSize: stored?.metadata.byteSize
          },
          "Verified export cache hit"
        );
      } else {
        logger.info(
          {
            event: "superdocs_export_requested",
            documentId,
            interactionId,
            format,
            editVersion: version
          },
          "SuperDocs export requested"
        );
        signedExport = await exportClient.createExport({
          sessionId,
          format,
          filename: exportFilenameWithoutExtension(displayFilename)
        });
        temporary = await download({
          url: signedExport.downloadUrl,
          temporaryParentDirectory: path.join(
            storage.rootDirectory,
            "documents",
            documentId
          ),
          maxBytes: maxExportBytes,
          ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
          ...(maxRedirects !== undefined ? { maxRedirects } : {})
        });
        logger.info(
          {
            event: "export_download_started",
            documentId,
            interactionId,
            format,
            editVersion: version
          },
          "Signed export download started"
        );
        await verifyExportFile(temporary.filePath, format, temporary.contentType);
        logger.info(
          {
            event: "export_download_verified",
            documentId,
            interactionId,
            format,
            editVersion: version,
            byteSize: temporary.byteSize
          },
          "Signed export download verified"
        );

        const discordLimit = attachmentSizeLimit(interaction);
        const permittedSize = discordLimit === undefined
          ? maxExportBytes
          : Math.min(maxExportBytes, discordLimit);
        if (temporary.byteSize > permittedSize) {
          throw new OversizedExportError();
        }

        stored = await exportStorage.storeVerifiedExport({
          documentId,
          format,
          editVersion: version,
          displayFilename,
          sourcePath: temporary.filePath
        });
      }

      if (!stored) {
        throw new DocumentExportError("export_cache_missing", "Export cache was unavailable");
      }

      const discordLimit = attachmentSizeLimit(interaction);
      const permittedSize = discordLimit === undefined
        ? maxExportBytes
        : Math.min(maxExportBytes, discordLimit);
      if (stored.metadata.byteSize > permittedSize) {
        if (signedExport) throw new OversizedExportError();
        throw new DocumentExportError("attachment_too_large", "Cached export exceeds Discord's attachment limit");
      }

      const message = await discordClient.uploadThreadFile({
        threadId: interaction.channel_id,
        content: exportThreadContent(format, version, stored.metadata.displayFilename),
        filePath: stored.filePath,
        filename: stored.metadata.displayFilename,
        format
      });
      logger.info(
        {
          event: "discord_export_uploaded",
          documentId,
          interactionId,
          discordThreadId: interaction.channel_id,
          discordMessageId: message.id,
          format,
          editVersion: version,
          byteSize: stored.metadata.byteSize
        },
        "Verified export uploaded to Discord"
      );
      try {
        stored = await exportStorage.markDelivered(stored, message.id);
      } catch {
        logger.error(
          {
            event: "document_export_failed",
            documentId,
            interactionId,
            format,
            editVersion: version,
            errorCategory: "export_delivery_metadata_failed"
          },
          "Export delivery metadata could not be updated"
        );
      }
      await appendTerminal(
        documentId,
        started,
        cacheHit ? "cached" : "succeeded",
        { byteSize: stored.metadata.byteSize, discordMessageId: message.id }
      );
      const finalized = await storage.updateMetadata(documentId, {
        status: priorStatus,
        lastExportAt: new Date().toISOString(),
        lastExportFormat: format,
        lastExportVersion: version,
        lastExportDiscordMessageId: message.id,
        lastExportErrorCategory: null
      }).then((updated) => {
        registry.register(updated);
        return true;
      }).catch(() => false);
      if (!finalized) {
        await restoreStatus(metadata, undefined, priorStatus);
      }
      await editEphemeral(
        interaction,
        exportReadyContent(
          format,
          version,
          createDiscordMessageUrl(config.guildId, interaction.channel_id, message.id)
        )
      );
      logger.info(
        {
          event: "document_export_completed",
          documentId,
          interactionId,
          format,
          editVersion: version,
          byteSize: stored.metadata.byteSize,
          durationMs: Date.now() - Date.parse(started.createdAt)
        },
        "Document export completed"
      );
    } catch (error) {
      const category = errorCategory(error);
      if (error instanceof OversizedExportError && signedExport) {
        if (activityStarted) {
          await appendTerminal(documentId, started, "direct_link", {
            safeErrorCategory: "attachment_too_large"
          });
        }
        await restoreStatus(metadata, "attachment_too_large", priorStatus);
        await editEphemeral(
          interaction,
          directLinkContent(format, signedExport.downloadUrl, signedExport.expiresInSeconds)
        );
        logger.info(
          {
            event: "oversized_export_direct_link",
            documentId,
            interactionId,
            format,
            editVersion: version
          },
          "Oversized export was returned through the private interaction response"
        );
      } else {
        const ambiguous = isAmbiguousFailure(error);
        if (activityStarted) {
          await appendTerminal(documentId, started, ambiguous ? "ambiguous" : "failed", {
            safeErrorCategory: category
          });
        }
        if (statusClaimed) await restoreStatus(metadata, category, priorStatus);
        await editEphemeral(interaction, responseForError(
          error instanceof DocumentExportError
            ? error
            : new DocumentExportError(category, "Export failed", ambiguous)
        ));
        logger.error(
          {
            event: "document_export_failed",
            documentId,
            interactionId,
            format,
            editVersion: version,
            safeErrorCategory: category,
            ambiguous,
            durationMs: Date.now() - Date.parse(started.createdAt)
          },
          "Document export failed"
        );
      }
    } finally {
      if (temporary) await removeTemporaryExport(temporary).catch(() => undefined);
      locks.delete(documentId);
    }
  }

  return {
    run,
    isActive(documentId) {
      return locks.has(documentId);
    }
  };
}

export { verifyExportFile };
