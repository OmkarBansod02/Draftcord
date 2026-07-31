import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DOCUMENT_STATUSES = [
  "stored",
  "superdocs_ingesting",
  "superdocs_ready",
  "thread_creating",
  "ready",
  "superdocs_failed",
  "thread_failed",
  "thread_setup_failed",
  "editing",
  "edit_failed"
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export interface DocumentMetadataInput {
  originalFilename: string;
  title?: string;
  uploadedByUserId: string;
  guildId: string;
  channelId: string;
  discordAttachmentId: string;
}

export interface StoredDocumentMetadata extends DocumentMetadataInput {
  documentId: string;
  byteSize: number;
  createdAt: string;
  updatedAt: string;
  status: DocumentStatus;
  superdocsSessionId?: string;
  superdocsDocumentId?: string;
  superdocsChunkCount?: number;
  discordThreadId?: string;
  discordThreadName?: string;
  lastErrorCategory?: string;
  editCount?: number;
  lastEditedAt?: string;
  lastEditDiscordMessageId?: string;
  lastEditSummary?: string;
  lastEditErrorCategory?: string;
}

export interface DocumentMetadataUpdate {
  status?: DocumentStatus;
  superdocsSessionId?: string;
  superdocsDocumentId?: string;
  superdocsChunkCount?: number;
  discordThreadId?: string;
  discordThreadName?: string;
  lastErrorCategory?: string | null;
  editCount?: number;
  lastEditedAt?: string;
  lastEditDiscordMessageId?: string;
  lastEditSummary?: string;
  lastEditErrorCategory?: string | null;
}

export interface StoredDocument {
  documentId: string;
  directory: string;
  originalPath: string;
  metadataPath: string;
  metadata: StoredDocumentMetadata;
}

export interface DocumentStorageOptions {
  rootDirectory?: string;
  generateId?: () => string;
  writeFileImplementation?: (
    file: string,
    data: string | Buffer,
    options: { flag: string; mode: number; encoding?: BufferEncoding }
  ) => Promise<void>;
}

const storedDocumentMetadataSchema = z.object({
  documentId: z.string().min(1),
  originalFilename: z.string(),
  title: z.string().optional(),
  byteSize: z.number().int().nonnegative(),
  uploadedByUserId: z.string().min(1),
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  discordAttachmentId: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  superdocsSessionId: z.string().min(1).optional(),
  superdocsDocumentId: z.string().min(1).optional(),
  superdocsChunkCount: z.number().int().nonnegative().optional(),
  discordThreadId: z.string().min(1).optional(),
  discordThreadName: z.string().min(1).max(100).optional(),
  lastErrorCategory: z.string().min(1).max(100).optional(),
  editCount: z.number().int().nonnegative().default(0),
  lastEditedAt: z.string().optional(),
  lastEditDiscordMessageId: z.string().min(1).max(100).optional(),
  lastEditSummary: z.string().min(1).max(1_000).optional(),
  lastEditErrorCategory: z.string().min(1).max(100).optional()
});

export class DocumentStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentStorageError";
  }
}

function ensureContained(parent: string, child: string): void {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DocumentStorageError("Generated document path escaped storage root");
  }
}

export function createDocumentStorage({
  rootDirectory = process.env.DRAFTCORD_STORAGE_DIR ?? "./data",
  generateId = randomUUID,
  writeFileImplementation = writeFile
}: DocumentStorageOptions = {}) {
  const storageRoot = path.resolve(rootDirectory);
  const documentsRoot = path.join(storageRoot, "documents");

  return {
    rootDirectory: storageRoot,
    generateDocumentId: generateId,

    async store(
      documentBytes: Buffer,
      input: DocumentMetadataInput,
      documentId = generateId()
    ): Promise<StoredDocument> {
      const finalDirectory = path.join(documentsRoot, documentId);
      const temporaryDirectory = path.join(
        documentsRoot,
        `.${documentId}.${randomUUID()}.tmp`
      );
      ensureContained(documentsRoot, finalDirectory);
      ensureContained(documentsRoot, temporaryDirectory);

      const originalPath = path.join(finalDirectory, "original.docx");
      const metadataPath = path.join(finalDirectory, "metadata.json");
      const now = new Date().toISOString();
      const metadata: StoredDocumentMetadata = {
        documentId,
        originalFilename: input.originalFilename,
        ...(input.title ? { title: input.title } : {}),
        byteSize: documentBytes.byteLength,
        uploadedByUserId: input.uploadedByUserId,
        guildId: input.guildId,
        channelId: input.channelId,
        discordAttachmentId: input.discordAttachmentId,
        createdAt: now,
        updatedAt: now,
        status: "stored"
      };

      try {
        await mkdir(documentsRoot, { recursive: true, mode: 0o700 });
        await mkdir(temporaryDirectory, { mode: 0o700 });
        await writeFileImplementation(
          path.join(temporaryDirectory, "original.docx"),
          documentBytes,
          { flag: "wx", mode: 0o600 }
        );
        await writeFileImplementation(
          path.join(temporaryDirectory, "metadata.json"),
          `${JSON.stringify(metadata, null, 2)}\n`,
          { flag: "wx", mode: 0o600, encoding: "utf8" }
        );
        await rename(temporaryDirectory, finalDirectory);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(
          () => undefined
        );
        throw new DocumentStorageError("Document could not be stored", {
          cause: error
        });
      }

      return {
        documentId,
        directory: finalDirectory,
        originalPath,
        metadataPath,
        metadata
      };
    },

    async readMetadata(documentId: string): Promise<StoredDocumentMetadata> {
      const documentDirectory = path.join(documentsRoot, documentId);
      ensureContained(documentsRoot, documentDirectory);
      const metadataPath = path.join(documentDirectory, "metadata.json");

      try {
        const rawMetadata = await readFile(metadataPath, "utf8");
        return storedDocumentMetadataSchema.parse(JSON.parse(rawMetadata));
      } catch (error) {
        throw new DocumentStorageError("Document metadata could not be read", {
          cause: error
        });
      }
    },

    async updateMetadata(
      documentId: string,
      update: DocumentMetadataUpdate
    ): Promise<StoredDocumentMetadata> {
      const documentDirectory = path.join(documentsRoot, documentId);
      ensureContained(documentsRoot, documentDirectory);
      const metadataPath = path.join(documentDirectory, "metadata.json");
      const temporaryMetadataPath = path.join(
        documentDirectory,
        `.metadata.${randomUUID()}.tmp`
      );
      ensureContained(documentDirectory, temporaryMetadataPath);

      try {
        const current = await this.readMetadata(documentId);
        const {
          lastErrorCategory,
          lastEditErrorCategory,
          ...fields
        } = update;
        const next = storedDocumentMetadataSchema.parse({
          ...current,
          ...fields,
          ...(lastErrorCategory === null
            ? { lastErrorCategory: undefined }
            : lastErrorCategory
              ? { lastErrorCategory }
              : {}),
          ...(lastEditErrorCategory === null
            ? { lastEditErrorCategory: undefined }
            : lastEditErrorCategory
              ? { lastEditErrorCategory }
              : {}),
          updatedAt: new Date().toISOString()
        });

        await writeFileImplementation(
          temporaryMetadataPath,
          `${JSON.stringify(next, null, 2)}\n`,
          { flag: "wx", mode: 0o600, encoding: "utf8" }
        );
        await rename(temporaryMetadataPath, metadataPath);
        return next;
      } catch (error) {
        await rm(temporaryMetadataPath, { force: true }).catch(() => undefined);
        throw new DocumentStorageError("Document metadata could not be updated", {
          cause: error
        });
      }
    }
  };
}

export type DocumentStorage = ReturnType<typeof createDocumentStorage>;
