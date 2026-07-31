import {
  Client,
  Events,
  GatewayIntentBits,
  type ClientOptions,
  type Message
} from "discord.js";
import type { Logger } from "pino";

export const DRAFTCORD_GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent
] as const;

interface GatewayClientLike {
  user?: { id: string; username: string } | null;
  application?: { id: string } | null;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  login(token: string): Promise<string>;
  destroy(): void;
}

interface ListenerRegistration {
  ready: () => void;
  message: (message: Message) => void;
  error: () => void;
  disconnect: (event: { code?: number }, shardId: number) => void;
}

const LISTENER_REGISTRATION = Symbol.for("draftcord.gateway.listeners");

export interface DiscordGateway {
  start(): Promise<void>;
  destroy(): void;
  client: GatewayClientLike;
}

export function createDiscordGateway({
  token,
  logger,
  onMessage,
  clientFactory = (options) => new Client(options) as GatewayClientLike
}: {
  token: string;
  logger: Logger;
  onMessage: (message: Message) => void;
  clientFactory?: (options: ClientOptions) => GatewayClientLike;
}): DiscordGateway {
  if (!token.trim()) throw new Error("DISCORD_BOT_TOKEN must not be empty");

  const client = clientFactory({ intents: [...DRAFTCORD_GATEWAY_INTENTS] });
  const instrumentedClient = client as GatewayClientLike & {
    [LISTENER_REGISTRATION]?: ListenerRegistration;
  };
  const previous = instrumentedClient[LISTENER_REGISTRATION];
  if (previous) {
    client.off(Events.ClientReady, previous.ready);
    client.off(Events.MessageCreate, previous.message);
    client.off(Events.Error, previous.error);
    client.off(Events.ShardDisconnect, previous.disconnect);
  }

  const registration: ListenerRegistration = {
    ready: () => {
      logger.info(
        {
          event: "gateway_ready",
          botApplicationId: client.application?.id,
          botUserId: client.user?.id,
          botUsername: client.user?.username
        },
        "Discord Gateway ready"
      );
    },
    message: onMessage,
    error: () => {
      logger.error(
        { event: "gateway_error", errorCategory: "gateway_error" },
        "Discord Gateway error"
      );
    },
    disconnect: (event, shardId) => {
      logger.warn(
        {
          event: "gateway_disconnected",
          shardId,
          closeCode: event.code
        },
        "Discord Gateway shard disconnected"
      );
    }
  };

  instrumentedClient[LISTENER_REGISTRATION] = registration;
  client.once(Events.ClientReady, registration.ready);
  client.on(Events.MessageCreate, registration.message);
  client.on(Events.Error, registration.error);
  client.on(Events.ShardDisconnect, registration.disconnect);

  return {
    client,
    async start() {
      await client.login(token);
    },
    destroy() {
      client.destroy();
    }
  };
}
