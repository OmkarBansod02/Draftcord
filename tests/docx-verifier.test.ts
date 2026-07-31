import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  InvalidDocxError,
  verifyDocx
} from "../src/documents/docx-verifier.js";

let validDocx: Buffer;

beforeAll(async () => {
  validDocx = await readFile("fixtures/sample-proposal.docx");
});

describe("verifyDocx", () => {
  it("verifies fixtures/sample-proposal.docx", async () => {
    await expect(verifyDocx(validDocx)).resolves.toBeUndefined();
  });

  it("rejects plain text renamed to .docx", async () => {
    await expect(
      verifyDocx(Buffer.from("This is not really a Word document."))
    ).rejects.toBeInstanceOf(InvalidDocxError);
  });

  it("rejects a PDF renamed to .docx", async () => {
    await expect(
      verifyDocx(Buffer.from("%PDF-1.7\nnot really a docx"))
    ).rejects.toBeInstanceOf(InvalidDocxError);
  });

  it("rejects a ZIP without word/document.xml", async () => {
    const arbitraryZip = Buffer.from(validDocx);
    const requiredName = Buffer.from("word/document.xml");
    const replacementName = Buffer.from("word/notdocxx.xml");
    let replacementCount = 0;
    let offset = arbitraryZip.indexOf(requiredName);

    while (offset >= 0) {
      replacementName.copy(arbitraryZip, offset);
      replacementCount += 1;
      offset = arbitraryZip.indexOf(requiredName, offset + requiredName.length);
    }

    expect(replacementCount).toBeGreaterThan(0);
    await expect(verifyDocx(arbitraryZip)).rejects.toBeInstanceOf(
      InvalidDocxError
    );
  });

  it("rejects a corrupt ZIP archive", async () => {
    const corruptZip = validDocx.subarray(0, Math.floor(validDocx.length / 2));
    await expect(verifyDocx(corruptZip)).rejects.toBeInstanceOf(
      InvalidDocxError
    );
  });

  it("rejects an empty buffer", async () => {
    await expect(verifyDocx(Buffer.alloc(0))).rejects.toBeInstanceOf(
      InvalidDocxError
    );
  });
});
