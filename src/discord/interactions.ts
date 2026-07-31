import type { RequestHandler } from "express";
import type { Logger } from "pino";

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
  attachment: DiscordAttachment,
  title?: string
): string {
  const lines = [
    "✅ Document metadata validation passed.",
    `Filename: ${attachment.filename}`,
    `File size: ${formatFileSize(attachment.size)}`
  ];

  if (title) {
    lines.push(`Title: ${title}`);
  }

  lines.push("Document ingestion will happen in the next phase.");
  return lines.join("\n");
}

export function createInteractionHandler({
  config,
  logger
}: InteractionHandlerDependencies): RequestHandler {
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
            filename: uploadData.attachment.filename,
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

      const successContent = buildUploadSuccessMessage(
        uploadData.attachment,
        uploadData.title
      );

      void editOriginalInteractionResponse({
        applicationId: config.applicationId,
        interactionToken: interaction.token,
        content: successContent
      })
        .then(() => {
          logger.info(
            {
              interactionId: interaction.id,
              filename: uploadData.attachment.filename,
              size: uploadData.attachment.size,
              hasTitle: Boolean(uploadData.title)
            },
            "Document upload metadata validated"
          );
        })
        .catch((error: unknown) => {
          logger.error(
            {
              interactionId: interaction.id,
              error:
                error instanceof Error
                  ? error.message
                  : "Unknown interaction response edit error"
            },
            "Failed to edit deferred Discord interaction response"
          );
        });
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
