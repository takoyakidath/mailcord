# mailcord 設計仕様書

## 概要

独自ドメインのメールをDiscord上で送受信できるようにする。メール送受信基盤には
Resend(Send API + Inbound Webhook)を使う。既存のVPS(Docker利用可)上に
Node.js/TypeScriptのモノリスアプリとしてデプロイする。

## 用語・前提

- 「アドレス」: 独自ドメイン上の送信元メールアドレス(例: `tako@octo.jp`)。
  Resend側でドメイン検証・DKIM/SPF/MX設定が済んでいることを前提とする(手動作業、範囲外)。
- 「チャンネル」: Discordのテキストチャンネル。1アドレスにつき1チャンネルを
  スラッシュコマンドでバインドする(**チャンネルは自分たちの送信元アドレスを表し、
  メールの相手先を表すものではない**)。同一チャンネル内で複数の外部相手とやり取りされうる。

## アーキテクチャ

```
Discord ⇄ [discord.js Gateway] ─┐
                                  ├─ mailcord app (Node.js/TS, 単一プロセス)
Resend inbound webhook → [Fastify HTTP] ┘         │
                                                    ├─ SQLite (Drizzle ORM)
                                                    └─ Resend Send API (アウトバウンド)
```

- `mailcord` アプリは1プロセスで、Discord Gateway接続とHTTPサーバー
  (Resend inbound webhook受信用)を両方持つ。
- Caddyがリバースプロキシとして自動TLS(Let's Encrypt)を終端し、
  専用サブドメイン(例: `mail-hook.octo.jp`)で `mailcord` コンテナへプロキシする。
- 状態(アドレス⇔チャンネル対応、メールスレッド⇔Discordメッセージ対応)は
  すべてSQLite 1ファイルに集約する。

採用理由: 個人〜小規模チーム用途で、構成要素を増やしても得るものが少ないため、
プロセス分離(Bot/Webhook receiverを分ける案)や外部サービス経由(Cloudflare Workers
で受けてVPSへ転送する案)は採らず、単一プロセスのモノリス構成とする。

## コンポーネント

| コンポーネント | 役割 | 主な依存 |
|---|---|---|
| `bot/` | discord.js Gateway接続。スラッシュコマンド処理、通常メッセージ/reply検知 | discord.js, `db/` |
| `web/` | Fastify HTTPサーバー。Resend inbound webhookの受信・署名検証・パース | Svix(署名検証), `db/` |
| `mail/` | Resend Send APIラッパー。送信、添付エンコード、スレッドヘッダー(In-Reply-To/References)付与 | Resend SDK |
| `db/` | アドレス⇔チャンネル対応、メールスレッド⇔Discordメッセージ対応表 | Drizzle ORM, better-sqlite3 |

## データモデル

```sql
-- アドレス ⇔ チャンネル対応
address_bindings (
  id, email_address UNIQUE, discord_guild_id, discord_channel_id,
  created_by, created_at
)

-- メールスレッド ⇔ Discordメッセージの対応(reply解決・メールスレッディングの要)
email_threads (
  id,
  discord_message_id UNIQUE,   -- Botが転送投稿したDiscordメッセージ、または送信直後の元投稿
  binding_id,                  -- どのaddress_bindingsに属するか
  external_address,            -- 相手先メールアドレス
  email_message_id,            -- そのメールのRFC Message-ID
  in_reply_to,                 -- 直前のMessage-ID
  references_chain,            -- References ヘッダ全体(スペース区切り文字列)
  direction,                   -- 'inbound' | 'outbound'
  created_at
)
```

## メールフロー

### 受信(メール → Discord)

1. Resendが独自ドメイン宛メールを受信し、`POST /webhooks/resend/inbound` を呼ぶ。
2. Svixで署名検証。不正なら401を返す。
3. `to` アドレスで `address_bindings` を検索。一致するバインドがなければ
   ログに記録して破棄する(v1では通知先チャンネルなし)。
4. 該当チャンネルにembedで投稿する(From / Subject / 本文抜粋、添付はDiscordの
   ファイル添付として転送)。
5. 投稿したDiscordメッセージID・Message-ID・References等を `email_threads` に
   insertする。

### 送信 - 新規(`/mail send`)

1. コマンド実行チャンネルの `address_bindings` からFromアドレスを解決する
   (未バインドならエラーを返す)。
2. Resend Send APIで送信する(コマンドに添付があれば取り込む)。
3. 送信結果をチャンネルに確認メッセージとして投稿し、`email_threads` に
   新規行(direction=outbound)を追加する。

### 送信 - 返信(Discordのreplyメッセージ)

1. reply先のDiscordメッセージIDで `email_threads` を検索する。見つからなければ
   「返信先が不明です」という警告を返して終了する。
2. 見つかった `external_address` / `references_chain` / `email_message_id` を使い、
   `In-Reply-To` / `References` ヘッダ付きでResend送信する。
3. `email_threads` に新規行を追記する(この送信自体をキーにして、更に返信が
   来たときに繋げられるようにする)。

### Bot以外の通常投稿(replyでもコマンドでもない)

メール送信は行わず無視する(宛先が定まらないため)。将来的にリアクション等での
フィードバックを追加する余地は残す。

## スラッシュコマンド

| コマンド | 権限 | 内容 |
|---|---|---|
| `/mail bind address:<email>` | チャンネル管理者権限 | 現在のチャンネルをそのアドレスにバインドする(既存バインドがあれば上書き確認) |
| `/mail unbind` | チャンネル管理者権限 | バインドを解除する |
| `/mail list` | 誰でも | サーバー内の全バインド一覧を表示する |
| `/mail send to:<email> subject:<text> body:<text> [attachment]` | バインド済チャンネルのみ | 新規メールを送信する |

## エラーハンドリング

- Resend送信失敗(ドメイン未検証・レート制限・無効アドレス等): Botが該当メッセージに
  ❌リアクションを付け、エラー内容をスレッド返信する。
- Webhook署名不正: 401でリジェクトし、ログのみ記録する(Discord通知なし)。
- 未バインドアドレス宛の受信メール: ログに記録して破棄する。
- Discord Gatewayの切断: discord.jsの自動再接続に任せる。
- 添付ファイルサイズ超過(Discord上限/Resend上限): 超過分はスキップし、
  本文に「添付は容量超過のため省略されました」と注記する。

## テスト方針

- ヘッダー組み立て(In-Reply-To/References生成)・アドレス⇔チャンネル解決ロジックは
  純粋関数として切り出し、ユニットテストする。
- Resend APIはSDKをモックして送信ペイロードを検証する。
- Webhook署名検証は既知の正当/不正ペイロードでテストする。
- 実機での送受信確認は最後にステージングドメイン(またはResendのテストモード)で
  1往復手動確認する。

## デプロイ

- `docker-compose.yml`: `app`(mailcord本体)+ `caddy`(自動TLS、専用サブドメインで
  リバースプロキシ)。
- 環境変数: `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `RESEND_API_KEY`,
  `RESEND_WEBHOOK_SECRET`, `DB_PATH`。
- 前提作業(手動、範囲外): Resend側で独自ドメインのDNS(SPF/DKIM/MX)設定、
  inbound webhook URLの登録。

## スコープ外(v1では対応しない)

- CC/BCC対応
- HTMLメールの高度なレンダリング(Discord側は本文抜粋+必要ならプレーンテキスト化のみ)
- 未バインドアドレス宛メールの通知(ログ破棄のみ)
- マルチアドレス送信者(1チャンネルに複数バインド)
