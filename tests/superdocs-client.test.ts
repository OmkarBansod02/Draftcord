import { describe, expect, it, vi } from "vitest";

import {
  createSuperDocsClient,
  createSuperDocsSessionId
} from "../src/superdocs/client.js";

const apiBaseUrl = "https://superdocs.example/v1";
const originalPath = "/verified/document/original.docx";
const bytes = Buffer.from("verified docx bytes");

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function clientWithFetch(fetchImplementation: typeof fetch) {
  return createSuperDocsClient({
    apiKey: "test-api-key",
    apiBaseUrl,
    fetchImplementation,
    readFileImplementation: vi.fn(async () => bytes)
  });
}

function successfulFetch(processBody: Record<string, unknown> = {}) {
  return vi
    .fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 500 })
    )
    .mockResolvedValueOnce(
      jsonResponse({
        upload_id: "upload-1",
        upload_url: "https://uploads.example/presigned-secret"
      })
    )
    .mockResolvedValueOnce(new Response(null, { status: 200 }))
    .mockResolvedValueOnce(
      jsonResponse({
        status: "ready",
        chunks_count: 7,
        warnings: [],
        ...processBody
      })
    );
}

describe("SuperDocs client", () => {
  it("uses the pre-signed flow, uploads binary bytes, and returns process details", async () => {
    const fetchImplementation = successfulFetch({ document_id: "sd-doc-1" });
    const result = await clientWithFetch(fetchImplementation as unknown as typeof fetch).ingestStoredDocument({
      documentId: "document-123",
      originalPath,
      filename: "proposal.docx"
    });

    expect(result).toEqual({
      superdocsSessionId: "draftcord-document-123",
      uploadId: "upload-1",
      processingStatus: "ready",
      chunkCount: 7,
      superdocsDocumentId: "sd-doc-1",
      warningsCount: 0
    });

    const uploadRequest = fetchImplementation.mock.calls[0];
    expect(uploadRequest?.[0]).toBe(`${apiBaseUrl}/uploads`);
    expect(JSON.parse(String(uploadRequest?.[1]?.body))).toEqual({
      filename: "proposal.docx",
      content_type:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size_bytes: bytes.byteLength,
      purpose: "document"
    });

    const binaryRequest = fetchImplementation.mock.calls[1];
    expect(binaryRequest?.[0]).toBe(
      "https://uploads.example/presigned-secret"
    );
    expect(binaryRequest?.[1]?.method).toBe("PUT");
    expect(Buffer.from(binaryRequest?.[1]?.body as Uint8Array)).toEqual(bytes);

    const processRequest = fetchImplementation.mock.calls[2];
    expect(processRequest?.[0]).toBe(
      `${apiBaseUrl}/uploads/upload-1/process`
    );
    expect(JSON.parse(String(processRequest?.[1]?.body))).toEqual({
      session_id: "draftcord-document-123",
      filename: "proposal.docx",
      parse_mode: "document",
      return_html: false
    });
  });

  it("accepts nullable warnings", async () => {
    const result = await clientWithFetch(
      successfulFetch({ warnings: null }) as unknown as typeof fetch
    ).ingestStoredDocument({
      documentId: "document-123",
      originalPath,
      filename: "proposal.docx"
    });
    expect(result.warningsCount).toBe(0);
  });

  it("accepts a process response without an optional document ID", async () => {
    const result = await clientWithFetch(successfulFetch() as unknown as typeof fetch).ingestStoredDocument({
      documentId: "document-123",
      originalPath,
      filename: "proposal.docx"
    });
    expect(result.superdocsDocumentId).toBeUndefined();
  });

  it("rejects a non-2xx upload request without exposing its body", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("external secret body", { status: 403 })
    ) as unknown as typeof fetch;
    await expect(
      clientWithFetch(fetchImplementation).ingestStoredDocument({
        documentId: "document-123",
        originalPath,
        filename: "proposal.docx"
      })
    ).rejects.toMatchObject({ category: "upload_request_http_error", status: 403 });
  });

  it("reports a binary PUT failure", async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          upload_id: "upload-1",
          upload_url: "https://uploads.example/presigned"
        })
      )
      .mockResolvedValueOnce(new Response("denied", { status: 500 })) as unknown as typeof fetch;
    await expect(
      clientWithFetch(fetchImplementation).ingestStoredDocument({
        documentId: "document-123",
        originalPath,
        filename: "proposal.docx"
      })
    ).rejects.toMatchObject({ category: "binary_upload_http_error", status: 500 });
  });

  it("reports a processing non-2xx response", async () => {
    const fetchImplementation = vi.fn()
      .mockResolvedValueOnce(
        jsonResponse({
          upload_id: "upload-1",
          upload_url: "https://uploads.example/presigned"
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response("failed", { status: 502 })) as unknown as typeof fetch;
    await expect(
      clientWithFetch(fetchImplementation).ingestStoredDocument({
        documentId: "document-123",
        originalPath,
        filename: "proposal.docx"
      })
    ).rejects.toMatchObject({ category: "processing_http_error", status: 502 });
  });

  it("aborts a timed out request", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    ) as unknown as typeof fetch;
    const client = createSuperDocsClient({
      apiKey: "test-api-key",
      apiBaseUrl,
      fetchImplementation,
      readFileImplementation: vi.fn(async () => bytes),
      requestTimeoutMs: 5
    });
    await expect(
      client.ingestStoredDocument({
        documentId: "document-123",
        originalPath,
        filename: "proposal.docx"
      })
    ).rejects.toMatchObject({ category: "upload_request_timeout" });
  });

  it("rejects malformed JSON", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("not json", { status: 200 })
    ) as unknown as typeof fetch;
    await expect(
      clientWithFetch(fetchImplementation).ingestStoredDocument({
        documentId: "document-123",
        originalPath,
        filename: "proposal.docx"
      })
    ).rejects.toMatchObject({ category: "upload_request_invalid_response" });
  });

  it("generates deterministic session IDs", () => {
    expect(createSuperDocsSessionId("abc-123")).toBe("draftcord-abc-123");
    expect(createSuperDocsSessionId("abc-123")).toBe("draftcord-abc-123");
  });
});
