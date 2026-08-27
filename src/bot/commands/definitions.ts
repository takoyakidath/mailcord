import { SlashCommandBuilder } from 'discord.js';

export const mailCommand = new SlashCommandBuilder()
  .setName('mail')
  .setDescription('メールをDiscordで送受信する')
  // Every subcommand needs a guild/channel context; DMs would leave `guildId` null.
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('bind')
      .setDescription('このチャンネルをメールアドレスにバインドする')
      .addStringOption((opt) => opt.setName('address').setDescription('メールアドレス').setRequired(true)),
  )
  .addSubcommand((sub) => sub.setName('unbind').setDescription('このチャンネルのバインドを解除する'))
  .addSubcommand((sub) => sub.setName('list').setDescription('このサーバーのバインド一覧を表示する'))
  .addSubcommand((sub) =>
    sub
      .setName('send')
      .setDescription('新規メールを送信する')
      .addStringOption((opt) => opt.setName('to').setDescription('宛先メールアドレス').setRequired(true))
      .addStringOption((opt) => opt.setName('subject').setDescription('件名').setRequired(true))
      .addStringOption((opt) => opt.setName('body').setDescription('本文').setRequired(true))
      .addAttachmentOption((opt) => opt.setName('attachment').setDescription('添付ファイル').setRequired(false)),
  );
