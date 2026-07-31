const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export interface EditOriginalInteractionResponseOptions {
  applicationId: string;
  interactionToken: string;
  content: string;
}

export async function editOriginalInteractionResponse({
  applicationId,
  interactionToken,
  content
}: EditOriginalInteractionResponseOptions): Promise<void> {
  const response = await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${encodeURIComponent(applicationId)}/${encodeURIComponent(interactionToken)}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Discord rejected the interaction response edit with status ${response.status}`
    );
  }
}
