import type { RequestHandler } from "express";
import type { Logger } from "pino";

import { DocumentIngestionError } from "../documents/document-ingestion.js";
import {
  createDocumentWorkspace,
  DocumentWorkspaceError
} from "../documents/document-workspace.js";
import {
  createDocumentStorage,
  type DocumentStorage
} from "../documents/document-storage.js";
import type { DocumentWorkspaceRegistry } from "../documents/workspace-registry.js";
import {
  sanitizeFilenameForDisplay,
  sanitizeTextForDisplay
} from "../documents/filename-safety.js";
import {
  createDiscordRestClient,
  DiscordApiError,
  editOriginalInteractionResponse,
  type DiscordDocumentThreadClient
} from "./api.js";
import type {
  DiscordAttachment,
  DiscordInteraction,
  DiscordInteractionOption,
  DiscordInteractionResponse
} from "./types.js";
import {
  formatFileSize,
  validateDocxAttachment,
  validateUploadAccess,
  type UploadAccessPolicy
} from "./upload-validation.js";
import {
  createSuperDocsClient,
  type SuperDocsClient
} from "../superdocs/client.js";
import {
  createSuperDocsConfig,
  type SuperDocsConfig
} from "../superdocs/config.js";
import type { EditMode } from "../documents/edit-mode.js";
import type { ComponentInteractionHandler } from "./component-interactions.js";

const APPLICATION_COMMAND = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const SUBCOMMAND_OPTION = 1;
const STRING_OPTION = 3;
const ATTACHMENT_OPTION = 11;
const EPHEMERAL_FLAG = 1 << 6;

export interface InteractionHandlerConfig extends UploadAccessPolicy {
  applicationId: string;
  botToken: string;
  superdocs: SuperDocsConfig;
  storageDirectory?: string;
  defaultEditMode?: EditMode;
}

interface InteractionHandlerDependencies {
  config: InteractionHandlerConfig;
  logger: Logger;
  superdocsClient?: SuperDocsClient;
  discordClient?: DiscordDocumentThreadClient;
  storage?: DocumentStorage;
  registry?: Pick<DocumentWorkspaceRegistry, "register">;
  componentHandler?: ComponentInteractionHandler;
}

function ephemeralError(content: string): DiscordInteractionResponse {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: `❌ ${content}`,
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] }
    }
  };
}

function getOption(
  options: DiscordInteractionOption[] | undefined,
  name: string,
  type: number
): DiscordInteractionOption | undefined {
  return options?.find(
    (option) => option.name === name && option.type === type
  );
}

function getUploadData(interaction: DiscordInteraction):
  | { attachment: DiscordAttachment; title?: string }
  | { error: string } {
  const uploadOption = getOption(
    interaction.data?.options,
    "upload",
    SUBCOMMAND_OPTION
  );

  if (!uploadOption) {
    return { error: "Unsupported /doc subcommand." };
  }

  const fileOption = getOption(
    uploadOption.options,
    "file",
    ATTACHMENT_OPTION
  );
  const attachmentId = fileOption?.value;
  const attachment = attachmentId
    ? interaction.data?.resolved?.attachments?.[attachmentId]
    : undefined;

  if (!attachment) {
    return { error: "A DOCX attachment named file is required." };
  }

  const titleOption = getOption(
    uploadOption.options,
    "title",
    STRING_OPTION
  );
  const title = titleOption?.value?.trim();

  return title ? { attachment, title } : { attachment };
}

function buildWorkspaceSuccessMessage(
  result: Awaited<ReturnType<typeof createDocumentWorkspace>>
): string {
  const { metadata } = result;
  const lines = [
    "✅ Draftcord workspace ready",
    "",
    `Title: ${sanitizeTextForDisplay(metadata.title ?? sanitizeFilenameForDisplay(metadata.originalFilename).replace(/\.docx$/i, ""))}`,
    `Filename: ${sanitizeFilenameForDisplay(metadata.originalFilename)}`,
    `File size: ${formatFileSize(metadata.byteSize)}`,
    `Draftcord document ID: ${metadata.documentId}`,
    "DOCX structure verified.",
    "SuperDocs session ready."
  ];

  if (result.superdocs.chunkCount !== undefined) {
    lines.push(
      `Structure: ${result.superdocs.chunkCount} document chunks detected.`
    );
  }

  lines.push(`Thread: ${result.discordThreadUrl}`);
  lines.push("");
  lines.push("Open the thread to use the document workspace.");
  return lines.join("\n");
}

function buildWorkspaceFailureMessage(error: unknown): string {
  if (error instanceof DocumentWorkspaceError) {
    const stage =
      error.stage === "superdocs_ingestion"
        ? "SuperDocs ingestion"
        : error.stage === "discord_thread_creation"
          ? "Discord thread creation"
          : "Discord thread setup";
    const lines = [
      "❌ Draftcord workspace setup failed.",
      `Failed stage: ${stage}`,
      `Draftcord document ID: ${error.documentId}`,
      "Original DOCX safely retained: yes"
    ];
    if (error.threadUrl) {
      lines.push(`Created thread: ${error.threadUrl}`);
    }
    lines.push("Inspect the server logs for the safe failure category.");
    return lines.join("\n");
  }

  if (error instanceof DocumentIngestionError) {
    return [
      `❌ ${error.userMessage}`,
      "Failed stage: local document ingestion",
      `Draftcord document ID: ${error.documentId ?? "not stored"}`,
      "Original DOCX safely retained: no",
      "Inspect the server logs for the safe failure category."
    ].join("\n");
  }

  return [
    "❌ Draftcord could not process this document.",
    "Failed stage: workspace provisioning",
    "Draftcord document ID: unavailable",
    "Inspect the server logs for details."
  ].join("\n");
}

export function createInteractionHandler({
  config,
  logger,
  superdocsClient = createSuperDocsClient({
    ...createSuperDocsConfig(config.superdocs),
    logger
  }),
  discordClient = createDiscordRestClient({ botToken: config.botToken }),
  storage = createDocumentStorage({
    ...(config.storageDirectory
      ? { rootDirectory: config.storageDirectory }
      : {})
  }),
  registry,
  componentHandler
}: InteractionHandlerDependencies): RequestHandler {
  return (request, response) => {
    try {
      const interaction = request.body as DiscordInteraction;
      const commandName = interaction.data?.name;
      const userId = interaction.member?.user?.id ?? interaction.user?.id;

      const component = componentHandler?.handle(interaction);
      if (component) {
        response.status(200).json(component.response);
        if (component.afterResponse) {
          queueMicrotask(() => void component.afterResponse?.().catch(() => {
            logger.error(
              {
                event: "component_interaction_failed",
                interactionId: interaction.id,
                errorCategory: "component_background_failure"
              },
              "Component interaction background processing failed"
            );
          }));
        }
        return;
      }

      logger.info(
        {
          interactionId: interaction.id,
          interactionType: interaction.type,
          commandName,
          guildId: interaction.guild_id,
          channelId: interaction.channel_id,
          userId
        },
        "Discord interaction received"
      );

      if (interaction.type === APPLICATION_COMMAND && commandName === "ping") {
        response.status(200).json({
          type: CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "🏓 Draftcord is online."
          }
        } satisfies DiscordInteractionResponse);
        return;
      }

      if (interaction.type !== APPLICATION_COMMAND || commandName !== "doc") {
        logger.warn(
          {
            interactionId: interaction.id,
            interactionType: interaction.type,
            commandName
          },
          "Unsupported Discord interaction"
        );
        response.status(200).json(ephemeralError("Unsupported command."));
        return;
      }

      const accessResult = validateUploadAccess(
        {
          userId,
          guildId: interaction.guild_id,
          channelId: interaction.channel_id
        },
        config
      );

      if (!accessResult.valid) {
        logger.warn(
          {
            interactionId: interaction.id,
            guildId: interaction.guild_id,
            channelId: interaction.channel_id,
            userId,
            reason: accessResult.error
          },
          "Document upload access denied"
        );
        response.status(200).json(ephemeralError(accessResult.error));
        return;
      }

      const uploadData = getUploadData(interaction);

      if ("error" in uploadData) {
        response.status(200).json(ephemeralError(uploadData.error));
        return;
      }

      const attachmentResult = validateDocxAttachment(uploadData.attachment);

      if (!attachmentResult.valid) {
        logger.info(
          {
            interactionId: interaction.id,
            filename: sanitizeFilenameForDisplay(
              uploadData.attachment.filename
            ),
            size: uploadData.attachment.size,
            contentType: uploadData.attachment.content_type,
            reason: attachmentResult.error
          },
          "Document attachment rejected"
        );
        response.status(200).json(ephemeralError(attachmentResult.error));
        return;
      }

      if (!interaction.token) {
        logger.error(
          { interactionId: interaction.id },
          "Valid interaction did not include a response token"
        );
        response
          .status(200)
          .json(ephemeralError("Discord did not provide a response token."));
        return;
      }

      response.status(200).json({
        type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: EPHEMERAL_FLAG }
      } satisfies DiscordInteractionResponse);

      const interactionToken = interaction.token;
      const uploadedByUserId = userId as string;
      const uploadGuildId = interaction.guild_id as string;
      const uploadChannelId = interaction.channel_id as string;

      void (async () => {
        let content: string;

        try {
          const workspace = await createDocumentWorkspace(
            {
              interactionId: interaction.id,
              attachment: uploadData.attachment,
              ...(uploadData.title ? { title: uploadData.title } : {}),
              uploadedByUserId,
              guildId: uploadGuildId,
              channelId: uploadChannelId
            },
            {
              logger,
              storage,
              superdocsClient,
              discordClient,
              ownerUserId: config.ownerUserId,
              documentChannelId: config.documentChannelId,
              ...(config.defaultEditMode
                ? { defaultEditMode: config.defaultEditMode }
                : {}),
              ...(registry
                ? {
                    onMetadataChanged: (metadata) => {
                      registry.register(metadata);
                    }
                  }
                : {})
            }
          );

          content = buildWorkspaceSuccessMessage(workspace);
        } catch (error) {
          content = buildWorkspaceFailureMessage(error);

          if (
            !(error instanceof DocumentIngestionError) &&
            !(error instanceof DocumentWorkspaceError)
          ) {
            logger.error(
              {
                interactionId: interaction.id,
                processingStage: "ingestion",
                errorCategory: "unexpected"
              },
              "Unexpected document ingestion failure"
            );
          }
        }

        try {
          await editOriginalInteractionResponse({
            applicationId: config.applicationId,
            interactionToken,
            content
          });
        } catch (error) {
          logger.error(
            {
              interactionId: interaction.id,
              processingStage: "response_edit",
              errorCategory:
                error instanceof DiscordApiError ? error.category : "unexpected"
            },
            "Failed to edit deferred Discord interaction response"
          );
        }
      })();
    } catch {
      logger.error(
        {
          errorCategory: "interaction_handler_unexpected"
        },
        "Discord interaction handler failed"
      );

      if (!response.headersSent) {
        response
          .status(200)
          .json(ephemeralError("Draftcord could not process this command."));
      }
    }
  };
}
