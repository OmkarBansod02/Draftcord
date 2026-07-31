import "dotenv/config";

import express from "express";
import { verifyKeyMiddleware } from "discord-interactions";
import pino from "pino";

import { createInteractionHandler } from "./discord/interactions.js";
import { createSuperDocsConfig } from "./superdocs/config.js";

const publicKey = process.env.DISCORD_PUBLIC_KEY;
const applicationId = process.env.DISCORD_APPLICATION_ID;
const ownerUserId = process.env.DISCORD_OWNER_USER_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const documentChannelId = process.env.DISCORD_DOCUMENT_CHANNEL_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const superdocsApiKey = process.env.SUPERDOCS_API_KEY;
const port = Number(process.env.PORT ?? 3000);

const requiredEnvironmentVariables = {
  DISCORD_PUBLIC_KEY: publicKey,
  DISCORD_APPLICATION_ID: applicationId,
  DISCORD_BOT_TOKEN: botToken,
  DISCORD_OWNER_USER_ID: ownerUserId,
  DISCORD_GUILD_ID: guildId,
  DISCORD_DOCUMENT_CHANNEL_ID: documentChannelId,
  SUPERDOCS_API_KEY: superdocsApiKey
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
const configuredBotToken = botToken as string;
const configuredSuperDocsApiKey = superdocsApiKey as string;
const superdocs = createSuperDocsConfig({
  apiKey: configuredSuperDocsApiKey,
  ...(process.env.SUPERDOCS_API_BASE_URL
    ? { apiBaseUrl: process.env.SUPERDOCS_API_BASE_URL }
    : {})
});

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
      documentChannelId: configuredDocumentChannelId,
      botToken: configuredBotToken,
      superdocs,
      ...(process.env.DRAFTCORD_STORAGE_DIR
        ? { storageDirectory: process.env.DRAFTCORD_STORAGE_DIR }
        : {})
    },
    logger
  })
);

app.listen(port, () => {
  console.log(`Draftcord listening on http://localhost:${port}`);
});
