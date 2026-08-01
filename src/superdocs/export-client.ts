import type { Logger } from "pino";
import { z } from "zod";

import type { SuperDocsConfig } from "./config.js";

const DEFAULT_EXPORT_REQUEST_TIMEOUT_MS = 30_000;

const exportResponseSchema = z.object({
  download_url: z.string().min(1),
  expires_at: z.string().min(1),
  expires_in_seconds: z.number().int().positive(),
  filename: z.string().min(1).max(200),
  format: z.enum(["docx", "pdf"]),
  // SuperDocs may include this convenience field. It is intentionally not
  // represented in the returned value and is never logged or persisted.
  curl_example: z.unknown().optional()
});

export type SuperDocsExportFormat = "docx" | "pdf";

export interface SuperDocsExportResult {
  downloadUrl: string;
  expiresAt: string;
  expiresInSeconds: number;
  filename: string;
  format: SuperDocsExportFormat;
}

export interface SuperDocsExportInput {
  sessionId: string;
  format: SuperDocsExportFormat;
  filename: string;
}

export type SuperDocsExportErrorCategory =
  | "export_timeout"
  | "export_network"
  | "export_authentication"
  | "export_permission"
  | "export_not_found"
  | "export_validation"
  | "export_rate_limited"
  | "export_server_error"
  | "export_http_error"
  | "export_invalid_response"
  | "export_invalid_download_url";

export class SuperDocsExportError extends Error {
  constructor(
    public readonly category: SuperDocsExportErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "SuperDocsExportError";
  }
}

export interface SuperDocsExportClient {
  createExport(input: SuperDocsExportInput): Promise<SuperDocsExportResult>;
  exportDocument(input: SuperDocsExportInput): Promise<SuperDocsExportResult>;
}

interface SuperDocsExportClientOptions extends Pick<SuperDocsConfig, "apiKey" | "apiBaseUrl"> {
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
  logger?: Logger;
}

function categoryForStatus(status: number): SuperDocsExportErrorCategory {
  if (status === 401) return "export_authentication";
  if (status === 403) return "export_permission";
  if (status === 404) return "export_not_found";
  if (status === 400 || status === 422) return "export_validation";
  if (status === 429) return "export_rate_limited";
  if (status >= 500) return "export_server_error";
  return "export_http_error";
}

async function timedFetch(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectTimeout!: (reason?: unknown) => void;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectTimeout(new Error("SuperDocs export request timed out"));
  }, timeoutMs);

  try {
    return await Promise.race([
      fetchImplementation(url, {
        ...init,
        signal: controller.signal
      }),
      timeoutPromise
    ]);
  } catch (error) {
    throw new SuperDocsExportError(
      timedOut ? "export_timeout" : "export_network",
      timedOut ? "SuperDocs export request timed out" : "SuperDocs export request failed",
      undefined,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonWithTimeout(
  response: Response,
  timeoutMs: number
): Promise<unknown> {
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.json(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          void response.body?.cancel().catch(() => undefined);
          reject(new Error("SuperDocs export response body timed out"));
        }, timeoutMs);
      })
    ]);
  } catch (error) {
    throw new SuperDocsExportError(
      timedOut ? "export_timeout" : "export_invalid_response",
      timedOut
        ? "SuperDocs export response timed out"
        : "SuperDocs export returned invalid JSON",
      response.status,
      { cause: error }
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createSuperDocsExportClient({
  apiKey,
  apiBaseUrl,
  fetchImplementation = fetch,
  requestTimeoutMs = DEFAULT_EXPORT_REQUEST_TIMEOUT_MS,
  logger
}: SuperDocsExportClientOptions): SuperDocsExportClient {
  async function createExport({
    sessionId,
    format,
    filename
  }: SuperDocsExportInput): Promise<SuperDocsExportResult> {
    const response = await timedFetch(
      fetchImplementation,
      `${apiBaseUrl}/downloads`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          session_id: sessionId,
          format,
          filename
        })
      },
      requestTimeoutMs
    );

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SuperDocsExportError(
        categoryForStatus(response.status),
        `SuperDocs export returned status ${response.status}`,
        response.status
      );
    }

    let body: unknown;
    body = await readJsonWithTimeout(response, requestTimeoutMs);

    const parsed = exportResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new SuperDocsExportError(
        "export_invalid_response",
        "SuperDocs export response did not match the expected schema",
        response.status
      );
    }
    if (parsed.data.format !== format) {
      throw new SuperDocsExportError(
        "export_invalid_response",
        "SuperDocs export returned an unexpected format",
        response.status
      );
    }

    let downloadUrl: URL;
    try {
      downloadUrl = new URL(parsed.data.download_url);
    } catch (error) {
      throw new SuperDocsExportError(
        "export_invalid_download_url",
        "SuperDocs export returned an invalid download URL",
        response.status,
        { cause: error }
      );
    }
    if (downloadUrl.protocol !== "https:") {
      throw new SuperDocsExportError(
        "export_invalid_download_url",
        "SuperDocs export download URL must use HTTPS",
        response.status
      );
    }

    const result = {
      downloadUrl: downloadUrl.toString(),
      expiresAt: parsed.data.expires_at,
      expiresInSeconds: parsed.data.expires_in_seconds,
      filename: parsed.data.filename,
      format: parsed.data.format
    } satisfies SuperDocsExportResult;
    logger?.info(
      {
        event: "superdocs_export_ready",
        format
      },
      "SuperDocs export is ready"
    );
    return result;
  }

  return {
    createExport,
    exportDocument: createExport
  };
}
