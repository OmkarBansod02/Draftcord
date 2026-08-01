import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadExportToTemporaryFile,
  removeTemporaryExport
} from "../src/documents/export-download.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "draftcord-export-download-"));
  roots.push(value);
  return value;
}

describe("signed export downloads", () => {
  it("streams a bounded HTTPS response without sending authorization", async () => {
    const directory = await root();
    const fetchMock = vi.fn(async (
      _url: string | URL,
      init?: RequestInit
    ) => {
      expect(init?.headers).not.toHaveProperty("Authorization");
      return new Response(Buffer.from("verified export"), {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "15"
        }
      });
    });
    const downloaded = await downloadExportToTemporaryFile({
      url: "https://signed.example/download?token=secret",
      temporaryParentDirectory: directory,
      maxBytes: 100,
      fetchImplementation: fetchMock as unknown as typeof fetch
    });
    expect(await readFile(downloaded.filePath, "utf8")).toBe("verified export");
    expect(downloaded.byteSize).toBe(15);
    await removeTemporaryExport(downloaded);
    await expect(access(downloaded.temporaryDirectory)).rejects.toThrow();
  });

  it("follows only HTTPS redirects and enforces the byte limit while streaming", async () => {
    const directory = await root();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { Location: "https://signed.example/next" }
      }))
      .mockResolvedValueOnce(new Response(Buffer.from("too large"), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" }
      }));
    await expect(downloadExportToTemporaryFile({
      url: "https://signed.example/start",
      temporaryParentDirectory: directory,
      maxBytes: 4,
      fetchImplementation: fetchMock as unknown as typeof fetch
    })).rejects.toMatchObject({ category: "download_size_limit" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an insecure redirect and cleans temporary files", async () => {
    const directory = await root();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "http://signed.example/insecure" }
    }));
    await expect(downloadExportToTemporaryFile({
      url: "https://signed.example/start",
      temporaryParentDirectory: directory,
      maxBytes: 100,
      fetchImplementation: fetchMock as unknown as typeof fetch
    })).rejects.toMatchObject({ category: "download_insecure_redirect" });
    expect((await import("node:fs/promises")).readdir(directory)).resolves.toEqual([]);
  });
});

