import { randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import type { DocumentStorage } from "./document-storage.js";

export const TERMINAL_EDIT_ACTIVITY_STATUSES = [
  "succeeded",
  "no_change",
  "failed"
] as const;

export type TerminalEditActivityStatus =
  (typeof TERMINAL_EDIT_ACTIVITY_STATUSES)[number];
export type EditActivityStatus = "started" | TerminalEditActivityStatus;

export interface EditActivityRecord {
  activityId: string;
  type: "document_edit";
  discordMessageId: string;
  discordThreadId: string;
  requestedByUserId: string;
  instruction?: string;
  status: EditActivityStatus;
  createdAt: string;
  completedAt?: string;
  changesSummary?: string;
  changedSectionCount?: number;
  errorCategory?: string;
}

export type EditActivityState =
  | { state: "none" }
  | { state: "started"; record: EditActivityRecord }
  | { state: "terminal"; record: EditActivityRecord };

const activitySchema = z.object({
  activityId: z.string().min(1).max(100),
  type: z.literal("document_edit"),
  discordMessageId: z.string().min(1).max(100),
  discordThreadId: z.string().min(1).max(100),
  requestedByUserId: z.string().min(1).max(100),
  instruction: z.string().max(2_000).optional(),
  status: z.enum(["started", ...TERMINAL_EDIT_ACTIVITY_STATUSES]),
  createdAt: z.string(),
  completedAt: z.string().optional(),
  changesSummary: z.string().max(1_000).optional(),
  changedSectionCount: z.number().int().nonnegative().optional(),
  errorCategory: z.string().min(1).max(100).optional()
});

function activityPath(storage: DocumentStorage, documentId: string): string {
  const documentsRoot = path.join(storage.rootDirectory, "documents");
  const file = path.join(documentsRoot, documentId, "activity.jsonl");
  const relative = path.relative(documentsRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Activity path escaped the document storage root");
  }
  return file;
}

export function sanitizeActivityText(value: string, maximumLength: number): string {
  return value
    .replace(/<[^>]*>/g, "[redacted]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_ -]?key|token|secret|authorization)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximumLength);
}

export interface EditActivityRepository {
  createActivityId(): string;
  getState(documentId: string, discordMessageId: string): Promise<EditActivityState>;
  append(documentId: string, record: EditActivityRecord): Promise<void>;
}

export function createEditActivityRepository({
  storage,
  logger
}: {
  storage: DocumentStorage;
  logger: Logger;
}): EditActivityRepository {
  const appendTails = new Map<string, Promise<void>>();

  return {
    createActivityId: randomUUID,

    async getState(documentId, discordMessageId) {
      let text: string;
      try {
        text = await readFile(activityPath(storage, documentId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { state: "none" };
        }
        throw error;
      }

      let started: EditActivityRecord | undefined;
      let terminal: EditActivityRecord | undefined;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        const parsed = activitySchema.safeParse(
          (() => {
            try {
              return JSON.parse(line) as unknown;
            } catch {
              return undefined;
            }
          })()
        );
        if (!parsed.success) {
          logger.error(
            {
              event: "document_activity_corrupt",
              documentId,
              errorCategory: "corrupt_activity"
            },
            "Stored document activity contains an invalid record"
          );
          continue;
        }
        if (parsed.data.discordMessageId !== discordMessageId) continue;
        if (parsed.data.status === "started") started = parsed.data;
        else terminal = parsed.data;
      }

      if (terminal) return { state: "terminal", record: terminal };
      if (started) return { state: "started", record: started };
      return { state: "none" };
    },

    async append(documentId, record) {
      const safeRecord = activitySchema.parse({
        ...record,
        ...(record.instruction
          ? { instruction: sanitizeActivityText(record.instruction, 2_000) }
          : {}),
        ...(record.changesSummary
          ? { changesSummary: sanitizeActivityText(record.changesSummary, 1_000) }
          : {})
      });
      const previous = appendTails.get(documentId) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(() =>
          appendFile(
            activityPath(storage, documentId),
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
