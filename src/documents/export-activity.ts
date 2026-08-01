import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { Logger } from "pino";

import type { ExportFormat } from "../discord/review-components.js";
import type { DocumentStorage } from "./document-storage.js";

export const EXPORT_ACTIVITY_STATUSES = [
  "started",
  "cached",
  "succeeded",
  "direct_link",
  "failed",
  "ambiguous"
] as const;

export type ExportActivityStatus = (typeof EXPORT_ACTIVITY_STATUSES)[number];

export interface ExportActivityRecord {
  activityId: string;
  type: "document_export";
  discordInteractionId: string;
  discordThreadId: string;
  requestedByUserId: string;
  format: ExportFormat;
  editVersion: number;
  status: ExportActivityStatus;
  createdAt: string;
  completedAt?: string;
  byteSize?: number;
  discordMessageId?: string;
  safeErrorCategory?: string;
}

export type ExportActivityState =
  | { state: "none" }
  | { state: "started"; record: ExportActivityRecord }
  | { state: "terminal"; record: ExportActivityRecord };

const exportActivitySchema = z.object({
  activityId: z.string().min(1).max(100),
  type: z.literal("document_export"),
  discordInteractionId: z.string().min(1).max(200),
  discordThreadId: z.string().min(1).max(100),
  requestedByUserId: z.string().min(1).max(100),
  format: z.enum(["docx", "pdf"]),
  editVersion: z.number().int().nonnegative(),
  status: z.enum(EXPORT_ACTIVITY_STATUSES),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  byteSize: z.number().int().positive().optional(),
  discordMessageId: z.string().min(1).max(100).optional(),
  safeErrorCategory: z.string().min(1).max(100).optional()
});

const TERMINAL_EXPORT_STATUSES = new Set<ExportActivityStatus>([
  "cached",
  "succeeded",
  "direct_link",
  "failed",
  "ambiguous"
]);

function exportActivityPath(storage: DocumentStorage, documentId: string): string {
  const documentsRoot = path.join(storage.rootDirectory, "documents");
  const file = path.join(documentsRoot, documentId, "export-activity.jsonl");
  const relative = path.relative(documentsRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Export activity path escaped the document storage root");
  }
  return file;
}

export interface ExportActivityRepository {
  createActivityId(): string;
  getState(documentId: string, discordInteractionId: string): Promise<ExportActivityState>;
  append(documentId: string, record: ExportActivityRecord): Promise<void>;
}

export function createExportActivityRepository({
  storage,
  logger
}: {
  storage: DocumentStorage;
  logger: Logger;
}): ExportActivityRepository {
  const appendTails = new Map<string, Promise<void>>();

  return {
    createActivityId: randomUUID,

    async getState(documentId, discordInteractionId) {
      let content: string;
      try {
        content = await readFile(exportActivityPath(storage, documentId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { state: "none" };
        }
        throw error;
      }

      let started: ExportActivityRecord | undefined;
      let terminal: ExportActivityRecord | undefined;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          logger.error(
            {
              event: "document_export_activity_corrupt",
              documentId,
              errorCategory: "corrupt_export_activity"
            },
            "Export activity contains invalid JSON"
          );
          continue;
        }
        const parsed = exportActivitySchema.safeParse(value);
        if (!parsed.success) {
          logger.error(
            {
              event: "document_export_activity_corrupt",
              documentId,
              errorCategory: "corrupt_export_activity"
            },
            "Export activity contains an invalid record"
          );
          continue;
        }
        if (parsed.data.discordInteractionId !== discordInteractionId) continue;
        if (parsed.data.status === "started") started = parsed.data;
        else if (TERMINAL_EXPORT_STATUSES.has(parsed.data.status)) terminal = parsed.data;
      }

      if (terminal) return { state: "terminal", record: terminal };
      if (started) return { state: "started", record: started };
      return { state: "none" };
    },

    async append(documentId, record) {
      const safeRecord = exportActivitySchema.parse(record);
      const previous = appendTails.get(documentId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() =>
          appendFile(
            exportActivityPath(storage, documentId),
            `${JSON.stringify(safeRecord)}\n`,
            { encoding: "utf8", flag: "a", mode: 0o600 }
          )
        );
      appendTails.set(documentId, next);
      try {
        await next;
      } finally {
        if (appendTails.get(documentId) === next) appendTails.delete(documentId);
      }
    }
  };
}

