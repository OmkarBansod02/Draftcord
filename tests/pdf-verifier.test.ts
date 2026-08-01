import { describe, expect, it } from "vitest";

import { InvalidPdfError, verifyPdf } from "../src/documents/pdf-verifier.js";

describe("PDF verifier", () => {
  it("accepts a plausible PDF with an EOF marker", () => {
    expect(() => verifyPdf(Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"))).not.toThrow();
  });

  it.each([
    Buffer.alloc(0),
    Buffer.from("<html>error</html>"),
    Buffer.from("%PDF-1.7\nnot finished")
  ])("rejects invalid PDF bytes", (bytes) => {
    expect(() => verifyPdf(bytes)).toThrow(InvalidPdfError);
  });
});

