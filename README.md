# mailcord

独自ドメインのメールをDiscord上で送受信するBot。[Resend](https://resend.com)を送受信の両方に使い、discord.jsのBotとFastifyのwebhookサーバーを1プロセスで動かす。SQLite 1ファイル(Drizzle ORM)に状態を持ち、Docker Compose(app + Cloudflare Tunnel)でデプロイする。

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
| `SPAM_CHANNEL_ID` | ブロック済み送信者・迷惑メール判定されたメールの転送先チャンネルID(省略時 `1554435622993661972`) |
| `CLOUDFLARE_TUNNEL_TOKEN` | Cloudflare Tunnelのトークン(Docker Compose利用時のみ必要。下記「5. デプロイ」参照) |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_OAUTH_REDIRECT_URI` / `GMAIL_TOKEN_ENCRYPTION_KEY` | Gmail連携を使う場合のみ、4つすべて設定する(下記「Gmail連携」参照) |
| `GMAIL_POLL_INTERVAL_MS` | Gmailの新着メールをポーリングする間隔・ミリ秒(省略時 `60000`) |

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

### 5. デプロイ(Docker Compose + Cloudflare Tunnel)

ポート開放や固定IP/DDNSなしで公開できるよう、Cloudflare Tunnel経由でデプロイする(自宅サーバーでの運用にも向く)。

1. [Cloudflare Zero Trust ダッシュボード](https://one.dash.cloudflare.com/) → **Networks > Tunnels** で新しいトンネルを作成(Docker用の接続方法を選ぶ)。
2. 発行される **トンネルトークン**を `.env` の `CLOUDFLARE_TUNNEL_TOKEN` に設定する。
3. 同じ画面の **Public Hostname** 設定で、使いたいサブドメイン(例: `mail-hook.octo.jp`)を追加し、Service に `HTTP` / `app:8787` を指定する(`app` はdocker-compose内のサービス名なので、この文字列のまま設定してよい)。DNSレコードはCloudflareが自動で作成する。
4. Resendのwebhook URLをそのサブドメイン(`https://mail-hook.octo.jp/webhooks/resend/inbound`)に向ける。

```bash
docker compose build
docker compose up -d
docker compose logs -f app
docker compose logs -f cloudflared
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
| `/mail block add address:<email>` | チャンネル管理権限 | 送信元アドレスをブロックする |
| `/mail block remove address:<email>` | チャンネル管理権限 | ブロックを解除する |
| `/mail block list` | 誰でも | ブロック中の送信者一覧を表示 |
| `/mail bind-gmail` | チャンネル管理権限 | このチャンネルを自分のGmailアカウントにバインドする(Google OAuth認可、下記「Gmail連携」参照) |

バインド済チャンネルに届いたメールへの返信は、そのメッセージにDiscordの **reply** で行う。reply以外の通常投稿はメール送信されない。

## Gmail連携(任意)

独自ドメインを持たない個人のGmailアドレスをチャンネルにバインドしたい場合、`/mail bind` (Resend)ではなく `/mail bind-gmail` を使う。Resendの独自ドメイン検証とは別の仕組みで、Google OAuth2 + Gmail APIで直接そのGmailアカウントに接続する。

**設定手順:**

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成し、Gmail APIを有効化する。
2. OAuth同意画面を設定し(テストユーザーとして自分のGmailアドレスを追加すれば十分)、OAuth 2.0 クライアントID(種類: ウェブアプリケーション)を作成する。承認済みのリダイレクトURIに `https://<自分のサブドメイン>/oauth/gmail/callback` を追加する。
3. `.env` に `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_OAUTH_REDIRECT_URI`(上記と同じURL)を設定する。
4. `openssl rand -hex 32` で生成した値を `GMAIL_TOKEN_ENCRYPTION_KEY` に設定する(OAuthトークンの暗号化キー。他の用途に使い回さないこと)。
5. Discordで対象チャンネルで `/mail bind-gmail` を実行し、返信されたリンクからGoogleアカウントを認可する。

**動作の違い(Resendバインドとの比較):**

- 受信は約 `GMAIL_POLL_INTERVAL_MS` ミリ秒間隔のポーリング(Gmail History API)。Pub/Subのようなpush通知は使わない。
- Gmail由来の受信メールは、個人のメールという性質上、Discordのembedに **件名・差出人・Gmailで開くリンクのみ** を表示する(本文プレビュー・添付ファイルは表示しない)。Resendバインドの既存の埋め込み(本文プレビューあり)とは意図的に異なる。
- OAuthのリフレッシュ/アクセストークンはSQLite内にAES-256-GCMで暗号化して保存する。
- `/mail unbind` はGmailバインドにも共通で使え、紐づくOAuthトークンも削除される。

## 迷惑メール判定・送信元ブロック

Resend経由の受信メールは簡易的なキーワード/パターンベースのヒューリスティックで迷惑メール判定される(`src/services/spamFilter.ts`)。判定に引っかかったメール、および `/mail block` でブロックした送信者からのメールは、通常のバインド済みチャンネルではなく `SPAM_CHANNEL_ID` で指定したチャンネルにembedで転送され、検知理由が併記される。

`/mail block` の送信元ブロックはGmail由来の受信にも共通で適用される(Gmail自体のスパム判定を通り抜けて届いたメールが対象)。一方、キーワードヒューリスティックはGmail受信には適用しない(Gmail自体のスパム判定に委ねる)。

## スコープ外(v1)

CC/BCC、HTMLメールの高度なレンダリング、未バインドアドレス宛メールの通知(ログ破棄のみ)、1チャンネルへの複数アドレスバインド。詳細は設計ドキュメント参照。
