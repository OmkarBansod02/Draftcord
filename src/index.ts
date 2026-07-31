import "dotenv/config";

import express from "express";
import { verifyKeyMiddleware } from "discord-interactions";
import pino from "pino";

import { createInteractionHandler } from "./discord/interactions.js";

const publicKey = process.env.DISCORD_PUBLIC_KEY;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const ownerUserId = process.env.DISCORD_OWNER_USER_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const documentChannelId = process.env.DISCORD_DOCUMENT_CHANNEL_ID;
const port = Number(process.env.PORT ?? 3000);

const requiredEnvironmentVariables = {
  DISCORD_PUBLIC_KEY: publicKey,
  DISCORD_APPLICATION_ID: applicationId,
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
  DISCORD_OWNER_USER_ID: ownerUserId,
  DISCORD_GUILD_ID: guildId,
  DISCORD_DOCUMENT_CHANNEL_ID: documentChannelId,
  SUPERDOCS_API_KEY: process.env.SUPERDOCS_API_KEY
} as const;

const missingEnvironmentVariables = Object.entries(
  requiredEnvironmentVariables
)
  .filter(([, value]) => !value?.trim())
  .map(([name]) => name);

if (missingEnvironmentVariables.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnvironmentVariables.join(", ")}`
  );
}

const configuredPublicKey = publicKey as string;
const configuredApplicationId = applicationId as string;
const configuredOwnerUserId = ownerUserId as string;
const configuredGuildId = guildId as string;
const configuredDocumentChannelId = documentChannelId as string;

const app = express();
const logger = pino();

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "draftcord",
    timestamp: new Date().toISOString()
  });
});

app.post(
  "/interactions",
  verifyKeyMiddleware(configuredPublicKey),
  createInteractionHandler({
    config: {
      applicationId: configuredApplicationId,
      ownerUserId: configuredOwnerUserId,
      guildId: configuredGuildId,
      documentChannelId: configuredDocumentChannelId
    },
    logger
  })
);

app.listen(port, () => {
  console.log(`Draftcord listening on http://localhost:${port}`);
});
