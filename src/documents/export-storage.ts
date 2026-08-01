import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { z } from "zod";

import type { ExportFormat } from "../discord/review-components.js";
import type { DocumentStorage } from "./document-storage.js";

export interface ExportMetadata {
  exportId: string;
  documentId: string;
  format: ExportFormat;
  editVersion: number;
  displayFilename: string;
  byteSize: number;
  sha256: string;
  createdAt: string;
  discordMessageId?: string;
  deliveredAt?: string;
}

export interface StoredExport {
  metadata: ExportMetadata;
  filePath: string;
  metadataPath: string;
}

const exportMetadataSchema = z.object({
  exportId: z.string().min(1).max(100),
  documentId: z.string().min(1).max(100),
  format: z.enum(["docx", "pdf"]),
  editVersion: z.number().int().nonnegative(),
  displayFilename: z.string().min(1).max(200),
  byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
  discordMessageId: z.string().min(1).max(100).optional(),
  deliveredAt: z.string().optional()
}).strict();

export class ExportStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExportStorageError";
  }
}

function documentsRoot(storage: DocumentStorage): string {
  return path.join(storage.rootDirectory, "documents");
}

function documentDirectory(storage: DocumentStorage, documentId: string): string {
  const root = documentsRoot(storage);
  const directory = path.join(root, documentId);
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ExportStorageError("Export document path escaped storage root");
  }
  return directory;
}

export function getExportPaths(
  storage: DocumentStorage,
  documentId: string,
  format: ExportFormat,
  editVersion: number
): { directory: string; filePath: string; metadataPath: string } {
  if (!Number.isSafeInteger(editVersion) || editVersion < 0) {
    throw new ExportStorageError("Export edit version is invalid");
  }
  const directory = path.join(
    documentDirectory(storage, documentId),
    "exports",
    `v${editVersion}`,
    format
  );
  const filePath = path.join(directory, `document.${format}`);
  const metadataPath = path.join(directory, "export-metadata.json");
  return { directory, filePath, metadataPath };
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function writeAtomic(filePath: string, contents: string): Promise<void> {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`
  );
  try {
    await writeFile(temporary, contents, {
      flag: "wx",
      mode: 0o600,
      encoding: "utf8"
    });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function hasOnlyExportMetadataKeys(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).every((key) => [
    "exportId",
    "documentId",
    "format",
    "editVersion",
    "displayFilename",
    "byteSize",
    "sha256",
    "createdAt",
    "discordMessageId",
    "deliveredAt"
  ].includes(key));
}

function isSafeDisplayFilename(
  value: string,
  format: ExportFormat
): boolean {
  return value.length > 0 &&
    value.length <= 200 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("..") &&
    !/[\u0000-\u001f\u007f@]/u.test(value) &&
    value.toLowerCase().endsWith(`.${format}`);
}

export interface ExportStorageOptions {
  generateId?: () => string;
  verifyFile?: (filePath: string, format: ExportFormat) => Promise<void>;
}

export interface ExportStorage {
  getExportPaths(
    documentId: string,
    format: ExportFormat,
    editVersion: number
  ): ReturnType<typeof getExportPaths>;
  readCachedExport(input: {
    documentId: string;
    format: ExportFormat;
    editVersion: number;
    maxBytes?: number;
  }): Promise<StoredExport | undefined>;
  storeVerifiedExport(input: {
    documentId: string;
    format: ExportFormat;
    editVersion: number;
    displayFilename: string;
    sourcePath: string;
  }): Promise<StoredExport>;
  markDelivered(
    stored: StoredExport,
    discordMessageId: string,
    deliveredAt?: string
  ): Promise<StoredExport>;
}

export function createExportStorage(
  storage: DocumentStorage,
  {
    generateId = randomUUID,
    verifyFile
  }: ExportStorageOptions = {}
): ExportStorage {
  async function readCachedExport({
    documentId,
    format,
    editVersion,
    maxBytes
  }: {
    documentId: string;
    format: ExportFormat;
    editVersion: number;
    maxBytes?: number;
  }): Promise<StoredExport | undefined> {
    const paths = getExportPaths(storage, documentId, format, editVersion);
    let raw: string;
    try {
      raw = await readFile(paths.metadataPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
    if (!hasOnlyExportMetadataKeys(parsedJson)) {
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
    const parsed = exportMetadataSchema.safeParse(parsedJson);
    if (
      !parsed.success ||
      parsed.data.documentId !== documentId ||
      parsed.data.format !== format ||
      parsed.data.editVersion !== editVersion ||
      !isSafeDisplayFilename(parsed.data.displayFilename, format) ||
      (maxBytes !== undefined && parsed.data.byteSize > maxBytes)
    ) {
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }

    try {
      const fileStats = await stat(paths.filePath);
      if (!fileStats.isFile() || fileStats.size !== parsed.data.byteSize) {
        throw new Error("Cached export file size did not match its metadata");
      }
      if (await sha256File(paths.filePath) !== parsed.data.sha256) {
        throw new Error("Cached export hash did not match its metadata");
      }
      await verifyFile?.(paths.filePath, format);
      return {
        metadata: parsed.data,
        filePath: paths.filePath,
        metadataPath: paths.metadataPath
      };
    } catch {
      await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
  }

  async function storeVerifiedExport({
    documentId,
    format,
    editVersion,
    displayFilename,
    sourcePath
  }: {
    documentId: string;
    format: ExportFormat;
    editVersion: number;
    displayFilename: string;
    sourcePath: string;
  }): Promise<StoredExport> {
    if (
      !displayFilename ||
      !isSafeDisplayFilename(displayFilename, format)
    ) {
      throw new ExportStorageError("Export display filename is unsafe");
    }
    const paths = getExportPaths(storage, documentId, format, editVersion);
    await mkdir(paths.directory, { recursive: true, mode: 0o700 });

    let fileStats;
    try {
      fileStats = await stat(sourcePath);
    } catch (error) {
      throw new ExportStorageError("Verified export file could not be read", {
        cause: error
      });
    }
    if (!fileStats.isFile() || fileStats.size <= 0) {
      throw new ExportStorageError("Verified export file is empty");
    }
    const metadata: ExportMetadata = {
      exportId: generateId(),
      documentId,
      format,
      editVersion,
      displayFilename,
      byteSize: fileStats.size,
      sha256: await sha256File(sourcePath),
      createdAt: new Date().toISOString()
    };
    const parsed = exportMetadataSchema.parse(metadata);

    try {
      await rename(sourcePath, paths.filePath);
      await writeAtomic(paths.metadataPath, `${JSON.stringify(parsed, null, 2)}\n`);
    } catch (error) {
      await rm(paths.filePath, { force: true }).catch(() => undefined);
      throw new ExportStorageError("Verified export could not be stored atomically", {
        cause: error
      });
    }

    return {
      metadata: parsed,
      filePath: paths.filePath,
      metadataPath: paths.metadataPath
    };
  }

  async function markDelivered(
    stored: StoredExport,
    discordMessageId: string,
    deliveredAt = new Date().toISOString()
  ): Promise<StoredExport> {
    const current = exportMetadataSchema.parse(
      JSON.parse(await readFile(stored.metadataPath, "utf8"))
    );
    if (
      current.exportId !== stored.metadata.exportId ||
      current.documentId !== stored.metadata.documentId ||
      current.format !== stored.metadata.format ||
      current.editVersion !== stored.metadata.editVersion
    ) {
      throw new ExportStorageError("Export metadata changed unexpectedly");
    }
    const updated = exportMetadataSchema.parse({
      ...current,
      discordMessageId,
      deliveredAt
    });
    await writeAtomic(stored.metadataPath, `${JSON.stringify(updated, null, 2)}\n`);
    return { ...stored, metadata: updated };
  }

  return {
    getExportPaths: (documentId, format, editVersion) =>
      getExportPaths(storage, documentId, format, editVersion),
    readCachedExport,
    storeVerifiedExport,
    markDelivered
  };
}

export { exportMetadataSchema };
