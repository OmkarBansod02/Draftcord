import "dotenv/config";

import express from "express";
import { verifyKeyMiddleware } from "discord-interactions";

const publicKey = process.env.DISCORD_PUBLIC_KEY;
const port = Number(process.env.PORT ?? 3000);

if (!publicKey) {
  throw new Error("DISCORD_PUBLIC_KEY is missing from .env");
}

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
  verifyKeyMiddleware(publicKey),
  (request, response) => {
    const interaction = request.body as {
      id?: string;
      type?: number;
      data?: {
        name?: string;
      };
    };

    console.log("Discord interaction received:", {
      id: interaction.id,
      type: interaction.type,
      command: interaction.data?.name
    });

    // Type 2 = APPLICATION_COMMAND
    if (interaction.type === 2 && interaction.data?.name === "ping") {
      console.log("Responding to /ping");

      return response.status(200).json({
        type: 4,
        data: {
          content: "🏓 Draftcord is online."
        }
      });
    }

    console.log("Unsupported interaction:", interaction.type, interaction.data?.name);

    return response.status(400).json({
      error: "Unsupported interaction"
    });
  }
);

app.listen(port, () => {
  console.log(`Draftcord listening on http://localhost:${port}`);
});
