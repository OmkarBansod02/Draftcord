import { describe, expect, it, vi } from "vitest";

import { createSuperDocsClient } from "../src/superdocs/client.js";
import { createSuperDocsConfig } from "../src/superdocs/config.js";

const apiBaseUrl = "https://superdocs.example/v1";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function editingClient(fetchImplementation: typeof fetch, timeout = 100) {
  return createSuperDocsClient({
    apiKey: "test-key",
    apiBaseUrl,
    modelTier: "pro",
    thinkingDepth: "deep",
    fetchImplementation,
    editRequestTimeoutMs: timeout
  });
}

describe("SuperDocs chat editing", () => {
  it("posts the exact compact approve-all request without document HTML", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({
        response: "Updated the deadline.",
        document_changes: {
          changes_summary: "Deadline changed to 30 days.",
          chunk_diffs: [{ opaque: true }],
          requires_approval: false
        },
        usage: { input_tokens: 12 }
      })
    ) as unknown as typeof fetch;
    const instruction = "Change the deadline to 30 days.";

    const result = await editingClient(fetchImplementation).editDocument({
      sessionId: "existing-session",
      instruction
    });

    expect(result).toMatchObject({
      response: "Updated the deadline.",
      documentChanges: {
        changesSummary: "Deadline changed to 30 days.",
        chunkDiffs: [{ opaque: true }],
        requiresApproval: false
      }
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImplementation).mock.calls[0]!;
    expect(url).toBe(`${apiBaseUrl}/chat`);
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      session_id: "existing-session",
      message: instruction,
      approval_mode: "approve_all",
      response_mode: "compact",
      model_tier: "pro",
      thinking_depth: "deep"
    });
    expect(body).not.toHaveProperty("document_html");
  });

  it.each([
    [null],
    [undefined]
  ])("supports nullable or omitted document_changes", async (documentChanges) => {
    const payload = {
      response: "No change was needed.",
      ...(documentChanges !== undefined
        ? { document_changes: documentChanges }
        : {})
    };
    const fetchImplementation = vi.fn(async () => jsonResponse(payload));
    const result = await editingClient(
      fetchImplementation as unknown as typeof fetch
    ).editDocument({ sessionId: "session", instruction: "Keep it unchanged." });
    expect(result.documentChanges).toBeUndefined();
    expect(result.response).toBe("No change was needed.");
  });

  it("surfaces an unexpected approval-required response as typed data", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({
        response: "Approval needed.",
        document_changes: { requires_approval: true, chunk_diffs: [] }
      })
    );
    const result = await editingClient(
      fetchImplementation as unknown as typeof fetch
    ).editDocument({ sessionId: "session", instruction: "Edit it." });
    expect(result.documentChanges?.requiresApproval).toBe(true);
  });

  it.each([
    [401, "edit_authentication"],
    [403, "edit_permission_or_quota"],
    [429, "edit_rate_limited"],
    [503, "edit_server_error"]
  ])("classifies HTTP %i without retrying", async (status, category) => {
    const fetchImplementation = vi.fn(async () =>
      new Response("sensitive upstream body", { status })
    );
    await expect(
      editingClient(fetchImplementation as unknown as typeof fetch).editDocument({
        sessionId: "session",
        instruction: "Edit it."
      })
    ).rejects.toMatchObject({ category, status });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("does not retry an ambiguous timeout", async () => {
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    ) as unknown as typeof fetch;
    await expect(
      editingClient(fetchImplementation, 5).editDocument({
        sessionId: "session",
        instruction: "Edit it."
      })
    ).rejects.toMatchObject({ category: "edit_timeout" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("rejects malformed JSON and structurally empty responses", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 }));
    await expect(
      editingClient(malformed as unknown as typeof fetch).editDocument({
        sessionId: "session",
        instruction: "Edit it."
      })
    ).rejects.toMatchObject({ category: "edit_invalid_response" });

    const empty = vi.fn(async () => jsonResponse({}));
    await expect(
      editingClient(empty as unknown as typeof fetch).editDocument({
        sessionId: "session",
        instruction: "Edit it."
      })
    ).rejects.toMatchObject({ category: "edit_invalid_response" });
  });
});

describe("SuperDocs edit configuration", () => {
  it("uses safe defaults", () => {
    expect(
      createSuperDocsConfig({ apiKey: "key", apiBaseUrl })
    ).toMatchObject({ modelTier: "core", thinkingDepth: "balanced" });
  });

  it("validates model tier and thinking depth precisely", () => {
    expect(() =>
      createSuperDocsConfig({ apiKey: "key", apiBaseUrl, modelTier: "basic" })
    ).toThrow(/SUPERDOCS_MODEL_TIER/);
    expect(() =>
      createSuperDocsConfig({
        apiKey: "key",
        apiBaseUrl,
        thinkingDepth: "medium"
      })
    ).toThrow(/SUPERDOCS_THINKING_DEPTH/);
  });
});
