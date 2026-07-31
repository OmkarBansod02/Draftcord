import { randomUUID } from "node:crypto";
import {
  mkdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";

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
  status: "stored";
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
      const metadata: StoredDocumentMetadata = {
        documentId,
        originalFilename: input.originalFilename,
        ...(input.title ? { title: input.title } : {}),
        byteSize: documentBytes.byteLength,
        uploadedByUserId: input.uploadedByUserId,
        guildId: input.guildId,
        channelId: input.channelId,
        discordAttachmentId: input.discordAttachmentId,
        createdAt: new Date().toISOString(),
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
    }
  };
}

export type DocumentStorage = ReturnType<typeof createDocumentStorage>;
