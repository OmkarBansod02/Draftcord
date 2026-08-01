import type { Logger } from "pino";
import { z } from "zod";

import type { SuperDocsConfig } from "./config.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 1_750;
const DEFAULT_MAX_POLL_WAIT_MS = 5 * 60_000;

export const SUPERDOCS_JOB_STATUSES = [
  "pending",
  "in_progress",
  "awaiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const;

export type SuperDocsJobStatus = (typeof SUPERDOCS_JOB_STATUSES)[number];

const proposedChangeSchema = z.object({
  change_id: z.string().min(1).max(200),
  operation: z.enum(["edit", "create", "delete"]),
  old_html: z.string().nullable().optional(),
  new_html: z.string().nullable().optional(),
  ai_explanation: z.string().nullable().optional(),
  chunk_position: z.number().int().nonnegative().nullable().optional()
});

const jobMetadataSchema = z.object({
  awaiting_kind: z.string().nullable().optional(),
  pending_changes: z.array(proposedChangeSchema).nullable().optional()
});

const jobResultSchema = z.object({
  response: z.string().nullable().optional(),
  document_changes: z.object({
    changes_summary: z.string().nullable().optional()
  }).nullable().optional()
});

const startResponseSchema = z.object({
  job_id: z.string().min(1).max(500),
  status: z.enum(SUPERDOCS_JOB_STATUSES).optional()
});

const jobResponseSchema = z.object({
  job_id: z.string().min(1).max(500).optional(),
  status: z.enum(SUPERDOCS_JOB_STATUSES),
  metadata: jobMetadataSchema.nullable().optional(),
  result: jobResultSchema.nullable().optional(),
  error: z.unknown().optional()
});

export type SuperDocsProposedChange = z.infer<typeof proposedChangeSchema>;
export type SuperDocsReviewJob = z.infer<typeof jobResponseSchema>;

export type SuperDocsReviewErrorCategory =
  | `review_create_${"timeout" | "network" | "authentication" | "permission" | "validation" | "rate_limited" | "server_error" | "http_error" | "invalid_response"}`
  | `review_poll_${"timeout" | "network" | "authentication" | "permission" | "not_found" | "rate_limited" | "server_error" | "http_error" | "invalid_response"}`
  | `review_decision_${"timeout" | "network" | "authentication" | "permission" | "not_found" | "conflict" | "validation" | "rate_limited" | "server_error" | "http_error"}`
  | "review_poll_wait_timeout"
  | "review_job_failed"
  | "review_job_cancelled"
  | "continue_prompt_unsupported";

export class SuperDocsReviewError extends Error {
  constructor(
    public readonly category: SuperDocsReviewErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SuperDocsReviewError";
  }
}

export interface StartReviewInput {
  sessionId: string;
  instruction: string;
}

export interface ReviewDecisionInput {
  sessionId: string;
  jobId: string;
  changeIds: string[];
  approved: boolean;
}

export interface PollJobOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export interface SuperDocsReviewClient {
  startReview(input: StartReviewInput): Promise<{ jobId: string }>;
  getJob(jobId: string): Promise<SuperDocsReviewJob>;
  pollJob(jobId: string, options?: PollJobOptions): Promise<SuperDocsReviewJob>;
  decideReview(input: ReviewDecisionInput): Promise<void>;
}

interface ReviewClientOptions extends SuperDocsConfig {
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  maxPollWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  logger?: Logger;
}

type Operation = "review_create" | "review_poll" | "review_decision";

function statusCategory(operation: Operation, status: number): SuperDocsReviewErrorCategory {
  const suffix = status === 401
    ? "authentication"
    : status === 403 || status === 402
      ? "permission"
      : status === 404
        ? "not_found"
        : status === 409
          ? "conflict"
          : status === 400 || status === 422
            ? "validation"
            : status === 429
              ? "rate_limited"
              : status >= 500
                ? "server_error"
                : "http_error";
  return `${operation}_${suffix}` as SuperDocsReviewErrorCategory;
}

function isRetryablePollFailure(error: unknown): error is SuperDocsReviewError {
  return error instanceof SuperDocsReviewError && [
    "review_poll_timeout",
    "review_poll_network",
    "review_poll_rate_limited",
    "review_poll_server_error"
  ].includes(error.category);
}

async function timedFetch(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operation: Operation
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImplementation(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new SuperDocsReviewError(
      `${operation}_${timedOut ? "timeout" : "network"}` as SuperDocsReviewErrorCategory,
      timedOut ? "SuperDocs request timed out" : "SuperDocs request failed",
      undefined,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requireOk(response: Response, operation: Operation): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  throw new SuperDocsReviewError(
    statusCategory(operation, response.status),
    `SuperDocs returned status ${response.status}`,
    response.status
  );
}

async function parseJson<T>(
  response: Response,
  operation: "review_create" | "review_poll",
  schema: z.ZodType<T>,
  timeoutMs: number
): Promise<T> {
  await requireOk(response, operation);
  let value: unknown;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    value = await Promise.race([
      response.json(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void response.body?.cancel().catch(() => undefined);
          reject(new Error("response body timeout"));
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    throw new SuperDocsReviewError(
      `${operation}_${timedOut ? "timeout" : "invalid_response"}` as SuperDocsReviewErrorCategory,
      timedOut ? "SuperDocs response timed out" : "SuperDocs returned invalid JSON",
      response.status,
      { cause: error }
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SuperDocsReviewError(
      `${operation}_invalid_response`,
      "SuperDocs response did not match the expected schema",
      response.status
    );
  }
  return parsed.data;
}

export function createSuperDocsReviewClient({
  apiKey,
  apiBaseUrl,
  modelTier,
  thinkingDepth,
  fetchImplementation = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollWaitMs = DEFAULT_MAX_POLL_WAIT_MS,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  logger
}: ReviewClientOptions): SuperDocsReviewClient {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };

  const client: SuperDocsReviewClient = {
    async startReview({ sessionId, instruction }) {
      const startedAt = Date.now();
      const response = await timedFetch(
        fetchImplementation,
        `${apiBaseUrl}/chat/async`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            session_id: sessionId,
            message: instruction,
            approval_mode: "ask_every_time",
            response_mode: "compact",
            model_tier: modelTier,
            thinking_depth: thinkingDepth
          })
        },
        requestTimeoutMs,
        "review_create"
      );
      const parsed = await parseJson(
        response,
        "review_create",
        startResponseSchema,
        requestTimeoutMs
      );
      logger?.info(
        { event: "superdocs_review_job_created", durationMs: Date.now() - startedAt },
        "SuperDocs review job created"
      );
      return { jobId: parsed.job_id };
    },

    async getJob(jobId) {
      const response = await timedFetch(
        fetchImplementation,
        `${apiBaseUrl}/jobs/${encodeURIComponent(jobId)}`,
        { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
        requestTimeoutMs,
        "review_poll"
      );
      return parseJson(response, "review_poll", jobResponseSchema, requestTimeoutMs);
    },

    async pollJob(jobId, options = {}) {
      const startedAt = Date.now();
      const maximum = options.maxWaitMs ?? maxPollWaitMs;
      const interval = options.pollIntervalMs ?? pollIntervalMs;
      let attempt = 0;
      let waitedMs = 0;
      for (;;) {
        if (Math.max(Date.now() - startedAt, waitedMs) > maximum) {
          throw new SuperDocsReviewError(
            "review_poll_wait_timeout",
            "SuperDocs review polling exceeded its maximum wait"
          );
        }
        attempt += 1;
        let job: SuperDocsReviewJob;
        try {
          job = await client.getJob(jobId);
        } catch (error) {
          if (!isRetryablePollFailure(error)) throw error;
          logger?.warn(
            {
              event: "superdocs_review_poll_retry",
              pollingAttempt: attempt,
              durationMs: Date.now() - startedAt,
              errorCategory: error.category
            },
            "Transient SuperDocs review poll failed; retrying the read-only GET"
          );
          await sleep(interval);
          waitedMs += interval;
          continue;
        }
        logger?.info(
          {
            event: "superdocs_review_poll",
            status: job.status,
            pollingAttempt: attempt,
            durationMs: Date.now() - startedAt
          },
          "SuperDocs review job polled"
        );
        if (!["pending", "in_progress"].includes(job.status)) return job;
        await sleep(interval);
        waitedMs += interval;
      }
    },

    async decideReview({ sessionId, jobId, changeIds, approved }) {
      const response = await timedFetch(
        fetchImplementation,
        `${apiBaseUrl}/chat/${encodeURIComponent(sessionId)}/approve`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            job_id: jobId,
            approved,
            changes: changeIds.map((changeId) => ({
              change_id: changeId,
              approved
            }))
          })
        },
        requestTimeoutMs,
        "review_decision"
      );
      await requireOk(response, "review_decision");
      await response.body?.cancel().catch(() => undefined);
    }
  };
  return client;
}
