import { MAX_DOCX_SIZE_BYTES } from "../discord/upload-validation.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

export type AttachmentDownloadErrorCode =
  | "invalid_url"
  | "timeout"
  | "network"
  | "http_error"
  | "too_many_redirects"
  | "empty_body"
  | "too_large";

export class AttachmentDownloadError extends Error {
  constructor(
    public readonly code: AttachmentDownloadErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AttachmentDownloadError";
  }
}

export interface DownloadAttachmentOptions {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

function parseHttpsUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new AttachmentDownloadError(
      "invalid_url",
      "Attachment URL is invalid"
    );
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new AttachmentDownloadError(
      "invalid_url",
      "Attachment URL must be HTTPS and must not contain credentials"
    );
  }

  return url;
}

export async function downloadAttachment({
  url: urlValue,
  maxBytes = MAX_DOCX_SIZE_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImplementation = fetch
}: DownloadAttachmentOptions): Promise<Buffer> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let currentUrl = parseHttpsUrl(urlValue);

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      let response: Response;

      try {
        response = await fetchImplementation(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal
        });
      } catch (error) {
        if (timedOut) {
          throw new AttachmentDownloadError(
            "timeout",
            "Attachment download timed out",
            { cause: error }
          );
        }

        throw new AttachmentDownloadError(
          "network",
          "Attachment download failed",
          { cause: error }
        );
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get("location");

        if (!location) {
          throw new AttachmentDownloadError(
            "http_error",
            "Attachment redirect did not include a location"
          );
        }

        if (redirectCount === MAX_REDIRECTS) {
          throw new AttachmentDownloadError(
            "too_many_redirects",
            "Attachment download exceeded the redirect limit"
          );
        }

        currentUrl = parseHttpsUrl(new URL(location, currentUrl).toString());
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new AttachmentDownloadError(
          "http_error",
          `Attachment server returned status ${response.status}`
        );
      }

      const declaredLength = response.headers.get("content-length");
      if (declaredLength !== null) {
        const parsedLength = Number(declaredLength);
        if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
          controller.abort();
          await response.body?.cancel().catch(() => undefined);
          throw new AttachmentDownloadError(
            "too_large",
            "Attachment exceeded the maximum size"
          );
        }
      }

      if (!response.body) {
        throw new AttachmentDownloadError(
          "empty_body",
          "Attachment response did not contain a body"
        );
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let byteSize = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          byteSize += value.byteLength;
          if (byteSize > maxBytes) {
            controller.abort();
            await reader.cancel().catch(() => undefined);
            throw new AttachmentDownloadError(
              "too_large",
              "Attachment exceeded the maximum size while downloading"
            );
          }

          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof AttachmentDownloadError) throw error;
        if (timedOut) {
          throw new AttachmentDownloadError(
            "timeout",
            "Attachment download timed out",
            { cause: error }
          );
        }
        throw new AttachmentDownloadError(
          "network",
          "Attachment response stream failed",
          { cause: error }
        );
      }

      if (byteSize === 0) {
        throw new AttachmentDownloadError(
          "empty_body",
          "Attachment response body was empty"
        );
      }

      return Buffer.concat(chunks, byteSize);
    }

    throw new AttachmentDownloadError(
      "too_many_redirects",
      "Attachment download exceeded the redirect limit"
    );
  } finally {
    clearTimeout(timeout);
  }
}
