import "dotenv/config";

import { randomUUID } from "node:crypto";
import { z } from "zod";

const apiKey = process.env.SUPERDOCS_API_KEY;

if (!apiKey) {
  throw new Error("SUPERDOCS_API_KEY is missing from .env");
}

const responseSchema = z.object({
  document_changes: z.object({
    updated_html: z.string()
  })
});

const sessionId = `draftcord-smoke-${randomUUID()}`;

const response = await fetch("https://api.superdocs.app/v1/chat", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    session_id: sessionId,
    document_html: `
      <h1>Implementation Proposal</h1>
      <p>Payment is due within 15 days.</p>
      <p>The quoted project price is ₹2,50,000.</p>
    `,
    message:
      'Change "Payment is due within 15 days" to "Payment is due within 30 days." Do not change the project price.',
    approval_mode: "approve_all"
  })
});

const rawBody = await response.text();

if (!response.ok) {
  throw new Error(
    `SuperDocs request failed (${response.status}): ${rawBody}`
  );
}

let parsedJson: unknown;

try {
  parsedJson = JSON.parse(rawBody);
} catch {
  throw new Error(`SuperDocs returned invalid JSON: ${rawBody}`);
}

const result = responseSchema.parse(parsedJson);

console.log("\nSuperDocs smoke test passed.\n");
console.log("Session:", sessionId);
console.log("\nUpdated document:\n");
console.log(result.document_changes.updated_html);
