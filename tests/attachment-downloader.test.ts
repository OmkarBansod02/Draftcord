import { describe, expect, it, vi } from "vitest";

import {
  downloadAttachment
} from "../src/documents/attachment-downloader.js";
import { MAX_DOCX_SIZE_BYTES } from "../src/discord/upload-validation.js";

const attachmentUrl = "https://cdn.discordapp.com/attachments/file.docx?signature=secret";

function fetchReturning(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("downloadAttachment", () => {
  it("downloads a successful response", async () => {
    const bytes = Buffer.from("bounded response");

    await expect(
      downloadAttachment({
        url: attachmentUrl,
        fetchImplementation: fetchReturning(new Response(bytes))
      })
    ).resolves.toEqual(bytes);
  });

  it("rejects an empty response body", async () => {
    await expect(
      downloadAttachment({
        url: attachmentUrl,
        fetchImplementation: fetchReturning(new Response(new Uint8Array()))
      })
    ).rejects.toMatchObject({
      code: "empty_body"
    });
  });

  it("rejects an HTTP non-2xx response", async () => {
    await expect(
      downloadAttachment({
        url: attachmentUrl,
        fetchImplementation: fetchReturning(
          new Response("not found", { status: 404 })
        )
      })
    ).rejects.toMatchObject({
      code: "http_error"
    });
  });

  it("reports a timed out request", async () => {
    const hangingFetch = vi.fn(
      async (_input: URL | RequestInfo, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    ) as unknown as typeof fetch;

    await expect(
      downloadAttachment({
        url: attachmentUrl,
        timeoutMs: 5,
        fetchImplementation: hangingFetch
      })
    ).rejects.toMatchObject({
      code: "timeout"
    });
  });

  it("rejects an aborted or failed request as a network failure", async () => {
    const failedFetch = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;

    await expect(
      downloadAttachment({
        url: attachmentUrl,
        fetchImplementation: failedFetch
      })
    ).rejects.toMatchObject({
      code: "network"
    });
  });

  it("stops a stream once it exceeds 10 MiB", async () => {
    let cancelled = false;
    const chunkSize = 1024 * 1024;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(chunkSize));
        if (emitted > 12) controller.close();
      },
      cancel() {
        cancelled = true;
      }
    });

    await expect(
      downloadAttachment({
        url: attachmentUrl,
        fetchImplementation: fetchReturning(new Response(body))
      })
    ).rejects.toMatchObject({
      code: "too_large"
    });
    // Web streams may prefetch one chunk, but cancellation must prevent the
    // producer from continuing through the full response.
    expect(emitted).toBeLessThanOrEqual(MAX_DOCX_SIZE_BYTES / chunkSize + 2);
    expect(cancelled).toBe(true);
  });

  it("rejects non-HTTPS URLs", async () => {
    const fetchImplementation = vi.fn() as unknown as typeof fetch;

    await expect(
      downloadAttachment({
        url: "http://cdn.discordapp.com/file.docx",
        fetchImplementation
      })
    ).rejects.toMatchObject({
      code: "invalid_url"
    });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects redirects to non-HTTPS URLs", async () => {
    await expect(
      downloadAttachment({
        url: attachmentUrl,
        fetchImplementation: fetchReturning(
          new Response(null, {
            status: 302,
            headers: { location: "http://example.com/file.docx" }
          })
        )
      })
    ).rejects.toMatchObject({
      code: "invalid_url"
    });
  });
});
