export const DEFAULT_SUPERDOCS_API_BASE_URL =
  "https://api.superdocs.app/v1";

export const SUPERDOCS_MODEL_TIERS = ["core", "turbo", "pro", "max"] as const;
export const SUPERDOCS_THINKING_DEPTHS = [
  "fast",
  "balanced",
  "deep"
] as const;

export type SuperDocsModelTier = (typeof SUPERDOCS_MODEL_TIERS)[number];
export type SuperDocsThinkingDepth =
  (typeof SUPERDOCS_THINKING_DEPTHS)[number];

export interface SuperDocsConfig {
  apiKey: string;
  apiBaseUrl: string;
  modelTier: SuperDocsModelTier;
  thinkingDepth: SuperDocsThinkingDepth;
}

export function createSuperDocsConfig({
  apiKey,
  apiBaseUrl = DEFAULT_SUPERDOCS_API_BASE_URL,
  modelTier = "core",
  thinkingDepth = "balanced"
}: {
  apiKey: string;
  apiBaseUrl?: string;
  modelTier?: string;
  thinkingDepth?: string;
}): SuperDocsConfig {
  if (!apiKey.trim()) {
    throw new Error("SUPERDOCS_API_KEY must not be empty");
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error("SUPERDOCS_API_BASE_URL must be a valid URL");
  }

  if (parsedBaseUrl.protocol !== "https:") {
    throw new Error("SUPERDOCS_API_BASE_URL must use HTTPS");
  }

  if (!(SUPERDOCS_MODEL_TIERS as readonly string[]).includes(modelTier)) {
    throw new Error(
      `SUPERDOCS_MODEL_TIER must be one of: ${SUPERDOCS_MODEL_TIERS.join(", ")}`
    );
  }
  if (
    !(SUPERDOCS_THINKING_DEPTHS as readonly string[]).includes(thinkingDepth)
  ) {
    throw new Error(
      `SUPERDOCS_THINKING_DEPTH must be one of: ${SUPERDOCS_THINKING_DEPTHS.join(", ")}`
    );
  }

  return {
    apiKey,
    apiBaseUrl: parsedBaseUrl.toString().replace(/\/$/, ""),
    modelTier: modelTier as SuperDocsModelTier,
    thinkingDepth: thinkingDepth as SuperDocsThinkingDepth
  };
}
