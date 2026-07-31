import { describe, expect, it } from "vitest";

import type { DiscordAttachment } from "../src/discord/types.js";
import {
  DOCX_MIME_TYPE,
  MAX_DOCX_SIZE_BYTES,
  validateDocxAttachment,
  validateUploadAccess
} from "../src/discord/upload-validation.js";

const validAttachment: DiscordAttachment = {
  id: "attachment-1",
  filename: "proposal.docx",
  size: 1024,
  content_type: DOCX_MIME_TYPE
};

const accessPolicy = {
  ownerUserId: "owner-1",
  guildId: "guild-1",
  documentChannelId: "channel-1"
};

describe("validateDocxAttachment", () => {
  it("accepts a valid DOCX attachment", () => {
    expect(validateDocxAttachment(validAttachment)).toEqual({ valid: true });
  });

  it("accepts an uppercase .DOCX extension", () => {
    expect(
      validateDocxAttachment({
        ...validAttachment,
        filename: "PROPOSAL.DOCX"
      })
    ).toEqual({ valid: true });
  });

  it("rejects an invalid extension", () => {
    expect(
      validateDocxAttachment({
        ...validAttachment,
        filename: "proposal.pdf"
      })
    ).toMatchObject({ valid: false });
  });

  it("rejects an invalid MIME type", () => {
    expect(
      validateDocxAttachment({
        ...validAttachment,
        content_type: "application/pdf"
      })
    ).toMatchObject({ valid: false });
  });

  it("rejects a file above 10 MB", () => {
    expect(
      validateDocxAttachment({
        ...validAttachment,
        size: MAX_DOCX_SIZE_BYTES + 1
      })
    ).toMatchObject({ valid: false });
  });
});

describe("validateUploadAccess", () => {
  it("accepts the configured owner, guild, and channel", () => {
    expect(
      validateUploadAccess(
        {
          userId: accessPolicy.ownerUserId,
          guildId: accessPolicy.guildId,
          channelId: accessPolicy.documentChannelId
        },
        accessPolicy
      )
    ).toEqual({ valid: true });
  });

  it("rejects the incorrect owner", () => {
    expect(
      validateUploadAccess(
        {
          userId: "someone-else",
          guildId: accessPolicy.guildId,
          channelId: accessPolicy.documentChannelId
        },
        accessPolicy
      )
    ).toMatchObject({ valid: false });
  });

  it("rejects the incorrect channel", () => {
    expect(
      validateUploadAccess(
        {
          userId: accessPolicy.ownerUserId,
          guildId: accessPolicy.guildId,
          channelId: "channel-2"
        },
        accessPolicy
      )
    ).toMatchObject({ valid: false });
  });

  it("rejects the incorrect guild", () => {
    expect(
      validateUploadAccess(
        {
          userId: accessPolicy.ownerUserId,
          guildId: "guild-2",
          channelId: accessPolicy.documentChannelId
        },
        accessPolicy
      )
    ).toMatchObject({ valid: false });
  });
});
