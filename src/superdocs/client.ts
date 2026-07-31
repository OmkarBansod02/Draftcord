import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

import { DOCX_MIME_TYPE } from "../discord/upload-validation.js";
import type { SuperDocsConfig } from "./config.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const uploadResponseSchema = z.object({
  upload_id: z.string().min(1),
  upload_url: z.url().refine((value) => new URL(value).protocol === "https:")
});

const processResponseSchema = z.object({
  status: z.string().min(1),
  chunks_count: z.number().int().nonnegative().nullable().optional(),
  document_id: z.string().min(1).nullable().optional(),
  warnings: z.array(z.unknown()).nullable().optional()
});

export type SuperDocsErrorCategory =
  | "upload_request_timeout"
  | "upload_request_network"
  | "upload_request_http_error"
  | "upload_request_invalid_response"
  | "binary_upload_timeout"
  | "binary_upload_network"
  | "binary_upload_http_error"
  | "processing_timeout"
  | "processing_network"
  | "processing_http_error"
  | "processing_invalid_response"
  | "stored_document_read_failed";

export class SuperDocsClientError extends Error {
  constructor(
    public readonly category: SuperDocsErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SuperDocsClientError";
  }
}

export interface SuperDocsIngestionResult {
  superdocsSessionId: string;
  uploadId: string;
  processingStatus: string;
  chunkCount?: number;
  superdocsDocumentId?: string;
  warningsCount: number;
}

export interface IngestStoredDocumentInput {
  documentId: string;
  originalPath: string;
  filename: string;
  interactionId?: string;
}

export interface SuperDocsClient {
  ingestStoredDocument(
    input: IngestStoredDocumentInput
  ): Promise<SuperDocsIngestionResult>;
}

interface SuperDocsClientOptions extends SuperDocsConfig {
  fetchImplementation?: typeof fetch;
  readFileImplementation?: (file: string) => Promise<Buffer>;
  requestTimeoutMs?: number;
  logger?: Logger;
}

type RequestOperation = "upload_request" | "binary_upload" | "processing";

export function createSuperDocsSessionId(documentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(documentId)) {
    throw new SuperDocsClientError(
      "stored_document_read_failed",
      "Draftcord document ID is not safe for a SuperDocs session"
    );
  }

  return `draftcord-${documentId}`;
}

function categoryFor(
  operation: RequestOperation,
  failure: "timeout" | "network" | "http_error" | "invalid_response"
): SuperDocsErrorCategory {
  return `${operation}_${failure}` as SuperDocsErrorCategory;
}

async function timedFetch(
  fetchImplementation: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
  operation: RequestOperation
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImplementation(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    throw new SuperDocsClientError(
      categoryFor(operation, timedOut ? "timeout" : "network"),
      timedOut
        ? `SuperDocs ${operation} timed out`
        : `SuperDocs ${operation} request failed`,
      undefined,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operation: Exclude<RequestOperation, "binary_upload">
): Promise<unknown> {
  const response = await timedFetch(
    fetchImplementation,
    url,
    init,
    timeoutMs,
    operation
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SuperDocsClientError(
      categoryFor(operation, "http_error"),
      `SuperDocs ${operation} returned status ${response.status}`,
      response.status
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new SuperDocsClientError(
      categoryFor(operation, "invalid_response"),
      `SuperDocs ${operation} returned invalid JSON`,
      response.status,
      { cause: error }
    );
  }
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  operation: Exclude<RequestOperation, "binary_upload">
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SuperDocsClientError(
      categoryFor(operation, "invalid_response"),
      `SuperDocs ${operation} response did not match the expected schema`
    );
  }
  return parsed.data;
}

export function createSuperDocsClient({
  apiKey,
  apiBaseUrl,
  fetchImplementation = fetch,
  readFileImplementation = (file) => readFile(file),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  logger
}: SuperDocsClientOptions): SuperDocsClient {
  return {
    async ingestStoredDocument(
      input: IngestStoredDocumentInput
    ): Promise<SuperDocsIngestionResult> {
      if (path.basename(input.originalPath) !== "original.docx") {
        throw new SuperDocsClientError(
          "stored_document_read_failed",
          "SuperDocs ingestion requires the verified stored original.docx"
        );
      }

      let bytes: Buffer;
      try {
        bytes = await readFileImplementation(input.originalPath);
      } catch (error) {
        throw new SuperDocsClientError(
          "stored_document_read_failed",
          "Verified stored original.docx could not be read",
          undefined,
          { cause: error }
        );
      }

      const sessionId = createSuperDocsSessionId(input.documentId);
      const logContext = {
        interactionId: input.interactionId,
        documentId: input.documentId,
        filename: input.filename,
        byteSize: bytes.byteLength
      };

      let startedAt = Date.now();
      const upload = parseResponse(
        uploadResponseSchema,
        await requestJson(
          fetchImplementation,
          `${apiBaseUrl}/uploads`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              filename: input.filename,
              content_type: DOCX_MIME_TYPE,
              size_bytes: bytes.byteLength,
              purpose: "document"
            })
          },
          requestTimeoutMs,
          "upload_request"
        ),
        "upload_request"
      );
      logger?.info(
        {
          event: "superdocs_upload_requested",
          ...logContext,
          durationMs: Date.now() - startedAt
        },
        "SuperDocs upload requested"
      );

      startedAt = Date.now();
      const binaryResponse = await timedFetch(
        fetchImplementation,
        upload.upload_url,
        {
          method: "PUT",
          headers: { "Content-Type": DOCX_MIME_TYPE },
          body: new Uint8Array(bytes)
        },
        requestTimeoutMs,
        "binary_upload"
      );
      if (!binaryResponse.ok) {
        await binaryResponse.body?.cancel().catch(() => undefined);
        throw new SuperDocsClientError(
          "binary_upload_http_error",
          `SuperDocs binary upload returned status ${binaryResponse.status}`,
          binaryResponse.status
        );
      }
      await binaryResponse.body?.cancel().catch(() => undefined);
      logger?.info(
        {
          event: "superdocs_binary_uploaded",
          ...logContext,
          durationMs: Date.now() - startedAt
        },
        "SuperDocs binary uploaded"
      );

      startedAt = Date.now();
      const processed = parseResponse(
        processResponseSchema,
        await requestJson(
          fetchImplementation,
          `${apiBaseUrl}/uploads/${encodeURIComponent(upload.upload_id)}/process`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              session_id: sessionId,
              filename: input.filename,
              parse_mode: "document",
              return_html: false
            })
          },
          requestTimeoutMs,
          "processing"
        ),
        "processing"
      );
      logger?.info(
        {
          event: "superdocs_document_processed",
          ...logContext,
          superdocsChunkCount: processed.chunks_count ?? undefined,
          warningsCount: processed.warnings?.length ?? 0,
          durationMs: Date.now() - startedAt
        },
        "SuperDocs document processed"
      );

      return {
        superdocsSessionId: sessionId,
        uploadId: upload.upload_id,
        processingStatus: processed.status,
        ...(processed.chunks_count !== null &&
        processed.chunks_count !== undefined
          ? { chunkCount: processed.chunks_count }
          : {}),
        ...(processed.document_id
          ? { superdocsDocumentId: processed.document_id }
          : {}),
        warningsCount: processed.warnings?.length ?? 0
      };
    }
  };
}
