import "dotenv/config";

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";

const API_BASE = "https://api.superdocs.app/v1";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const apiKey = process.env.SUPERDOCS_API_KEY;

if (!apiKey) {
  throw new Error("SUPERDOCS_API_KEY is missing from .env");
}

const inputPath = resolve("fixtures/sample-proposal.docx");
const outputPath = resolve("fixtures/output/sample-proposal-revised.docx");
const filename = basename(inputPath);
const sessionId = `draftcord-docx-${randomUUID()}`;

const uploadSchema = z.object({
  upload_id: z.string(),
  upload_url: z.string().url()
});

const processSchema = z.object({
  session_id: z.string(),
  filename: z.string(),
  status: z.string(),
  chunks_count: z.number().nullable().optional(),
  warnings: z.array(z.unknown()).nullable().optional()
});

const chatSchema = z.object({
  document_changes: z
    .object({
      updated_html: z.string().optional()
    })
    .optional()
});

const downloadSchema = z.object({
  download_url: z.string().url(),
  filename: z.string(),
  format: z.string(),
  expires_in_seconds: z.number()
});

async function requestJson(
  url: string,
  init: RequestInit
): Promise<unknown> {
  const response = await fetch(url, init);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Request failed: ${response.status} ${response.statusText}\n${body}`
    );
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`Expected JSON but received:\n${body}`);
  }
}

console.log("\n1. Reading local DOCX...");

const fileBuffer = await readFile(inputPath);

console.log(`   File: ${filename}`);
console.log(`   Size: ${fileBuffer.byteLength} bytes`);
console.log(`   Session: ${sessionId}`);

console.log("\n2. Requesting SuperDocs upload URL...");

const uploadResult = uploadSchema.parse(
  await requestJson(`${API_BASE}/uploads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      filename,
      content_type: DOCX_MIME,
      size_bytes: fileBuffer.byteLength,
      purpose: "document"
    })
  })
);

console.log(`   Upload ID: ${uploadResult.upload_id}`);

console.log("\n3. Uploading DOCX bytes...");

const binaryBody = new Uint8Array(fileBuffer);

const uploadResponse = await fetch(uploadResult.upload_url, {
  method: "PUT",
  headers: {
    "Content-Type": DOCX_MIME
  },
  body: binaryBody
});

if (!uploadResponse.ok) {
  throw new Error(
    `Binary upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`
  );
}

console.log("   Upload complete.");

console.log("\n4. Processing DOCX into editable session...");

const processResult = processSchema.parse(
  await requestJson(
    `${API_BASE}/uploads/${uploadResult.upload_id}/process`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        session_id: sessionId,
        filename,
        parse_mode: "document",
        return_html: false
      })
    }
  )
);

console.log(`   Status: ${processResult.status}`);
console.log(`   Chunks: ${processResult.chunks_count ?? "not returned"}`);

if (processResult.warnings?.length) {
  console.log(`   Warnings: ${processResult.warnings.length}`);
}

console.log("\n5. Editing the uploaded document...");

const chatResult = chatSchema.parse(
  await requestJson(`${API_BASE}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      session_id: sessionId,
      message:
        'Change "Payment is due within 15 days." to "Payment is due within 30 days." Do not change the project price or any other content.',
      approval_mode: "approve_all"
    })
  })
);

console.log("   Edit completed.");

if (chatResult.document_changes?.updated_html) {
  const changedCorrectly =
    chatResult.document_changes.updated_html.includes(
      "Payment is due within 30 days."
    );

  const pricePreserved =
    chatResult.document_changes.updated_html.includes("₹2,50,000");

  console.log(`   Payment term changed: ${changedCorrectly}`);
  console.log(`   Project price preserved: ${pricePreserved}`);

  if (!changedCorrectly || !pricePreserved) {
    throw new Error("The targeted edit verification failed.");
  }
}

console.log("\n6. Requesting revised DOCX download...");

const downloadResult = downloadSchema.parse(
  await requestJson(`${API_BASE}/downloads`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      session_id: sessionId,
      format: "docx",
      filename: "sample-proposal-revised.docx"
    })
  })
);

console.log(`   Export filename: ${downloadResult.filename}`);
console.log(
  `   Download expires in: ${downloadResult.expires_in_seconds} seconds`
);

console.log("\n7. Downloading revised DOCX...");

const downloadResponse = await fetch(downloadResult.download_url);

if (!downloadResponse.ok) {
  throw new Error(
    `Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`
  );
}

const exportedBytes = new Uint8Array(
  await downloadResponse.arrayBuffer()
);

await mkdir(resolve("fixtures/output"), { recursive: true });
await writeFile(outputPath, exportedBytes);

console.log("\nSuperDocs DOCX round trip passed.");
console.log(`Output: ${outputPath}`);
console.log(`Output size: ${exportedBytes.byteLength} bytes\n`);
