import path from "node:path";

const MAX_DISPLAY_LENGTH = 200;

export function sanitizeFilenameForDisplay(filename: string): string {
  const normalizedSeparators = filename.replaceAll("\\", "/");
  const basename = path.posix.basename(normalizedSeparators);
  const sanitized = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("@", "＠")
    .trim()
    .slice(0, MAX_DISPLAY_LENGTH);

  return sanitized || "document.docx";
}

export function sanitizeTextForDisplay(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("@", "＠")
    .trim()
    .slice(0, MAX_DISPLAY_LENGTH);
}
