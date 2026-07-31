import { describe, expect, it } from "vitest";

import { sanitizeFilenameForDisplay } from "../src/documents/filename-safety.js";

describe("sanitizeFilenameForDisplay", () => {
  it("removes path traversal and control characters from displayed filenames", () => {
    expect(
      sanitizeFilenameForDisplay("../../folder\\secret\n.docx")
    ).toBe("secret.docx");
  });
});
