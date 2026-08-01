import { readFile } from "node:fs/promises";

const PDF_HEADER = /^%PDF-(?:1\.[0-7]|2\.0)/;
const MAX_EOF_DISTANCE_BYTES = 2_048;

export class InvalidPdfError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPdfError";
  }
}

export function verifyPdf(buffer: Buffer): void {
  if (buffer.byteLength === 0) {
    throw new InvalidPdfError("PDF file is empty");
  }

  const header = buffer.subarray(0, Math.min(buffer.byteLength, 32)).toString("latin1");
  if (!PDF_HEADER.test(header)) {
    throw new InvalidPdfError("PDF file has no plausible PDF header");
  }

  const eofMarker = Buffer.from("%%EOF", "latin1");
  const eofPosition = buffer.lastIndexOf(eofMarker);
  if (
    eofPosition < 0 ||
    buffer.byteLength - eofPosition > MAX_EOF_DISTANCE_BYTES
  ) {
    throw new InvalidPdfError("PDF file is missing a nearby EOF marker");
  }
}

export async function verifyPdfFile(file: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    throw new InvalidPdfError("PDF file could not be read", { cause: error });
  }
  verifyPdf(bytes);
}

