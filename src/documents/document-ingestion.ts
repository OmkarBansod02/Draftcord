import type { Logger } from "pino";

import type { DiscordAttachment } from "../discord/types.js";
import {
  AttachmentDownloadError,
  downloadAttachment
} from "./attachment-downloader.js";
import {
  createDocumentStorage,
  DocumentStorageError,
  type DocumentStorage
} from "./document-storage.js";
import { verifyDocx, InvalidDocxError } from "./docx-verifier.js";
import { sanitizeFilenameForDisplay } from "./filename-safety.js";

export type DocumentIngestionErrorCategory =
  | "download_timeout"
  | "download_too_large"
  | "download_failed"
  | "invalid_docx"
  | "storage_failed";

export class DocumentIngestionError extends Error {
  public readonly documentId?: string;

  constructor(
    public readonly category: DocumentIngestionErrorCategory,
    public readonly userMessage: string,
    options?: ErrorOptions & { documentId?: string }
  ) {
    super(userMessage, options);
    this.name = "DocumentIngestionError";
    this.documentId = options?.documentId;
  }
}

export interface IngestDocumentInput {
  interactionId?: string;
  attachment: DiscordAttachment;
  title?: string;
  uploadedByUserId: string;
  guildId: string;
  channelId: string;
}

export interface IngestionDependencies {
  logger: Logger;
  storage?: DocumentStorage;
  download?: typeof downloadAttachment;
  verify?: typeof verifyDocx;
}

export async function ingestDocument(
  input: IngestDocumentInput,
  {
    logger,
    storage = createDocumentStorage(),
    download = downloadAttachment,
    verify = verifyDocx
  }: IngestionDependencies
) {
  const documentId = storage.generateDocumentId();
  const safeFilename = sanitizeFilenameForDisplay(input.attachment.filename);
  const logContext = {
    interactionId: input.interactionId,
    documentId,
    attachmentId: input.attachment.id,
    filename: safeFilename
  };

  let bytes: Buffer;
  logger.info(
    { ...logContext, processingStage: "download" },
    "Document download started"
  );
  try {
    bytes = await download({ url: input.attachment.url });
  } catch (error) {
    const category =
      error instanceof AttachmentDownloadError && error.code === "timeout"
        ? "download_timeout"
        : error instanceof AttachmentDownloadError && error.code === "too_large"
          ? "download_too_large"
          : "download_failed";
    const userMessage =
      category === "download_timeout"
        ? "Download timed out."
        : category === "download_too_large"
          ? "File exceeded 10 MiB while downloading."
          : "Discord attachment could not be downloaded.";
    logger.warn(
      { ...logContext, processingStage: "download", errorCategory: category },
      "Document download failed"
    );
    throw new DocumentIngestionError(category, userMessage, {
      cause: error,
      documentId
    });
  }

  logger.info(
    {
      ...logContext,
      byteSize: bytes.byteLength,
      processingStage: "verification"
    },
    "DOCX verification started"
  );
  try {
    await verify(bytes);
  } catch (error) {
    const cause = error instanceof InvalidDocxError ? error : undefined;
    logger.warn(
      {
        ...logContext,
        byteSize: bytes.byteLength,
        processingStage: "verification",
        errorCategory: "invalid_docx"
      },
      "DOCX verification failed"
    );
    throw new DocumentIngestionError(
      "invalid_docx",
      "File is not a valid DOCX document.",
      { cause: cause ?? error, documentId }
    );
  }

  logger.info(
    {
      ...logContext,
      byteSize: bytes.byteLength,
      processingStage: "storage"
    },
    "Document storage started"
  );
  try {
    const stored = await storage.store(
      bytes,
      {
        originalFilename: input.attachment.filename,
        ...(input.title ? { title: input.title } : {}),
        uploadedByUserId: input.uploadedByUserId,
        guildId: input.guildId,
        channelId: input.channelId,
        discordAttachmentId: input.attachment.id
      },
      documentId
    );
    logger.info(
      {
        ...logContext,
        documentId: stored.documentId,
        byteSize: bytes.byteLength,
        processingStage: "complete",
        result: "success"
      },
      "Document ingestion completed"
    );
    return stored;
  } catch (error) {
    const cause = error instanceof DocumentStorageError ? error : undefined;
    logger.error(
      {
        ...logContext,
        byteSize: bytes.byteLength,
        processingStage: "storage",
        errorCategory: "storage_failed"
      },
      "Document storage failed"
    );
    throw new DocumentIngestionError(
      "storage_failed",
      "Document could not be stored.",
      { cause: cause ?? error, documentId }
    );
  }
}
