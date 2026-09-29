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
      .addStringOption((opt) => opt.setName('address').setDescription('メールアドレス').setRequired(true))
      .addBooleanOption((opt) =>
        opt
          .setName('force')
          .setDescription('既存のバインドを別アドレスで上書きする場合はtrue')
          .setRequired(false),
      ),
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
  )
  .addSubcommandGroup((group) =>
    group
      .setName('block')
      .setDescription('送信元アドレスのブロック管理')
      .addSubcommand((sub) =>
        sub
          .setName('add')
          .setDescription('指定したアドレスをブロックする(受信メールは迷惑メールチャンネルに転送される)')
          .addStringOption((opt) => opt.setName('address').setDescription('ブロックするメールアドレス').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription('指定したアドレスのブロックを解除する')
          .addStringOption((opt) => opt.setName('address').setDescription('ブロック解除するメールアドレス').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('list').setDescription('ブロック中の送信者一覧を表示する')),
  );
