import { describe, expect, it, vi } from "vitest";

import {
  createDiscordRestClient,
  DiscordApiError
} from "../src/discord/api.js";
import {
  createDocumentThreadName,
  createDocumentThreadUrl,
  createWorkspaceWelcomeMessage
} from "../src/discord/document-threads.js";

const apiBaseUrl = "https://discord.example/api/v10";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function client(fetchImplementation: typeof fetch) {
  return createDiscordRestClient({
    botToken: "test-bot-token",
    apiBaseUrl,
    fetchImplementation
  });
}

describe("Discord document threads", () => {
  it("explicitly creates a public thread with a one-day archive duration", async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) =>
      jsonResponse({ id: "thread-1", name: "Proposal · abc12345" })
    );
    await client(fetchMock as unknown as typeof fetch).createPublicThread({
      channelId: "channel-1",
      name: "Proposal · abc12345"
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      type: 11,
      auto_archive_duration: 1440
    });
  });

  it("generates a safe name from the title", () => {
    const name = createDocumentThreadName({
      documentId: "abcdef12-3456",
      title: "**@everyone** ../ Implementation\nProposal",
      originalFilename: "fallback.docx"
    });
    expect(name).toContain("＠everyone");
    expect(name).toContain("Implementation Proposal");
    expect(name).not.toMatch(/[*@/\\\n]/);
  });

  it("limits thread names to 100 characters", () => {
    expect(
      createDocumentThreadName({
        documentId: "abcdef12-3456",
        title: "x".repeat(200),
        originalFilename: "fallback.docx"
      })
    ).toHaveLength(100);
  });

  it("falls back to the filename without its DOCX extension", () => {
    const name = createDocumentThreadName({
      documentId: "abcdef12-3456",
      originalFilename: "Implementation Proposal.docx"
    });
    expect(name).toBe("Implementation Proposal · abcdef12");
  });

  it("removes path traversal and mention-like filename content", () => {
    const name = createDocumentThreadName({
      documentId: "abcdef12-3456",
      originalFilename: "../../@everyone\\proposal.docx"
    });
    expect(name).toBe("proposal · abcdef12");
    expect(name).not.toMatch(/@|\.\.|[/\\]/);
  });

  it("adds the owner and posts a welcome message with mentions disabled", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ id: "message-1" }));
    const discord = client(fetchMock as unknown as typeof fetch);

    await discord.addThreadMember("thread-1", "owner-1");
    await discord.createThreadMessage(
      "thread-1",
      createWorkspaceWelcomeMessage({
        title: "Implementation Proposal",
        originalFilename: "proposal.docx",
        documentId: "document-1",
        byteSize: 2048,
        chunkCount: 7
      })
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${apiBaseUrl}/channels/thread-1/thread-members/owner-1`
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    const messageBody = JSON.parse(
      String(fetchMock.mock.calls[1]?.[1]?.body)
    );
    expect(messageBody.allowed_mentions).toEqual({ parse: [] });
    expect(messageBody.content).toContain("Structure: 7 document chunks detected");
    expect(messageBody.content).toContain("Phase 4");
  });

  it("builds a Discord thread URL", () => {
    expect(createDocumentThreadUrl("123", "456")).toBe(
      "https://discord.com/channels/123/456"
    );
  });

  it("categorizes a thread creation 403", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("forbidden details", { status: 403 })
    ) as unknown as typeof fetch;
    await expect(
      client(fetchImplementation).createPublicThread({
        channelId: "channel-1",
        name: "Proposal"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<DiscordApiError>>({
        category: "forbidden",
        status: 403
      })
    );
  });

  it("categorizes a rate-limit response without retrying", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("rate limit details", { status: 429 })
    );
    await expect(
      client(fetchMock as unknown as typeof fetch).createPublicThread({
        channelId: "channel-1",
        name: "Proposal"
      })
    ).rejects.toMatchObject({ category: "rate_limited", status: 429 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("surfaces owner member-addition failure", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response(null, { status: 404 })
    ) as unknown as typeof fetch;
    await expect(
      client(fetchImplementation).addThreadMember("thread-1", "owner-1")
    ).rejects.toMatchObject({ category: "not_found" });
  });

  it("surfaces welcome-message failure", async () => {
    const fetchImplementation = vi.fn(async () =>
      new Response("server details", { status: 500 })
    ) as unknown as typeof fetch;
    await expect(
      client(fetchImplementation).createThreadMessage("thread-1", "Welcome")
    ).rejects.toMatchObject({ category: "server_error" });
  });
});
