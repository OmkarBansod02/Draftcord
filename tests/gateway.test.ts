import { EventEmitter } from "node:events";

import { Events, GatewayIntentBits, type ClientOptions } from "discord.js";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscordGateway,
  DRAFTCORD_GATEWAY_INTENTS
} from "../src/discord/gateway.js";

class FakeClient extends EventEmitter {
  user = { id: "bot-1", username: "Draftcord" };
  application = { id: "application-1" };
  login = vi.fn(async () => "bot-token");
  destroy = vi.fn();
}

describe("Discord Gateway", () => {
  it("configures only the required intents and does not connect until started", async () => {
    const fake = new FakeClient();
    let options: ClientOptions | undefined;
    const gateway = createDiscordGateway({
      token: "bot-token",
      logger: pino({ level: "silent" }),
      onMessage: vi.fn(),
      clientFactory: (clientOptions) => {
        options = clientOptions;
        return fake;
      }
    });

    expect(options?.intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]);
    expect(DRAFTCORD_GATEWAY_INTENTS).not.toContain(
      GatewayIntentBits.GuildMembers
    );
    expect(fake.login).not.toHaveBeenCalled();
    await gateway.start();
    expect(fake.login).toHaveBeenCalledWith("bot-token");
  });

  it("does not register duplicate listeners on a reused client", () => {
    const fake = new FakeClient();
    const clientFactory = () => fake;
    createDiscordGateway({
      token: "bot-token",
      logger: pino({ level: "silent" }),
      onMessage: vi.fn(),
      clientFactory
    });
    const secondHandler = vi.fn();
    createDiscordGateway({
      token: "bot-token",
      logger: pino({ level: "silent" }),
      onMessage: secondHandler,
      clientFactory
    });

    expect(fake.listenerCount(Events.MessageCreate)).toBe(1);
    fake.emit(Events.MessageCreate, { id: "message-1" });
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("destroys the client without exposing or reusing the token", () => {
    const fake = new FakeClient();
    const gateway = createDiscordGateway({
      token: "bot-token",
      logger: pino({ level: "silent" }),
      onMessage: vi.fn(),
      clientFactory: () => fake
    });
    gateway.destroy();
    expect(fake.destroy).toHaveBeenCalledOnce();
    expect(fake.login).not.toHaveBeenCalled();
  });
});
