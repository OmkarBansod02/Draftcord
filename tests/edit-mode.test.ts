import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_EDIT_MODE,
  parseDefaultEditMode
} from "../src/documents/edit-mode.js";
import { createDocumentStorage } from "../src/documents/document-storage.js";
import { createModeComponents } from "../src/discord/review-components.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("document edit modes", () => {
  it("defaults new workspace configuration to review and validates exact values", () => {
    expect(DEFAULT_EDIT_MODE).toBe("review");
    expect(parseDefaultEditMode(undefined)).toBe("review");
    expect(parseDefaultEditMode("auto_apply")).toBe("auto_apply");
    expect(() => parseDefaultEditMode("auto-apply")).toThrow(/DRAFTCORD_DEFAULT_EDIT_MODE/);
    expect(() => parseDefaultEditMode(" review ")).toThrow(/DRAFTCORD_DEFAULT_EDIT_MODE/);
  });

  it("interprets old metadata as auto_apply without rewriting it on read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "draftcord-mode-"));
    roots.push(root);
    const storage = createDocumentStorage({ rootDirectory: root });
    const stored = await storage.store(Buffer.from("docx"), {
      originalFilename: "old.docx",
      uploadedByUserId: "owner-1",
      guildId: "guild-1",
      channelId: "channel-1",
      discordAttachmentId: "attachment-1"
    }, "document-1");
    const before = await readFile(stored.metadataPath, "utf8");
    expect(before).not.toContain("editMode");
    expect((await storage.readMetadata("document-1")).editMode).toBe("auto_apply");
    expect(await readFile(stored.metadataPath, "utf8")).toBe(before);
  });

  it("renders active traditional mode buttons with bounded custom IDs", () => {
    const rows = createModeComponents("document-1", "review");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe(1);
    expect(rows[0]?.components).toEqual([
      expect.objectContaining({ type: 2, label: "Auto Apply", disabled: false }),
      expect.objectContaining({ type: 2, label: "Review Mode", disabled: true })
    ]);
    for (const button of rows[0]?.components ?? []) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
    }
  });
});
