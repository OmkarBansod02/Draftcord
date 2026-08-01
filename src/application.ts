import type { Server } from "node:http";

import express from "express";
import { verifyKeyMiddleware } from "discord-interactions";
import pino from "pino";

import { createDiscordGateway } from "./discord/gateway.js";
import { createInteractionHandler } from "./discord/interactions.js";
import { createDocumentMessageHandler } from "./discord/document-messages.js";
import { createEditActivityRepository } from "./documents/edit-activity.js";
import { createDocumentEditQueue } from "./documents/edit-queue.js";
import { createDocumentStorage } from "./documents/document-storage.js";
import { createDocumentWorkspaceRegistry } from "./documents/workspace-registry.js";
import { createSuperDocsClient } from "./superdocs/client.js";
import { createSuperDocsConfig } from "./superdocs/config.js";
import { parseDefaultEditMode } from "./documents/edit-mode.js";
import { createReviewStore } from "./documents/review-store.js";
import { createSuperDocsReviewClient } from "./superdocs/review-client.js";
import { createComponentInteractionHandler } from "./discord/component-interactions.js";
import { reconcilePendingReviews } from "./documents/review-recovery.js";
import { createDiscordRestClient } from "./discord/api.js";
import { createSuperDocsExportClient } from "./superdocs/export-client.js";
import { createExportActivityRepository } from "./documents/export-activity.js";
import {
  createDocumentExportWorkflow,
  parseMaxExportBytes
} from "./documents/export-workflow.js";
import { reconcileStaleExports } from "./documents/export-recovery.js";

function requireEnvironment(): {
  publicKey: string;
  applicationId: string;
  botToken: string;
  ownerUserId: string;
  guildId: string;
  documentChannelId: string;
  superdocsApiKey: string;
} {
  const values = {
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY,
    DISCORD_APPLICATION_ID: process.env.DISCORD_APPLICATION_ID,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_OWNER_USER_ID: process.env.DISCORD_OWNER_USER_ID,
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID,
    DISCORD_DOCUMENT_CHANNEL_ID: process.env.DISCORD_DOCUMENT_CHANNEL_ID,
    SUPERDOCS_API_KEY: process.env.SUPERDOCS_API_KEY
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
  return {
    publicKey: values.DISCORD_PUBLIC_KEY as string,
    applicationId: values.DISCORD_APPLICATION_ID as string,
    botToken: values.DISCORD_BOT_TOKEN as string,
    ownerUserId: values.DISCORD_OWNER_USER_ID as string,
    guildId: values.DISCORD_GUILD_ID as string,
    documentChannelId: values.DISCORD_DOCUMENT_CHANNEL_ID as string,
    superdocsApiKey: values.SUPERDOCS_API_KEY as string
  };
}

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once("error", reject);
  });
}

export async function startDraftcord(): Promise<{ stop(): Promise<void> }> {
  const environment = requireEnvironment();
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const maxExportBytes = parseMaxExportBytes();

  const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
  const defaultEditMode = parseDefaultEditMode();
  const superdocsConfig = createSuperDocsConfig({
    apiKey: environment.superdocsApiKey,
    ...(process.env.SUPERDOCS_API_BASE_URL
      ? { apiBaseUrl: process.env.SUPERDOCS_API_BASE_URL }
      : {}),
    ...(process.env.SUPERDOCS_MODEL_TIER
      ? { modelTier: process.env.SUPERDOCS_MODEL_TIER }
      : {}),
    ...(process.env.SUPERDOCS_THINKING_DEPTH
      ? { thinkingDepth: process.env.SUPERDOCS_THINKING_DEPTH }
      : {})
  });
  const storage = createDocumentStorage({
    ...(process.env.DRAFTCORD_STORAGE_DIR
      ? { rootDirectory: process.env.DRAFTCORD_STORAGE_DIR }
      : {})
  });
  const registry = createDocumentWorkspaceRegistry({ storage, logger });
  await registry.refresh();
  const activity = createEditActivityRepository({ storage, logger });
  const exportActivity = createExportActivityRepository({ storage, logger });
  const reviewStore = createReviewStore({ storage, logger });
  const queue = createDocumentEditQueue({ maxPendingEdits: 5 });
  const superdocsClient = createSuperDocsClient({
    ...superdocsConfig,
    logger
  });
  const superdocsReviewClient = createSuperDocsReviewClient({
    ...superdocsConfig,
    logger
  });
  const discordClient = createDiscordRestClient({
    botToken: environment.botToken
  });
  const superdocsExportClient = createSuperDocsExportClient({
    ...superdocsConfig,
    logger
  });
  await reconcilePendingReviews({
    storage,
    registry,
    reviewStore,
    reviewClient: superdocsReviewClient,
    logger
  });
  await reconcileStaleExports({
    storage,
    registry,
    reviewStore,
    logger
  });
  const exportWorkflow = createDocumentExportWorkflow({
    config: {
      applicationId: environment.applicationId,
      ownerUserId: environment.ownerUserId,
      guildId: environment.guildId
    },
    logger,
    storage,
    registry,
    reviewStore,
    activity: exportActivity,
    exportClient: superdocsExportClient,
    discordClient,
    editQueue: queue,
    maxExportBytes
  });
  const componentHandler = createComponentInteractionHandler({
    config: {
      applicationId: environment.applicationId,
      ownerUserId: environment.ownerUserId,
      guildId: environment.guildId
    },
    logger,
    storage,
    registry,
    reviewStore,
    activity,
    reviewClient: superdocsReviewClient,
    discordClient,
    exportWorkflow
  });

  const app = express();
  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "draftcord",
      timestamp: new Date().toISOString()
    });
  });
  app.post(
    "/interactions",
    verifyKeyMiddleware(environment.publicKey),
    createInteractionHandler({
      config: {
        applicationId: environment.applicationId,
        ownerUserId: environment.ownerUserId,
        guildId: environment.guildId,
        documentChannelId: environment.documentChannelId,
        botToken: environment.botToken,
        superdocs: superdocsConfig,
        defaultEditMode,
        ...(process.env.DRAFTCORD_STORAGE_DIR
          ? { storageDirectory: process.env.DRAFTCORD_STORAGE_DIR }
          : {})
      },
      logger,
      superdocsClient,
      storage,
      registry,
      discordClient,
      componentHandler
    })
  );

  const gateway = createDiscordGateway({
    token: environment.botToken,
    logger,
    onMessage: createDocumentMessageHandler({
      config: {
        guildId: environment.guildId,
        ownerUserId: environment.ownerUserId
      },
      logger,
      storage,
      registry,
      activity,
      queue,
      superdocsClient,
      reviewStore,
      reviewClient: superdocsReviewClient,
      discordClient
    })
  });

  const server = await listen(app, port);
  try {
    await gateway.start();
  } catch (error) {
    server.close();
    gateway.destroy();
    throw new Error("Discord Gateway login failed", { cause: error });
  }

  const address = server.address();
  logger.info(
    {
      event: "http_server_ready",
      port: typeof address === "object" && address ? address.port : port
    },
    "Draftcord HTTP interactions server ready"
  );

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      server.close();
      gateway.destroy();
      const settled = await queue.waitForIdle(10_000);
      logger.info(
        {
          event: "application_stopped",
          activeEditsSettled: settled
        },
        "Draftcord stopped"
      );
    })();
    return stopping;
  };

  const onSignal = () => {
    void stop().finally(() => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  return { stop };
}
