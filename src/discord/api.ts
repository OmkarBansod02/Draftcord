import { readFile } from "node:fs/promises";
import { z } from "zod";

import type { DiscordActionRow, ExportFormat } from "./review-components.js";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const threadResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100)
});

const messageResponseSchema = z.object({
  id: z.string().min(1)
});

export type DiscordApiErrorCategory =
  | "timeout"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "http_error"
  | "invalid_response";

export class DiscordApiError extends Error {
  constructor(
    public readonly category: DiscordApiErrorCategory,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DiscordApiError";
  }
}

export interface EditOriginalInteractionResponseOptions {
  applicationId: string;
  interactionToken: string;
  content: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface CreatePublicThreadInput {
  channelId: string;
  name: string;
}

export interface CreatedDiscordThread {
  threadId: string;
  name: string;
}

export interface DiscordDocumentThreadClient {
  createPublicThread(
    input: CreatePublicThreadInput
  ): Promise<CreatedDiscordThread>;
  addThreadMember(threadId: string, userId: string): Promise<void>;
  createThreadMessage(
    threadId: string,
    content: string,
    components?: DiscordActionRow[]
  ): Promise<{ id: string }>;
  editThreadMessage?(
    threadId: string,
    messageId: string,
    content: string,
    components?: DiscordActionRow[]
  ): Promise<void>;
}

export interface DiscordComponentMessageClient {
  editThreadMessage(
    threadId: string,
    messageId: string,
    content: string,
    components?: DiscordActionRow[]
  ): Promise<void>;
  createThreadMessage(
    threadId: string,
    content: string,
    components?: DiscordActionRow[]
  ): Promise<{ id: string }>;
}

export interface DiscordExportFileClient {
  uploadThreadFile(input: {
    threadId: string;
    content: string;
    filePath: string;
    filename: string;
    format: ExportFormat;
  }): Promise<{ id: string }>;
}

interface DiscordRestClientOptions {
  botToken: string;
  fetchImplementation?: typeof fetch;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  readFileImplementation?: (file: string) => Promise<Buffer>;
}

function errorCategoryForStatus(status: number): DiscordApiErrorCategory {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "http_error";
}

async function discordFetch(
  fetchImplementation: typeof fetch,
  url: string,
  init: RequestInit,
  requestTimeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);

  try {
    return await fetchImplementation(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    throw new DiscordApiError(
      timedOut ? "timeout" : "network",
      timedOut ? "Discord API request timed out" : "Discord API request failed",
      undefined,
      { cause: error }
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function requireSuccess(response: Response): Promise<void> {
  if (response.ok) return;
  await response.body?.cancel().catch(() => undefined);
  throw new DiscordApiError(
    errorCategoryForStatus(response.status),
    `Discord API returned status ${response.status}`,
    response.status
  );
}

async function parseDiscordJson<T>(
  response: Response,
  schema: z.ZodType<T>
): Promise<T> {
  await requireSuccess(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new DiscordApiError(
      "invalid_response",
      "Discord API returned invalid JSON",
      response.status,
      { cause: error }
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new DiscordApiError(
      "invalid_response",
      "Discord API response did not match the expected schema",
      response.status
    );
  }
  return parsed.data;
}

export function createDiscordRestClient({
  botToken,
  fetchImplementation = fetch,
  apiBaseUrl = DISCORD_API_BASE_URL,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  readFileImplementation = (file) => readFile(file)
}: DiscordRestClientOptions): DiscordDocumentThreadClient & DiscordComponentMessageClient & DiscordExportFileClient {
  return {
    async createPublicThread({
      channelId,
      name
    }: CreatePublicThreadInput): Promise<CreatedDiscordThread> {
      const response = await discordFetch(
        fetchImplementation,
        `${apiBaseUrl}/channels/${encodeURIComponent(channelId)}/threads`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            name,
            type: 11,
            auto_archive_duration: 1440
          })
        },
        requestTimeoutMs
      );
      const thread = await parseDiscordJson(response, threadResponseSchema);
      return { threadId: thread.id, name: thread.name };
    },

    async addThreadMember(threadId: string, userId: string): Promise<void> {
      const response = await discordFetch(
        fetchImplementation,
        `${apiBaseUrl}/channels/${encodeURIComponent(threadId)}/thread-members/${encodeURIComponent(userId)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bot ${botToken}` }
        },
        requestTimeoutMs
      );
      await requireSuccess(response);
      await response.body?.cancel().catch(() => undefined);
    },

    async createThreadMessage(
      threadId: string,
      content: string,
      components: DiscordActionRow[] = []
    ): Promise<{ id: string }> {
      const response = await discordFetch(
        fetchImplementation,
        `${apiBaseUrl}/channels/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content,
            components,
            allowed_mentions: { parse: [] }
          })
        },
        requestTimeoutMs
      );
      return parseDiscordJson(response, messageResponseSchema);
    },

    async editThreadMessage(
      threadId: string,
      messageId: string,
      content: string,
      components: DiscordActionRow[] = []
    ): Promise<void> {
      const response = await discordFetch(
        fetchImplementation,
        `${apiBaseUrl}/channels/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content,
            components,
            allowed_mentions: { parse: [] }
          })
        },
        requestTimeoutMs
      );
      await requireSuccess(response);
      await response.body?.cancel().catch(() => undefined);
    },

    async uploadThreadFile({
      threadId,
      content,
      filePath,
      filename,
      format
    }): Promise<{ id: string }> {
      let bytes: Buffer;
      try {
        bytes = await readFileImplementation(filePath);
      } catch (error) {
        throw new DiscordApiError(
          "network",
          "Verified export file could not be read for Discord delivery",
          undefined,
          { cause: error }
        );
      }

      const payload = {
        content,
        allowed_mentions: { parse: [] },
        attachments: [{ id: "0", filename }]
      };
      const form = new FormData();
      form.append("payload_json", JSON.stringify(payload));
      form.append(
        "files[0]",
        new Blob([new Uint8Array(bytes)], {
          type: format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }),
        filename
      );

      const response = await discordFetch(
        fetchImplementation,
        `${apiBaseUrl}/channels/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}` },
          body: form
        },
        requestTimeoutMs
      );
      return parseDiscordJson(response, messageResponseSchema);
    }
  };
}

export async function sendInteractionFollowup({
  applicationId,
  interactionToken,
  content,
  ephemeral = true,
  fetchImplementation = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
}: EditOriginalInteractionResponseOptions & { ephemeral?: boolean }): Promise<void> {
  const response = await discordFetch(
    fetchImplementation,
    `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        ...(ephemeral ? { flags: 1 << 6 } : {}),
        allowed_mentions: { parse: [] }
      })
    },
    requestTimeoutMs
  );
  await requireSuccess(response);
  await response.body?.cancel().catch(() => undefined);
}

export async function editOriginalInteractionResponse({
  applicationId,
  interactionToken,
  content,
  fetchImplementation = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
}: EditOriginalInteractionResponseOptions): Promise<void> {
  const response = await discordFetch(
    fetchImplementation,
    `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }
      })
    },
    requestTimeoutMs
  );
  await requireSuccess(response);
  await response.body?.cancel().catch(() => undefined);
}
