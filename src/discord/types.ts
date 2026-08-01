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
  attachment_size_limit?: number;
  guild?: {
    attachment_size_limit?: number;
  };
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
    attachment_size_limit?: number;
    options?: DiscordInteractionOption[];
    resolved?: {
      attachments?: Record<string, DiscordAttachment>;
    };
  };
  message?: {
    id?: string;
    attachment_size_limit?: number;
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
