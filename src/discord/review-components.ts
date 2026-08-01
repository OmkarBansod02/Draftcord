import type { EditMode } from "../documents/edit-mode.js";
import type { PendingReview, SafeProposedChange } from "../documents/review-store.js";

export interface DiscordButtonComponent {
  type: 2;
  style: 1 | 2 | 3 | 4;
  custom_id: string;
  label: string;
  emoji?: { name: string };
  disabled?: boolean;
}

export interface DiscordActionRow {
  type: 1;
  components: DiscordButtonComponent[];
}

export const EXPORT_FORMATS = ["docx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const MAX_DISCORD_CONTENT = 2_000;

export function escapeDiscordMentions(value: string): string {
  return value.replaceAll("@", "＠");
}

export function modeCustomId(
  action: EditMode,
  documentId: string
): string {
  const customId = `draftcord:mode:${action}:${documentId}`;
  if (customId.length > 100) throw new Error("Mode custom ID exceeds 100 characters");
  return customId;
}

export function reviewCustomId(
  decision: "approve" | "reject",
  reviewId: string
): string {
  const customId = `draftcord:review:${decision}:${reviewId}`;
  if (customId.length > 100) throw new Error("Review custom ID exceeds 100 characters");
  return customId;
}

export function exportCustomId(
  format: ExportFormat,
  documentId: string
): string {
  const customId = `draftcord:export:${format}:${documentId}`;
  if (customId.length > 100) {
    throw new Error("Export custom ID exceeds 100 characters");
  }
  return customId;
}

export function createModeComponents(
  documentId: string,
  activeMode: EditMode,
  disabled = false
): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      {
        type: 2,
        style: activeMode === "auto_apply" ? 1 : 2,
        custom_id: modeCustomId("auto_apply", documentId),
        label: "Auto Apply",
        emoji: { name: "⚡" },
        disabled: disabled || activeMode === "auto_apply"
      },
      {
        type: 2,
        style: activeMode === "review" ? 1 : 2,
        custom_id: modeCustomId("review", documentId),
        label: "Review Mode",
        emoji: { name: "🛡️" },
        disabled: disabled || activeMode === "review"
      }
    ]
  }];
}

export function createExportComponents(
  documentId: string,
  disabled = false
): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      {
        type: 2,
        style: 2,
        custom_id: exportCustomId("docx", documentId),
        label: "Export DOCX",
        emoji: { name: "📄" },
        disabled
      },
      {
        type: 2,
        style: 2,
        custom_id: exportCustomId("pdf", documentId),
        label: "Export PDF",
        emoji: { name: "🧾" },
        disabled
      }
    ]
  }];
}

/**
 * The complete pair of rows used by a document workspace control message.
 * `createModeComponents` remains a one-row compatibility helper for review
 * messages and Phase 5 callers that only need mode controls.
 */
export function createWorkspaceControlComponents(
  documentId: string,
  activeMode: EditMode,
  disabled = false
): DiscordActionRow[] {
  return [
    ...createModeComponents(documentId, activeMode, disabled),
    ...createExportComponents(documentId, disabled)
  ];
}

export function createReviewDecisionComponents(
  reviewId: string,
  disabled = false
): DiscordActionRow[] {
  return [{
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        custom_id: reviewCustomId("approve", reviewId),
        label: "Approve All",
        emoji: { name: "✅" },
        disabled
      },
      {
        type: 2,
        style: 4,
        custom_id: reviewCustomId("reject", reviewId),
        label: "Reject All",
        emoji: { name: "❌" },
        disabled
      }
    ]
  }];
}

function changeLines(change: SafeProposedChange, index: number): string[] {
  const label = change.operation[0]!.toUpperCase() + change.operation.slice(1);
  const lines = [`${index}. ${label}`];
  if (change.oldText) lines.push(`Before: ${change.oldText}`);
  if (change.newText) lines.push(`After: ${change.newText}`);
  if (change.explanation) lines.push(`Why: ${change.explanation}`);
  return lines;
}

export function formatReviewProposal(
  review: Pick<PendingReview, "instructionPreview" | "proposedChanges" | "reviewId">
): { content: string; components: DiscordActionRow[] } {
  const header = [
    "🛡️ Changes ready for review",
    "",
    "Instruction:",
    escapeDiscordMentions(review.instructionPreview),
    "",
    `Proposed changes: ${review.proposedChanges.length}`,
    ""
  ];
  const footer = ["", "These proposed changes have not been applied yet."];
  const lines = [...header];
  let shown = 0;
  for (const change of review.proposedChanges) {
    const candidate = [...changeLines(change, shown + 1), ""];
    const omitted = review.proposedChanges.length - (shown + 1);
    const reserve = footer.join("\n").length + (omitted > 0 ? 45 : 0);
    if ([...lines, ...candidate].join("\n").length + reserve > 1_950) break;
    lines.push(...candidate);
    shown += 1;
  }
  const omitted = review.proposedChanges.length - shown;
  if (omitted > 0) lines.push(`…and ${omitted} more change${omitted === 1 ? "" : "s"} omitted.`);
  lines.push(...footer);
  return {
    content: lines.join("\n").slice(0, MAX_DISCORD_CONTENT),
    components: createReviewDecisionComponents(review.reviewId)
  };
}

export function disabledDecisionMessage(content: string): {
  content: string;
  components: DiscordActionRow[];
} {
  return {
    content: escapeDiscordMentions(content).slice(0, MAX_DISCORD_CONTENT),
    components: []
  };
}
