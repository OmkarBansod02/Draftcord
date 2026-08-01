import { open, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_EXPORT_DOWNLOAD_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 3;

export type ExportDownloadErrorCategory =
  | "download_invalid_url"
  | "download_redirect_limit"
  | "download_insecure_redirect"
  | "download_timeout"
  | "download_network"
  | "download_http_error"
  | "download_size_limit"
  | "download_empty_body"
  | "download_write_failed";

export class ExportDownloadError extends Error {
  constructor(
    public readonly category: ExportDownloadErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ExportDownloadError";
  }
}

export interface DownloadedExportFile {
  filePath: string;
  temporaryDirectory: string;
  byteSize: number;
  contentType?: string;
}

export interface DownloadExportOptions {
  url: string;
  temporaryParentDirectory: string;
  maxBytes: number;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
  maxRedirects?: number;
}

function validateHttpsUrl(value: string, category: "download_invalid_url" | "download_insecure_redirect"): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ExportDownloadError(category, "Export download URL is invalid", undefined, {
      cause: error
    });
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ExportDownloadError(
      category,
      "Export download URL must use HTTPS and must not contain credentials"
    );
  }
  return parsed;
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a safe positive integer");
  }
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function removeTemporaryExport(file: DownloadedExportFile): Promise<void> {
  await rm(file.temporaryDirectory, { recursive: true, force: true });
}

export async function downloadExportToTemporaryFile({
  url,
  temporaryParentDirectory,
  maxBytes,
  fetchImplementation = fetch,
  requestTimeoutMs = DEFAULT_EXPORT_DOWNLOAD_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS
}: DownloadExportOptions): Promise<DownloadedExportFile> {
  validateLimit(maxBytes);
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new Error("maxRedirects must be a non-negative safe integer");
  }

  let currentUrl = validateHttpsUrl(url, "download_invalid_url");
  await mkdir(temporaryParentDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(
    path.join(temporaryParentDirectory, `.export-download-${randomUUID()}-`)
  );
  const filePath = path.join(temporaryDirectory, "download.bin");
  let completed = false;

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const controller = new AbortController();
      let timedOut = false;
      let rejectTimeout!: (reason?: unknown) => void;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        rejectTimeout(new Error("Export download timed out"));
      }, requestTimeoutMs);

      try {
        let response: Response;
        try {
          response = await Promise.race([
            fetchImplementation(currentUrl.toString(), {
              method: "GET",
              redirect: "manual",
              headers: { Accept: "application/octet-stream, application/pdf" },
              signal: controller.signal
            }),
            timeoutPromise
          ]);
        } catch (error) {
          throw new ExportDownloadError(
            timedOut ? "download_timeout" : "download_network",
            timedOut ? "Export download timed out" : "Export download request failed",
            undefined,
            { cause: error }
          );
        }

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          await cancelBody(response);
          if (redirectCount >= maxRedirects) {
            throw new ExportDownloadError(
              "download_redirect_limit",
              "Export download exceeded its redirect limit",
              response.status
            );
          }
          if (!location) {
            throw new ExportDownloadError(
              "download_http_error",
              "Export download redirect did not include a location",
              response.status
            );
          }
          let redirectedUrl: string;
          try {
            redirectedUrl = new URL(location, currentUrl).toString();
          } catch (error) {
            throw new ExportDownloadError(
              "download_insecure_redirect",
              "Export download redirect URL is invalid",
              response.status,
              { cause: error }
            );
          }
          currentUrl = validateHttpsUrl(
            redirectedUrl,
            "download_insecure_redirect"
          );
          continue;
        }

        if (!response.ok) {
          await cancelBody(response);
          throw new ExportDownloadError(
            "download_http_error",
            `Export download returned status ${response.status}`,
            response.status
          );
        }

        const declaredLength = contentLength(response);
        if (declaredLength !== undefined && declaredLength > maxBytes) {
          await cancelBody(response);
          throw new ExportDownloadError(
            "download_size_limit",
            "Export download exceeds the configured byte limit",
            response.status
          );
        }

        if (!response.body) {
          throw new ExportDownloadError(
            "download_empty_body",
            "Export download did not include a response body",
            response.status
          );
        }

        const handle = await open(filePath, "wx", 0o600);
        let byteSize = 0;
        try {
          const reader = response.body.getReader();
          for (;;) {
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
              next = await Promise.race([reader.read(), timeoutPromise]);
            } catch (error) {
              await reader.cancel().catch(() => undefined);
              throw new ExportDownloadError(
                timedOut ? "download_timeout" : "download_network",
                timedOut ? "Export download timed out" : "Export download stream failed",
                response.status,
                { cause: error }
              );
            }
            if (next.done) break;
            byteSize += next.value.byteLength;
            if (byteSize > maxBytes) {
              await reader.cancel().catch(() => undefined);
              throw new ExportDownloadError(
                "download_size_limit",
                "Export download exceeds the configured byte limit",
                response.status
              );
            }
            try {
              await handle.write(next.value);
            } catch (error) {
              throw new ExportDownloadError(
                "download_write_failed",
                "Export download could not be written safely",
                response.status,
                { cause: error }
              );
            }
          }

          if (byteSize === 0) {
            throw new ExportDownloadError(
              "download_empty_body",
              "Export download was empty",
              response.status
            );
          }
          completed = true;
          return {
            filePath,
            temporaryDirectory,
            byteSize,
            ...(response.headers.get("content-type")
              ? { contentType: response.headers.get("content-type") as string }
              : {})
          };
        } finally {
          await handle.close().catch(() => undefined);
        }
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    if (!completed) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
  }
}
