import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createEditActivityRepository } from "../src/documents/edit-activity.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-activity-"));
  temporaryDirectories.push(root);
  const storage = createDocumentStorage({ rootDirectory: root });
  await storage.store(
    Buffer.from("docx"),
    {
      originalFilename: "proposal.docx",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    },
    "document-1"
  );
  return {
    root,
    activity: createEditActivityRepository({
      storage,
      logger: pino({ level: "silent" })
    })
  };
}

function record(messageId: string, status: "started" | "succeeded") {
  const now = new Date().toISOString();
  return {
    activityId: `activity-${messageId}`,
    type: "document_edit" as const,
    discordMessageId: messageId,
    discordThreadId: "thread-1",
    requestedByUserId: "owner-1",
    status,
    createdAt: now,
    ...(status === "succeeded" ? { completedAt: now } : {})
  };
}

describe("edit activity repository", () => {
  it("distinguishes terminal and ambiguous started-only message IDs", async () => {
    const { activity } = await harness();
    await activity.append("document-1", record("message-started", "started"));
    await activity.append("document-1", record("message-terminal", "started"));
    await activity.append("document-1", record("message-terminal", "succeeded"));

    expect(await activity.getState("document-1", "message-started")).toMatchObject({
      state: "started"
    });
    expect(await activity.getState("document-1", "message-terminal")).toMatchObject({
      state: "terminal",
      record: { status: "succeeded" }
    });
  });

  it("serializes concurrent appends as valid JSONL", async () => {
    const { root, activity } = await harness();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        activity.append("document-1", record(`message-${index}`, "started"))
      )
    );
    const text = await readFile(
      path.join(root, "documents", "document-1", "activity.jsonl"),
      "utf8"
    );
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(25);
    expect(lines.map((line) => JSON.parse(line))).toHaveLength(25);
  });

  it("redacts HTML, URLs, and secret-like values from persisted text", async () => {
    const { root, activity } = await harness();
    await activity.append("document-1", {
      ...record("message-1", "started"),
      instruction:
        "<html>Visit https://secret.example/path token=super-secret Bearer abc123</html>"
    });
    const text = await readFile(
      path.join(root, "documents", "document-1", "activity.jsonl"),
      "utf8"
    );
    expect(text).not.toContain("<html>");
    expect(text).not.toContain("https://secret.example");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("abc123");
  });
});
