export interface IncomingDiscordMessage {
  channelId: string;
  messageId: string;
  authorIsBot: boolean;
  content: string;
  referencedMessageId: string | null;
  attachments: { filename: string; url: string }[];
}

export type MessageIntent =
  | { kind: 'ignore' }
  | { kind: 'reply'; repliedToDiscordMessageId: string; body: string; attachments: { filename: string; url: string }[] };

export function classifyIncomingMessage(msg: IncomingDiscordMessage): MessageIntent {
  if (msg.authorIsBot) return { kind: 'ignore' };
  if (!msg.referencedMessageId) return { kind: 'ignore' };
  return {
    kind: 'reply',
    repliedToDiscordMessageId: msg.referencedMessageId,
    body: msg.content,
    attachments: msg.attachments,
  };
}
