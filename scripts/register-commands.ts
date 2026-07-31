import "dotenv/config";

import {
  REST,
  Routes,
  SlashCommandBuilder
} from "discord.js";

const applicationId = process.env.DISCORD_APPLICATION_ID;
const guildId = process.env.DISCORD_GUILD_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !guildId || !botToken) {
  throw new Error(
    "Missing DISCORD_APPLICATION_ID, DISCORD_GUILD_ID, or DISCORD_BOT_TOKEN"
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check whether Draftcord is online")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("doc")
    .setDescription("Work with Draftcord documents")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("upload")
        .setDescription("Validate a DOCX document for upload")
        .addAttachmentOption((option) =>
          option
            .setName("file")
            .setDescription("The DOCX document to upload")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("An optional document title")
            .setMaxLength(200)
        )
    )
    .toJSON()
];

const rest = new REST({ version: "10" }).setToken(botToken);

console.log("Registering Draftcord guild commands...");

await rest.put(
  Routes.applicationGuildCommands(applicationId, guildId),
  {
    body: commands
  }
);

console.log("Successfully registered /ping and /doc upload");
