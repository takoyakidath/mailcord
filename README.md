# mailcord

独自ドメインのメールをDiscord上で送受信するBot。[Resend](https://resend.com)を送受信の両方に使い、discord.jsのBotとFastifyのwebhookサーバーを1プロセスで動かす。SQLite 1ファイル(Drizzle ORM)に状態を持ち、Docker Compose(app + Caddy)でデプロイする。

設計の詳細は `docs/superpowers/specs/2026-08-27-mailcord-design.md` を参照。

## 仕組み(要約)

- Discordの**チャンネル**は自分たちの**送信元アドレス**を表す(相手先ではない)。`/mail bind` で1チャンネル=1アドレスを紐付ける。
- 届いたメールはBotが該当チャンネルにembedで転送する。**Discordのreply機能**で返信すると、そのメールスレッドへの返信としてメール送信される。
- reply以外の新規メールは `/mail send` コマンドで送る。

## 必要なもの

- Discord Bot(Application + Bot Token)
- Resendアカウント + 独自ドメインのDNS設定(SPF/DKIM/MX)
- Docker Compose が使えるサーバー、または開発用のNode.js 22+

## セットアップ

### 1. 環境変数

```bash
cp .env.example .env
```

`.env` に以下を設定する:

| 変数 | 内容 |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord Developer PortalのBot Token |
| `DISCORD_APPLICATION_ID` | DiscordアプリケーションのID |
| `RESEND_API_KEY` | ResendのAPIキー |
| `RESEND_WEBHOOK_SECRET` | Resendのinbound webhook署名シークレット(`whsec_...`) |
| `DB_PATH` | SQLiteファイルのパス(省略時 `./data/mailcord.db`) |
| `PORT` | HTTPサーバーのポート(省略時 `8787`) |

### 2. Discord Bot側の設定

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーション/Botを作成。
2. Bot設定で **Message Content Intent** を有効化(通常投稿・返信を読み取るために必須)。
3. 以下の権限でサーバーに招待する(`applications.commands` + `bot` スコープ):
   - Send Messages
   - Read Message History
   - Add Reactions(送受信結果の✅/❌表示に使用)
   - Attach Files(受信メールの添付転送に使用)

### 3. Resend側の設定

1. 独自ドメインを追加し、SPF/DKIMレコードを設定して検証する。
2. Inbound受信用にMXレコードを設定する。
3. Webhookを追加し、`email.received` イベントを `https://<自分のサブドメイン>/webhooks/resend/inbound` に送るよう設定。署名シークレットは `.env` の `RESEND_WEBHOOK_SECRET` と同じ値にする。

### 4. スラッシュコマンドの登録

```bash
npm install
npm run register-commands
```

Discord側への反映(global command)には数分〜最大1時間ほどかかることがある。デプロイのたびに実行する必要はなく、コマンド定義を変更したときだけでよい。

### 5. デプロイ(Docker Compose)

`Caddyfile` の `mail-hook.example.com` を実際のサブドメインに書き換え、そのDNS(A/AAAAレコード)をサーバーのIPに向けてから起動する(CaddyがTLS証明書を取得できるようにするため):

```bash
docker compose build
docker compose up -d
docker compose logs -f app
```

`mailcord listening on :8787` のログが出て再起動ループしていなければ正常。

### ローカル開発

```bash
npm install
npm run dev        # tsx で直接起動(.env を読み込む)
npm test           # テスト
npm run typecheck  # 型チェック
```

## 使い方

| コマンド | 権限 | 内容 |
|---|---|---|
| `/mail bind address:<email>` | チャンネル管理権限 | このチャンネルをアドレスにバインド。既に別アドレスにバインド済みなら `force:true` が必要 |
| `/mail unbind` | チャンネル管理権限 | バインド解除 |
| `/mail list` | 誰でも | サーバー内のバインド一覧 |
| `/mail send to:<email> subject:<件名> body:<本文> [attachment]` | バインド済チャンネルのみ | 新規メール送信 |

バインド済チャンネルに届いたメールへの返信は、そのメッセージにDiscordの **reply** で行う。reply以外の通常投稿はメール送信されない。

## スコープ外(v1)

CC/BCC、HTMLメールの高度なレンダリング、未バインドアドレス宛メールの通知(ログ破棄のみ)、1チャンネルへの複数アドレスバインド。詳細は設計ドキュメント参照。
