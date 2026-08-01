import { describe, expect, it, vi } from "vitest";

import {
  createDiscordRestClient,
  DiscordApiError
} from "../src/discord/api.js";

describe("Discord export delivery", () => {
  it("posts the verified file as multipart form data with mentions disabled", async () => {
    const bytes = Buffer.from("verified-export-bytes");
    const fetchMock = vi.fn(async (
      _url: string | URL | Request,
      init?: RequestInit
    ) => {
      const form = init?.body as FormData;
      expect(JSON.parse(String(form.get("payload_json")))).toEqual({
        content: "📦 Revised document export",
        allowed_mentions: { parse: [] },
        attachments: [{ id: "0", filename: "proposal-revised-v3.pdf" }]
      });
      const file = form.get("files[0]");
      expect(file).toBeInstanceOf(File);
      expect((file as File).name).toBe("proposal-revised-v3.pdf");
      await expect((file as File).arrayBuffer()).resolves.toEqual(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      );
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bot bot-token");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      return new Response(JSON.stringify({ id: "message-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    const client = createDiscordRestClient({
      botToken: "bot-token",
      apiBaseUrl: "https://discord.example/api/v10",
      fetchImplementation: fetchMock as unknown as typeof fetch,
      readFileImplementation: vi.fn(async () => bytes)
    });

    await expect(client.uploadThreadFile({
      threadId: "thread-1",
      content: "📦 Revised document export",
      filePath: "/private/export.pdf",
      filename: "proposal-revised-v3.pdf",
      format: "pdf"
    })).resolves.toEqual({ id: "message-1" });
  });

  it("surfaces Discord upload errors without exposing response bodies", async () => {
    const fetchMock = vi.fn(async () => new Response("private details", { status: 413 }));
    const client = createDiscordRestClient({
      botToken: "bot-token",
      apiBaseUrl: "https://discord.example/api/v10",
      fetchImplementation: fetchMock as unknown as typeof fetch,
      readFileImplementation: vi.fn(async () => Buffer.from("bytes"))
    });
    await expect(client.uploadThreadFile({
      threadId: "thread-1",
      content: "export",
      filePath: "/private/export.docx",
      filename: "export.docx",
      format: "docx"
    })).rejects.toEqual(expect.objectContaining<Partial<DiscordApiError>>({
      status: 413,
      category: "http_error"
    }));
  });
});

