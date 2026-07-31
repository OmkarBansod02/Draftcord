import type { RequestHandler } from "express";
import type { Logger } from "pino";

import {
  DocumentIngestionError,
  ingestDocument
} from "../documents/document-ingestion.js";
import { createDocumentStorage } from "../documents/document-storage.js";
import {
  sanitizeFilenameForDisplay,
  sanitizeTextForDisplay
} from "../documents/filename-safety.js";
import { editOriginalInteractionResponse } from "./api.js";
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

const APPLICATION_COMMAND = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;
const SUBCOMMAND_OPTION = 1;
const STRING_OPTION = 3;
const ATTACHMENT_OPTION = 11;
const EPHEMERAL_FLAG = 1 << 6;

export interface InteractionHandlerConfig extends UploadAccessPolicy {
  applicationId: string;
  storageDirectory?: string;
}

interface InteractionHandlerDependencies {
  config: InteractionHandlerConfig;
  logger: Logger;
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

function buildUploadSuccessMessage(
  documentId: string,
  originalFilename: string,
  byteSize: number,
  title?: string
): string {
  const lines = [
    "✅ Document uploaded successfully.",
    `Document ID: ${documentId}`,
    `Original filename: ${sanitizeFilenameForDisplay(originalFilename)}`,
    `File size: ${formatFileSize(byteSize)}`
  ];

  if (title) {
    lines.push(`Title: ${sanitizeTextForDisplay(title)}`);
  }

  lines.push("DOCX structure verified.");
  lines.push("Original file stored safely.");
  lines.push("SuperDocs ingestion will happen in Phase 3.");
  return lines.join("\n");
}

export function createInteractionHandler({
  config,
  logger
}: InteractionHandlerDependencies): RequestHandler {
  const storage = createDocumentStorage({
    ...(config.storageDirectory
      ? { rootDirectory: config.storageDirectory }
      : {})
  });

  return (request, response) => {
    try {
      const interaction = request.body as DiscordInteraction;
      const commandName = interaction.data?.name;
      const userId = interaction.member?.user?.id ?? interaction.user?.id;

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
          const stored = await ingestDocument(
            {
              interactionId: interaction.id,
              attachment: uploadData.attachment,
              ...(uploadData.title ? { title: uploadData.title } : {}),
              uploadedByUserId,
              guildId: uploadGuildId,
              channelId: uploadChannelId
            },
            { logger, storage }
          );

          content = buildUploadSuccessMessage(
            stored.documentId,
            stored.metadata.originalFilename,
            stored.metadata.byteSize,
            stored.metadata.title
          );
        } catch (error) {
          content = `❌ ${
            error instanceof DocumentIngestionError
              ? error.userMessage
              : "Draftcord could not process this document."
          }`;

          if (!(error instanceof DocumentIngestionError)) {
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
              errorCategory: "discord_api_error",
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown interaction response edit error"
            },
            "Failed to edit deferred Discord interaction response"
          );
        }
      })();
    } catch (error) {
      logger.error(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unknown interaction handling error"
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
