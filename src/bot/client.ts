import {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  TextChannel,
  PermissionFlagsBits,
} from 'discord.js';
import type { Db } from '../db/client';
import type { ResendClient } from '../mail/resendClient';
import type { DiscordPoster } from '../services/inboundEmailService';
import { handleBindCommand, handleUnbindCommand, handleListCommand } from './commands/bindHandler';
import { handleBindGmailCommand } from './commands/gmailBindHandler';
import { handleSendCommand } from './commands/sendHandler';
import { handleBlockAddCommand, handleBlockRemoveCommand, handleBlockListCommand } from './commands/blockHandler';
import { classifyIncomingMessage } from './replyDetection';
import { sendReplyEmail, type GmailProvider, type OutboundProviders } from '../services/outboundEmailService';
import { fetchAsBuffer } from '../util/fetchBuffer';

const GENERIC_ERROR_REPLY = 'エラーが発生しました。もう一度お試しください。';
const MANAGE_CHANNELS_REQUIRED = 'このコマンドにはチャンネル管理権限が必要です。';

export function createBotClient(db: Db, resend: ResendClient, gmail: GmailProvider | null): Client {
  const providers: OutboundProviders = { resend, gmail };
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'mail') return;

    try {
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      // The OAuth link is personal to whoever ran the command and short-lived; every other
      // subcommand keeps today's non-ephemeral behavior.
      await interaction.deferReply({ ephemeral: sub === 'bind-gmail' });

      if (group === 'block') {
        // Same policy as bind/unbind: adding/removing a block needs channel-management
        // permission, while listing the current blocklist is open to anyone.
        if (sub !== 'list' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.editReply(MANAGE_CHANNELS_REQUIRED);
          return;
        }

        if (sub === 'add') {
          const address = interaction.options.getString('address', true);
          const result = await handleBlockAddCommand(db, { emailAddress: address, requestedBy: interaction.user.id });
          await interaction.editReply(result.replyText);
          return;
        }

        if (sub === 'remove') {
          const address = interaction.options.getString('address', true);
          const result = await handleBlockRemoveCommand(db, { emailAddress: address });
          await interaction.editReply(result.replyText);
          return;
        }

        if (sub === 'list') {
          const result = await handleBlockListCommand(db);
          await interaction.editReply(result.replyText);
          return;
        }
        return;
      }

      if (sub === 'bind' || sub === 'unbind' || sub === 'bind-gmail') {
        // Spec: bind/unbind require channel-management permission; list/send are open to anyone.
        // `memberPermissions` is null outside a guild, so this also rejects DM invocations.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
          await interaction.editReply(MANAGE_CHANNELS_REQUIRED);
          return;
        }
      }

      if (sub === 'bind-gmail') {
        const result = await handleBindGmailCommand(db, gmail, {
          discordGuildId: interaction.guildId!,
          discordChannelId: interaction.channelId,
          requestedBy: interaction.user.id,
        });
        await interaction.editReply(result.replyText);
        return;
      }

      if (sub === 'bind') {
        const address = interaction.options.getString('address', true);
        const force = interaction.options.getBoolean('force') ?? false;
        const result = await handleBindCommand(db, {
          discordGuildId: interaction.guildId!,
          discordChannelId: interaction.channelId,
          emailAddress: address,
          requestedBy: interaction.user.id,
          force,
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
        const result = await handleSendCommand(db, providers, {
          discordChannelId: interaction.channelId,
          discordMessageId: reply.id,
          to,
          subject,
          body,
          attachments,
        });
        await interaction.editReply(result.replyText);
      }
    } catch (err) {
      // Without this, any rejection here becomes an unhandled rejection and kills the process
      // (bot + webhook server), which under `restart: unless-stopped` is a silent crash loop.
      console.error('mail interaction handler failed:', err);
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(GENERIC_ERROR_REPLY);
        } else {
          await interaction.reply(GENERIC_ERROR_REPLY);
        }
      } catch (replyErr) {
        console.error('failed to report interaction error to Discord:', replyErr);
      }
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    try {
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

      const result = await sendReplyEmail(db, providers, {
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
    } catch (err) {
      console.error('message handler failed:', err);
      try {
        // Best-effort feedback; reacting can itself fail (e.g. missing Add Reactions permission).
        await message.react('❌');
      } catch (reactErr) {
        console.error('failed to react to a failed message:', reactErr);
      }
    }
  });

  return client;
}

// Discord rejects embed titles and author names longer than 256 characters, and EmbedBuilder
// throws synchronously when they are exceeded — which would blackhole the inbound email.
const EMBED_TEXT_MAX_LENGTH = 256;

function truncateForEmbed(value: string): string {
  return value.length <= EMBED_TEXT_MAX_LENGTH
    ? value
    : `${value.slice(0, EMBED_TEXT_MAX_LENGTH - 3)}...`;
}

export function createDiscordPoster(client: Client): DiscordPoster {
  return {
    async postEmailMessage(channelId, params) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }
      const embed = new EmbedBuilder()
        .setTitle(truncateForEmbed(params.subject || '(件名なし)'))
        .setAuthor({ name: truncateForEmbed(params.from) })
        .setDescription(params.bodyPreview || '(本文なし)');
      if (params.flagReason) {
        embed.setColor(0xed4245).addFields({ name: '⚠️ 検知理由', value: truncateForEmbed(params.flagReason) });
      }
      const message = await channel.send({
        embeds: [embed],
        files: params.attachments.map((a) => ({ attachment: a.content, name: a.filename })),
      });
      return { discordMessageId: message.id };
    },

    async postGmailMessage(channelId, params) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }
      // No .setDescription/.setImage/files here by design — Gmail-sourced mail is personal, so
      // the embed intentionally carries only subject/sender/link, never body text or attachments.
      const embed = new EmbedBuilder()
        .setTitle(truncateForEmbed(params.subject || '(件名なし)'))
        .setURL(params.viewUrl)
        .setAuthor({ name: truncateForEmbed(params.from) });
      const message = await channel.send({ embeds: [embed] });
      return { discordMessageId: message.id };
    },

    async postSystemMessage(channelId, text) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }
      const message = await channel.send(text);
      return { discordMessageId: message.id };
    },
  };
}
