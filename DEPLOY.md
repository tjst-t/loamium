# Loamium デプロイガイド

ローカル Markdown ファイルを vault として扱う個人用ノートアプリ Loamium のデプロイ手順です。

---

## 1. Native 起動（直接デプロイ）

### 前提

- Node.js 22+
- npm

### 手順

```bash
# 1. リポジトリをクローンして依存関係をインストール
git clone https://github.com/tjst-t/loamium.git
cd loamium
npm ci

# 2. vault パスを設定
export LOAMIUM_VAULT=/path/to/your/vault

# 3. 全 workspace をビルド
make build

# 4. サーバーを起動
LOAMIUM_UI_DIST=packages/ui/dist PORT=3000 node packages/server/src/index.ts
```

ブラウザで `http://localhost:3000` を開くとアプリにアクセスできます。

### 環境変数一覧

| 変数名 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `LOAMIUM_VAULT` | 必須 | — | vault として使用するディレクトリの絶対パス |
| `LOAMIUM_UI_DIST` | 必須 | — | ビルド済み UI 静的ファイルのパス（`packages/ui/dist`） |
| `PORT` | 任意 | `3000` | サーバーがリッスンするポート番号 |
| `LOAMIUM_HOST` | 任意 | `127.0.0.1` | サーバーのバインドアドレス |
| `LOAMIUM_MODE` | 任意 | — | 動作モード（例: `production`） |

---

## 2. Docker 起動

### 前提

- Docker
- Docker Compose

### 手順

```bash
# 1. vault ディレクトリを用意（既存の vault パスでも可）
mkdir vault

# 2. コンテナを起動
docker compose up -d

# 3. ブラウザで開く
open http://localhost:3000
```

### docker-compose.yml の例

```yaml
services:
  loamium:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./vault:/vault   # ホストの vault ディレクトリをコンテナにマウント
    environment:
      LOAMIUM_VAULT: /vault                    # コンテナ内マウントポイント
      LOAMIUM_UI_DIST: /app/packages/ui/dist   # Dockerfile のビルド済み UI パス
      PORT: 3000
      LOAMIUM_HOST: 0.0.0.0          # コンテナ外からアクセスするため全インターフェースでリッスン
```

`LOAMIUM_VAULT=/vault` はコンテナ内のマウントポイントとして自動設定されているため、ホスト側のディレクトリを `./vault:/vault` でマウントするだけで vault が機能します。

---

## 3. 外部公開オプション（任意）

> **注意**: このセクションはすべて任意のオプションです。LAN 内や localhost だけで使う場合は不要です。

### Option A: Cloudflare Tunnel

ドメインやポート開放なしでインターネットから安全にアクセスできます。

```bash
# cloudflared をインストール後に実行
cloudflared tunnel --url http://localhost:3000
```

- Cloudflare Zero Trust でアクセス制御（認証・IP 制限等）が可能です。
- トンネル URL は起動のたびに変わります。固定したい場合は Named Tunnel を使用してください。

### Option B: Tailscale

Tailscale ネットワーク内の端末だけに公開します。

```bash
# Tailscale をインストール・ログイン後に実行
tailscale serve http://localhost:3000
```

- VPN メンバーのみがアクセスできるため、セキュリティ設定が最小で済みます。

### Option C: Caddy（リバースプロキシ）

独自ドメインで TLS を自動取得してリバースプロキシします。

```caddyfile
your.domain.example {
    reverse_proxy localhost:3000
}
```

- 事前にポート 80/443 の開放と DNS レコードの設定が必要です。
- Caddy が Let's Encrypt 証明書を自動取得・更新します。

---

## 4. Tauri デスクトップ（将来実装予定）

Tauri を使ったネイティブデスクトップアプリ形式のデプロイは将来の Sprint で実装予定です。詳細は ADR-0008 を参照してください。
