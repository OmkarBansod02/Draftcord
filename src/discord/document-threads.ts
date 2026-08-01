import {
  sanitizeFilenameForDisplay,
  sanitizeTextForDisplay
} from "../documents/filename-safety.js";
import { formatFileSize } from "./upload-validation.js";
import { displayEditMode, type EditMode } from "../documents/edit-mode.js";

const MAX_THREAD_NAME_LENGTH = 100;

function sanitizeDiscordNamePart(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/[/\\]+/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/[*_~`>|#[\]()]/g, "")
    .replaceAll("@", "＠")
    .replace(/\s+/g, " ")
    .trim();
}

function filenameWithoutDocx(filename: string): string {
  return sanitizeFilenameForDisplay(filename).replace(/\.docx$/i, "");
}

export function createDocumentThreadName({
  documentId,
  title,
  originalFilename
}: {
  documentId: string;
  title?: string;
  originalFilename: string;
}): string {
  const preferred = title?.trim() || filenameWithoutDocx(originalFilename);
  const safeBase = sanitizeDiscordNamePart(preferred) || "Document";
  const shortId = documentId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
  const suffix = shortId ? ` · ${shortId}` : "";
  const availableLength = MAX_THREAD_NAME_LENGTH - suffix.length;
  const truncatedBase = safeBase.slice(0, Math.max(1, availableLength)).trim();
  return `${truncatedBase || "D"}${suffix}`.slice(0, MAX_THREAD_NAME_LENGTH);
}

export function createDocumentThreadUrl(
  guildId: string,
  threadId: string
): string {
  return `https://discord.com/channels/${encodeURIComponent(guildId)}/${encodeURIComponent(threadId)}`;
}

export function createDiscordMessageUrl(
  guildId: string,
  threadId: string,
  messageId: string
): string {
  return `${createDocumentThreadUrl(guildId, threadId)}/${encodeURIComponent(messageId)}`;
}

export function createWorkspaceWelcomeMessage({
  title,
  originalFilename,
  documentId,
  byteSize,
  chunkCount,
  editMode = "review"
}: {
  title?: string;
  originalFilename: string;
  documentId: string;
  byteSize: number;
  chunkCount?: number;
  editMode?: EditMode;
}): string {
  const safeFilename = sanitizeDiscordNamePart(
    sanitizeFilenameForDisplay(originalFilename)
  );
  const safeTitle = sanitizeDiscordNamePart(
    sanitizeTextForDisplay(title?.trim() || filenameWithoutDocx(originalFilename))
  );
  const lines = [
    "📄 Draftcord document workspace",
    "",
    `Title: ${safeTitle || "Document"}`,
    `File: ${safeFilename || "document.docx"}`,
    `Document ID: ${documentId}`,
    `File size: ${formatFileSize(byteSize)}`,
    "Status: SuperDocs session ready"
  ];

  if (chunkCount !== undefined) {
    lines.push(`Structure: ${chunkCount} document chunks detected`);
  }

  lines.push("");
  lines.push("The original DOCX has been verified and loaded into SuperDocs.");
  lines.push("Natural-language editing was connected in Phase 4.");
  lines.push(`Editing mode: ${displayEditMode(editMode)}`);
  lines.push(
    editMode === "review"
      ? "Review Mode holds proposed changes for explicit approval."
      : "Auto Apply sends edits directly to the active SuperDocs session."
  );
  return lines.join("\n");
}
