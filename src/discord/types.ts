export interface DiscordAttachment {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
}

export interface DiscordInteractionOption {
  name: string;
  type: number;
  value?: string;
  options?: DiscordInteractionOption[];
}

export interface DiscordInteraction {
  id?: string;
  application_id?: string;
  type: number;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  member?: {
    user?: {
      id?: string;
    };
  };
  user?: {
    id?: string;
  };
  data?: {
    name?: string;
    custom_id?: string;
    component_type?: number;
    options?: DiscordInteractionOption[];
    resolved?: {
      attachments?: Record<string, DiscordAttachment>;
    };
  };
  message?: {
    id?: string;
  };
}

export interface DiscordInteractionResponse {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    allowed_mentions?: {
      parse: string[];
    };
    components?: unknown[];
  };
}
