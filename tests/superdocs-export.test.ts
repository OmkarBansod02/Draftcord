import { describe, expect, it, vi } from "vitest";

import {
  createSuperDocsExportClient,
  type SuperDocsExportInput
} from "../src/superdocs/export-client.js";

const apiBaseUrl = "https://superdocs.example/v1";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const input: SuperDocsExportInput = {
  sessionId: "opaque-session-id",
  format: "docx",
  filename: "proposal-revised-v3"
};

describe("SuperDocs export client", () => {
  it("posts the current session and safe basename without document HTML", async () => {
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      download_url: "https://signed.example/export?token=secret",
      expires_at: "2026-07-31T12:00:00Z",
      expires_in_seconds: 900,
      filename: "server-name.docx",
      format: "docx",
      curl_example: "curl https://signed.example/export?token=secret"
    }));
    const client = createSuperDocsExportClient({
      apiKey: "api-key",
      apiBaseUrl,
      fetchImplementation: fetchMock as unknown as typeof fetch
    });

    const result = await client.createExport(input);
    expect(result).toEqual({
      downloadUrl: "https://signed.example/export?token=secret",
      expiresAt: "2026-07-31T12:00:00Z",
      expiresInSeconds: 900,
      filename: "server-name.docx",
      format: "docx"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${apiBaseUrl}/downloads`);
    expect(JSON.parse(String(init?.body))).toEqual({
      session_id: "opaque-session-id",
      format: "docx",
      filename: "proposal-revised-v3"
    });
    expect(String(init?.body)).not.toContain("document_html");
  });

  it("supports PDF and rejects insecure signed URLs without retrying", async () => {
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit
    ) => jsonResponse({
      download_url: "http://signed.example/export",
      expires_at: "2026-07-31T12:00:00Z",
      expires_in_seconds: 900,
      filename: "server-name.pdf",
      format: "pdf"
    }));
    const client = createSuperDocsExportClient({
      apiKey: "api-key",
      apiBaseUrl,
      fetchImplementation: fetchMock as unknown as typeof fetch
    });
    await expect(client.exportDocument({ ...input, format: "pdf" })).rejects.toMatchObject({
      category: "export_invalid_download_url"
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "export_authentication"],
    [403, "export_permission"],
    [404, "export_not_found"],
    [422, "export_validation"],
    [429, "export_rate_limited"],
    [503, "export_server_error"]
  ] as const)("classifies HTTP %i without retrying", async (status, category) => {
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit
    ) => new Response("secret upstream body", { status }));
    const client = createSuperDocsExportClient({
      apiKey: "api-key",
      apiBaseUrl,
      fetchImplementation: fetchMock as unknown as typeof fetch
    });
    await expect(client.createExport(input)).rejects.toMatchObject({ status, category });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects malformed responses", async () => {
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      _init?: RequestInit
    ) => new Response("not-json"));
    const client = createSuperDocsExportClient({
      apiKey: "api-key",
      apiBaseUrl,
      fetchImplementation: fetchMock as unknown as typeof fetch
    });
    await expect(client.createExport(input)).rejects.toMatchObject({
      category: "export_invalid_response"
    });
  });
});
