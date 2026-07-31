import yauzl from "yauzl";

const REQUIRED_DOCX_ENTRIES = new Set([
  "[Content_Types].xml",
  "word/document.xml"
]);
const MAX_VERIFIED_ENTRY_SIZE_BYTES = 50 * 1024 * 1024;

export class InvalidDocxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidDocxError";
  }
}

export function verifyDocx(buffer: Buffer): Promise<void> {
  if (buffer.byteLength === 0) {
    return Promise.reject(new InvalidDocxError("DOCX file is empty"));
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(
            new InvalidDocxError("File is not a readable ZIP archive", {
              cause: openError
            })
          );
          return;
        }

        const found = new Set<string>();
        let settled = false;

        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(
            error instanceof InvalidDocxError
              ? error
              : new InvalidDocxError("ZIP archive is corrupt", { cause: error })
          );
        };

        zipFile.on("error", fail);
        zipFile.on("entry", (entry) => {
          if (!REQUIRED_DOCX_ENTRIES.has(entry.fileName)) {
            zipFile.readEntry();
            return;
          }

          if (entry.uncompressedSize > MAX_VERIFIED_ENTRY_SIZE_BYTES) {
            fail(
              new InvalidDocxError(
                `Required DOCX entry is too large: ${entry.fileName}`
              )
            );
            return;
          }

          zipFile.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(streamError ?? new Error("ZIP entry stream was unavailable"));
              return;
            }

            let streamedBytes = 0;
            stream.on("data", (chunk: Buffer) => {
              streamedBytes += chunk.byteLength;
              if (streamedBytes > MAX_VERIFIED_ENTRY_SIZE_BYTES) {
                stream.destroy(
                  new InvalidDocxError(
                    `Required DOCX entry is too large: ${entry.fileName}`
                  )
                );
              }
            });
            stream.on("error", fail);
            stream.on("end", () => {
              if (settled) return;
              found.add(entry.fileName);
              zipFile.readEntry();
            });
            stream.resume();
          });
        });
        zipFile.on("end", () => {
          if (settled) return;
          settled = true;
          zipFile.close();

          const missing = [...REQUIRED_DOCX_ENTRIES].filter(
            (entry) => !found.has(entry)
          );
          if (missing.length > 0) {
            reject(
              new InvalidDocxError(
                `ZIP archive is missing required DOCX entries: ${missing.join(", ")}`
              )
            );
            return;
          }

          resolve();
        });

        zipFile.readEntry();
      }
    );
  });
}
