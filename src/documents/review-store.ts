import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import type { DocumentStorage } from "./document-storage.js";

export const REVIEW_STATUSES = [
  "generating",
  "pending",
  "decision_processing",
  "approved",
  "rejected",
  "completed",
  "failed",
  "expired",
  "ambiguous"
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewDecision = "approved" | "rejected";

export interface SafeProposedChange {
  changeId: string;
  operation: "edit" | "create" | "delete";
  oldText?: string;
  newText?: string;
  explanation?: string;
  chunkPosition?: number;
}

export interface PendingReview {
  reviewId: string;
  documentId: string;
  discordThreadId: string;
  discordInstructionMessageId: string;
  discordReviewMessageId: string;
  requestedByUserId: string;
  instructionPreview: string;
  superdocsJobId: string;
  changeIds: string[];
  proposedChanges: SafeProposedChange[];
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  decision?: ReviewDecision;
  decidedAt?: string;
  safeErrorCategory?: string;
}

const plainText = z.string().max(600).refine(
  (value) => !/<\/?[a-z][^>]*>/i.test(value),
  "Review previews must contain plain text only"
);

const proposedChangeSchema = z.object({
  changeId: z.string().min(1).max(200),
  operation: z.enum(["edit", "create", "delete"]),
  oldText: plainText.optional(),
  newText: plainText.optional(),
  explanation: plainText.optional(),
  chunkPosition: z.number().int().nonnegative().optional()
});

export const pendingReviewSchema = z.object({
  reviewId: z.string().min(1).max(100),
  documentId: z.string().min(1).max(100),
  discordThreadId: z.string().min(1).max(100),
  discordInstructionMessageId: z.string().min(1).max(100),
  discordReviewMessageId: z.string().min(1).max(100),
  requestedByUserId: z.string().min(1).max(100),
  instructionPreview: plainText,
  superdocsJobId: z.string().min(1).max(500),
  changeIds: z.array(z.string().min(1).max(200)).max(2_000),
  proposedChanges: z.array(proposedChangeSchema).max(2_000),
  status: z.enum(REVIEW_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  decision: z.enum(["approved", "rejected"]).optional(),
  decidedAt: z.string().optional(),
  safeErrorCategory: z.string().min(1).max(100).optional()
});

const UNRESOLVED_STATUSES = new Set<ReviewStatus>([
  "generating",
  "pending",
  "decision_processing",
  "ambiguous"
]);

const BASIC_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " "
};

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isSafeInteger(code) && code >= 32 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => {
      const code = Number.parseInt(digits, 16);
      return Number.isSafeInteger(code) && code >= 32 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, name: string) =>
      BASIC_ENTITIES[name.toLowerCase()] ?? " "
    );
}

export function sanitizeReviewText(value: string, maximumLength = 500): string {
  const withoutExecutableBlocks = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ");
  const decoded = decodeEntities(withoutExecutableBlocks.replace(/<[^>]*>/g, " "));
  const plain = decoded
    .replace(/<[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(api[_ -]?key|token|secret|authorization)\s*[:=]\s*\S+/gi,
      "$1=[redacted]"
    )
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("@", "＠")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= maximumLength
    ? plain
    : `${plain.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function reviewPath(storage: DocumentStorage, documentId: string): string {
  const documentsRoot = path.join(storage.rootDirectory, "documents");
  const file = path.join(documentsRoot, documentId, "pending-review.json");
  const relative = path.relative(documentsRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Review path escaped the document storage root");
  }
  return file;
}

export class ReviewStoreError extends Error {
  constructor(
    public readonly category:
      | "corrupt_review"
      | "review_conflict"
      | "review_not_found"
      | "review_write_failed",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReviewStoreError";
  }
}

export interface ReviewStore {
  createReviewId(): string;
  read(documentId: string): Promise<PendingReview | undefined>;
  find(reviewId: string): Promise<PendingReview | undefined>;
  create(review: PendingReview): Promise<PendingReview>;
  replace(
    review: PendingReview,
    expectedStatuses?: readonly ReviewStatus[]
  ): Promise<PendingReview>;
  list(): Promise<PendingReview[]>;
}

export function createReviewStore({
  storage,
  logger
}: {
  storage: DocumentStorage;
  logger: Logger;
}): ReviewStore {
  const tails = new Map<string, Promise<unknown>>();
  const documentIdByReviewId = new Map<string, string>();

  async function readReview(documentId: string): Promise<PendingReview | undefined> {
    try {
      const parsed = pendingReviewSchema.parse(
        JSON.parse(await readFile(reviewPath(storage, documentId), "utf8"))
      );
      documentIdByReviewId.set(parsed.reviewId, parsed.documentId);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      logger.error(
        { event: "pending_review_corrupt", documentId, errorCategory: "corrupt_review" },
        "Pending review could not be loaded"
      );
      return undefined;
    }
  }

  async function serialized<T>(documentId: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(documentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    tails.set(documentId, next);
    try {
      return await next;
    } finally {
      if (tails.get(documentId) === next) tails.delete(documentId);
    }
  }

  async function writeReview(review: PendingReview): Promise<PendingReview> {
    const parsed = pendingReviewSchema.parse({
      ...review,
      instructionPreview: sanitizeReviewText(review.instructionPreview, 500),
      proposedChanges: review.proposedChanges.map((change) => ({
        ...change,
        ...(change.oldText
          ? { oldText: sanitizeReviewText(change.oldText, 450) }
          : {}),
        ...(change.newText
          ? { newText: sanitizeReviewText(change.newText, 450) }
          : {}),
        ...(change.explanation
          ? { explanation: sanitizeReviewText(change.explanation, 350) }
          : {})
      }))
    });
    const target = reviewPath(storage, parsed.documentId);
    const temporary = path.join(
      path.dirname(target),
      `.pending-review.${randomUUID()}.tmp`
    );
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
        encoding: "utf8"
      });
      await rename(temporary, target);
      documentIdByReviewId.set(parsed.reviewId, parsed.documentId);
      return parsed;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ReviewStoreError(
        "review_write_failed",
        "Pending review could not be written",
        { cause: error }
      );
    }
  }

  const repository: ReviewStore = {
    createReviewId: randomUUID,
    read: readReview,

    async find(reviewId) {
      const knownDocumentId = documentIdByReviewId.get(reviewId);
      if (knownDocumentId) {
        const review = await readReview(knownDocumentId);
        return review?.reviewId === reviewId ? review : undefined;
      }
      const reviews = await repository.list();
      return reviews.find((review) => review.reviewId === reviewId);
    },

    async create(review) {
      return serialized(review.documentId, async () => {
        const existing = await readReview(review.documentId);
        if (existing && UNRESOLVED_STATUSES.has(existing.status)) {
          throw new ReviewStoreError(
            "review_conflict",
            "An unresolved review already exists for this document"
          );
        }
        return writeReview(review);
      });
    },

    async replace(review, expectedStatuses) {
      return serialized(review.documentId, async () => {
        const existing = await readReview(review.documentId);
        if (!existing || existing.reviewId !== review.reviewId) {
          throw new ReviewStoreError("review_not_found", "Pending review was not found");
        }
        if (expectedStatuses && !expectedStatuses.includes(existing.status)) {
          throw new ReviewStoreError(
            "review_conflict",
            "Pending review status changed before it could be updated"
          );
        }
        return writeReview({ ...review, updatedAt: new Date().toISOString() });
      });
    },

    async list() {
      const root = path.join(storage.rootDirectory, "documents");
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const reviews: PendingReview[] = [];
      for (const entry of entries.filter(
        (item) => item.isDirectory() && !item.name.startsWith(".")
      )) {
        const review = await readReview(entry.name);
        if (review) reviews.push(review);
      }
      return reviews;
    }
  };
  return repository;
}

export function isUnresolvedReview(review: PendingReview | undefined): boolean {
  return Boolean(review && UNRESOLVED_STATUSES.has(review.status));
}
