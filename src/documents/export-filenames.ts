import path from "node:path";

import type { ExportFormat } from "../discord/review-components.js";
import type { StoredDocumentMetadata } from "./document-storage.js";

const MAX_EXPORT_BASENAME_LENGTH = 150;

function sourceBasename(metadata: Pick<StoredDocumentMetadata, "title" | "originalFilename">): string {
  const preferred = metadata.title?.trim() || metadata.originalFilename;
  const basename = path.posix.basename(preferred.replaceAll("\\", "/"));
  let withoutExtension = basename;
  while (/\.(?:docx|pdf)$/i.test(withoutExtension)) {
    withoutExtension = withoutExtension.replace(/\.(?:docx|pdf)$/i, "");
  }
  return withoutExtension;
}

function safeBasename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[\\/]+/gu, " ")
    .replace(/\.\.+/gu, " ")
    .replaceAll("@", "＠")
    .replace(/[<>:"|?*]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .toLowerCase();

  const useful = (normalized
    .match(/[\p{L}\p{N}._＠-]/gu)?.join("") ?? "")
    .replace(/^[.-]+|[.-]+$/gu, "")
    .slice(0, MAX_EXPORT_BASENAME_LENGTH)
    .replace(/^[.-]+|[.-]+$/gu, "");

  return useful || "document";
}

export function createSafeExportFilename(
  metadata: Pick<StoredDocumentMetadata, "title" | "originalFilename" | "editCount">,
  format: ExportFormat
): string {
  const version = metadata.editCount ?? 0;
  const basename = safeBasename(sourceBasename(metadata));
  return `${basename}-revised-v${version}.${format}`;
}

export function exportFilenameWithoutExtension(filename: string): string {
  return filename.replace(/\.(?:docx|pdf)$/i, "");
}
