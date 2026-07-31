import "dotenv/config";

import { startDraftcord } from "./application.js";

void startDraftcord().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`Draftcord startup failed: ${message}`);
  process.exitCode = 1;
});
