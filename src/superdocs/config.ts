export const DEFAULT_SUPERDOCS_API_BASE_URL =
  "https://api.superdocs.app/v1";

export interface SuperDocsConfig {
  apiKey: string;
  apiBaseUrl: string;
}

export function createSuperDocsConfig({
  apiKey,
  apiBaseUrl = DEFAULT_SUPERDOCS_API_BASE_URL
}: {
  apiKey: string;
  apiBaseUrl?: string;
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

  return {
    apiKey,
    apiBaseUrl: parsedBaseUrl.toString().replace(/\/$/, "")
  };
}
