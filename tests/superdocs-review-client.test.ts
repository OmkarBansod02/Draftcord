import { describe, expect, it, vi } from "vitest";

import { createSuperDocsReviewClient } from "../src/superdocs/review-client.js";

const apiBaseUrl = "https://superdocs.example/v1";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function client(fetchImplementation: typeof fetch, options: Record<string, unknown> = {}) {
  return createSuperDocsReviewClient({
    apiKey: "test-key",
    apiBaseUrl,
    modelTier: "pro",
    thinkingDepth: "deep",
    fetchImplementation,
    ...options
  });
}

describe("SuperDocs async review client", () => {
  it("starts an ask-every-time job without document HTML", async () => {
    const fetchMock = vi.fn(async () => json({ job_id: "opaque-job", status: "pending" }));
    await expect(client(fetchMock as unknown as typeof fetch).startReview({
      sessionId: "existing-session",
      instruction: "Change the deadline."
    })).resolves.toEqual({ jobId: "opaque-job" });
    const [url, init] = (fetchMock.mock.calls as unknown[][])[0] as [string, RequestInit];
    expect(url).toBe(`${apiBaseUrl}/chat/async`);
    expect(JSON.parse(String(init?.body))).toEqual({
      session_id: "existing-session",
      message: "Change the deadline.",
      approval_mode: "ask_every_time",
      response_mode: "compact",
      model_tier: "pro",
      thinking_depth: "deep"
    });
    expect(String(init?.body)).not.toContain("document_html");
  });

  it("polls pending and in_progress serially until nullable-kind HITL changes arrive", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      const call = fetchMock.mock.calls.length;
      active -= 1;
      if (call === 1) return json({ status: "pending" });
      if (call === 2) return json({ status: "in_progress" });
      return json({
        status: "awaiting_approval",
        metadata: {
          awaiting_kind: null,
          pending_changes: [{
            change_id: "change-1",
            operation: "edit",
            old_html: "<p>Before</p>",
            new_html: "<p>After</p>",
            ai_explanation: "Updated it"
          }]
        }
      });
    });
    const result = await client(fetchMock as unknown as typeof fetch, {
      sleep: vi.fn(async () => undefined),
      pollIntervalMs: 1
    }).pollJob("opaque-job");
    expect(result.status).toBe("awaiting_approval");
    expect(result.metadata?.pending_changes?.[0]?.change_id).toBe("change-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maximumActive).toBe(1);
  });

  it("distinguishes continue prompts and completed no-change results", async () => {
    const continuing = vi.fn(async () => json({
      status: "awaiting_approval",
      metadata: { awaiting_kind: "continue_prompt" }
    }));
    await expect(client(continuing as unknown as typeof fetch).pollJob("job"))
      .resolves.toMatchObject({ metadata: { awaiting_kind: "continue_prompt" } });

    const completed = vi.fn(async () => json({
      status: "completed",
      result: { response: "No change was needed." }
    }));
    await expect(client(completed as unknown as typeof fetch).pollJob("job"))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("sends exact batch approve and reject bodies including top-level approved", async () => {
    for (const approved of [true, false]) {
      const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
      await client(fetchMock as unknown as typeof fetch).decideReview({
        sessionId: "session/one",
        jobId: "opaque-job",
        changeIds: ["change-1", "change-2"],
        approved
      });
      const [url, init] = (fetchMock.mock.calls as unknown[][])[0] as [string, RequestInit];
      expect(url).toBe(`${apiBaseUrl}/chat/session%2Fone/approve`);
      expect(JSON.parse(String(init?.body))).toEqual({
        job_id: "opaque-job",
        approved,
        changes: [
          { change_id: "change-1", approved },
          { change_id: "change-2", approved }
        ]
      });
    }
  });

  it.each([
    [401, "review_create_authentication"],
    [403, "review_create_permission"],
    [422, "review_create_validation"],
    [429, "review_create_rate_limited"],
    [503, "review_create_server_error"]
  ])("classifies create HTTP %i without retrying", async (status, category) => {
    const fetchMock = vi.fn(async () => new Response("sensitive", { status }));
    await expect(client(fetchMock as unknown as typeof fetch).startReview({
      sessionId: "session",
      instruction: "Edit"
    })).rejects.toMatchObject({ category, status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("validates job JSON and bounds polling", async () => {
    const malformed = vi.fn(async () => new Response("not json"));
    await expect(client(malformed as unknown as typeof fetch).getJob("job"))
      .rejects.toMatchObject({ category: "review_poll_invalid_response" });

    const pending = vi.fn(async () => json({ status: "pending" }));
    await expect(client(pending as unknown as typeof fetch, {
      sleep: vi.fn(async () => undefined),
      pollIntervalMs: 2,
      maxPollWaitMs: 3
    }).pollJob("job")).rejects.toMatchObject({ category: "review_poll_wait_timeout" });
    expect(pending.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("retries transient read-only job polling without replaying a modifying request", async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) {
        throw new TypeError("temporary network failure");
      }
      return json({ status: "completed" });
    });
    const sleep = vi.fn(async () => undefined);
    await expect(client(fetchMock as unknown as typeof fetch, {
      sleep,
      pollIntervalMs: 1,
      maxPollWaitMs: 100
    }).pollJob("job")).resolves.toMatchObject({ status: "completed" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    for (const call of fetchMock.mock.calls as unknown[][]) {
      expect((call[1] as RequestInit).method).toBe("GET");
    }
  });

  it("does not retry an ambiguous decision timeout", async () => {
    const hanging = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError"))
        );
      })
    ) as unknown as typeof fetch;
    await expect(client(hanging, { requestTimeoutMs: 5 }).decideReview({
      sessionId: "session",
      jobId: "job",
      changeIds: ["change"],
      approved: true
    })).rejects.toMatchObject({ category: "review_decision_timeout" });
    expect(hanging).toHaveBeenCalledOnce();
  });
});
