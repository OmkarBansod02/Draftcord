import { describe, expect, it } from "vitest";

import { createSafeExportFilename } from "../src/documents/export-filenames.js";

describe("safe export filenames", () => {
  it("uses a deterministic versioned basename and correct extension", () => {
    expect(createSafeExportFilename({
      title: "../Implementation Proposal @everyone",
      originalFilename: "fallback.docx",
      editCount: 3
    }, "docx")).toBe("implementation-proposal-＠everyone-revised-v3.docx");
  });

  it("falls back to a non-empty safe basename and stays bounded", () => {
    const filename = createSafeExportFilename({
      title: "../../\u0000",
      originalFilename: "../../.docx",
      editCount: 0
    }, "pdf");
    expect(filename).toBe("document-revised-v0.pdf");
    expect(filename.length).toBeLessThan(200);
    expect(filename).not.toMatch(/[/\\@]/);
  });
});

