import { Client, GatewayIntentBits, Events, EmbedBuilder, TextChannel } from 'discord.js';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import { handleBindCommand, handleUnbindCommand, handleListCommand } from './commands/bindHandler';
import { handleSendCommand } from './commands/sendHandler';
import { classifyIncomingMessage } from './replyDetection';
import { sendReplyEmail } from '../services/outboundEmailService';
import { fetchAsBuffer } from '../util/fetchBuffer';

export function createBotClient(db: Db, resend: ResendClient): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'mail') return;

    const sub = interaction.options.getSubcommand();
    await interaction.deferReply();

    if (sub === 'bind') {
      const address = interaction.options.getString('address', true);
      const result = await handleBindCommand(db, {
        discordGuildId: interaction.guildId!,
        discordChannelId: interaction.channelId,
        emailAddress: address,
        requestedBy: interaction.user.id,
      });
      await interaction.editReply(result.replyText);
      return;
    }

    if (sub === 'unbind') {
      const result = await handleUnbindCommand(db, { discordChannelId: interaction.channelId });
      await interaction.editReply(result.replyText);
      return;
    }

    if (sub === 'list') {
      const result = await handleListCommand(db, { discordGuildId: interaction.guildId! });
      await interaction.editReply(result.replyText);
      return;
    }

    if (sub === 'send') {
      const to = interaction.options.getString('to', true);
      const subject = interaction.options.getString('subject', true);
      const body = interaction.options.getString('body', true);
      const attachment = interaction.options.getAttachment('attachment');
      const attachments = attachment
        ? [{ filename: attachment.name, content: await fetchAsBuffer(attachment.url) }]
        : [];

      const reply = await interaction.editReply('送信中...');
      const result = await handleSendCommand(db, resend, {
        discordChannelId: interaction.channelId,
        discordMessageId: reply.id,
        to,
        subject,
        body,
        attachments,
      });
      await interaction.editReply(result.replyText);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    const intent = classifyIncomingMessage({
      channelId: message.channelId,
      messageId: message.id,
      authorIsBot: message.author.bot,
      content: message.content,
      referencedMessageId: message.reference?.messageId ?? null,
      attachments: [...message.attachments.values()].map((a) => ({ filename: a.name, url: a.url })),
    });

    if (intent.kind === 'ignore') return;

    const attachments = await Promise.all(
      intent.attachments.map(async (a) => ({ filename: a.filename, content: await fetchAsBuffer(a.url) })),
    );

    const result = await sendReplyEmail(db, resend, {
      discordChannelId: message.channelId,
      discordMessageId: message.id,
      repliedToDiscordMessageId: intent.repliedToDiscordMessageId,
      body: intent.body,
      attachments,
    });

    if (result.ok) {
      await message.react('✅');
    } else {
      await message.react('❌');
      await message.reply(`送信に失敗しました: ${result.error}`);
    }
  });

  return client;
}

export function createDiscordPoster(client: Client): DiscordPoster {
  return {
    async postEmailMessage(channelId, params) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }
      const embed = new EmbedBuilder()
        .setTitle(params.subject || '(件名なし)')
        .setAuthor({ name: params.from })
        .setDescription(params.bodyPreview || '(本文なし)');
      const message = await channel.send({
        embeds: [embed],
        files: params.attachments.map((a) => ({ attachment: a.content, name: a.filename })),
      });
      return { discordMessageId: message.id };
    },
  };
}
