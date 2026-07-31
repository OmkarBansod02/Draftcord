import type { DiscordAttachment } from "./types.js";

export const DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const MAX_DOCX_SIZE_BYTES = 10 * 1024 * 1024;

export interface UploadAccessContext {
  userId?: string;
  guildId?: string;
  channelId?: string;
}

export interface UploadAccessPolicy {
  ownerUserId: string;
  guildId: string;
  documentChannelId: string;
}

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string };

export function validateUploadAccess(
  context: UploadAccessContext,
  policy: UploadAccessPolicy
): ValidationResult {
  if (context.guildId !== policy.guildId) {
    return {
      valid: false,
      error: "This command can only be used in the configured Draftcord server."
    };
  }

  if (context.userId !== policy.ownerUserId) {
    return {
      valid: false,
      error: "Only the configured Draftcord owner can upload documents."
    };
  }

  if (context.channelId !== policy.documentChannelId) {
    return {
      valid: false,
      error: "This command can only be used in the configured document channel."
    };
  }

  return { valid: true };
}

export function validateDocxAttachment(
  attachment: DiscordAttachment
): ValidationResult {
  if (!attachment.filename.toLowerCase().endsWith(".docx")) {
    return {
      valid: false,
      error: "The file must have a .docx filename extension."
    };
  }

  if (attachment.content_type) {
    const normalizedContentType = attachment.content_type
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase();

    if (normalizedContentType !== DOCX_MIME_TYPE) {
      return {
        valid: false,
        error: `The file must use the DOCX content type (${DOCX_MIME_TYPE}).`
      };
    }
  }

  if (attachment.size > MAX_DOCX_SIZE_BYTES) {
    return {
      valid: false,
      error: "The file must be 10 MB or smaller."
    };
  }

  return { valid: true };
}

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} ${sizeBytes === 1 ? "byte" : "bytes"}`;
  }

  const units = ["KB", "MB", "GB"];
  let size = sizeBytes / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = size >= 10 || Number.isInteger(size) ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}
