export const EDIT_MODES = ["auto_apply", "review"] as const;

export type EditMode = (typeof EDIT_MODES)[number];

export const DEFAULT_EDIT_MODE: EditMode = "review";

export function parseDefaultEditMode(
  value: string | undefined = process.env.DRAFTCORD_DEFAULT_EDIT_MODE
): EditMode {
  const candidate = value ?? DEFAULT_EDIT_MODE;
  if (!(EDIT_MODES as readonly string[]).includes(candidate)) {
    throw new Error(
      `DRAFTCORD_DEFAULT_EDIT_MODE must be one of: ${EDIT_MODES.join(", ")}`
    );
  }
  return candidate as EditMode;
}

export function displayEditMode(mode: EditMode): string {
  return mode === "review" ? "Review Mode" : "Auto Apply";
}
