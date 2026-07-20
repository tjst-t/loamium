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

## 4. Tauri デスクトップ

Tauri v2 を使ったネイティブデスクトップアプリ（`packages/app-tauri/`）。GitHub Releases から各 OS のインストーラーをダウンロードして実行するだけで使えます。

- 初回起動時にフォルダ選択ダイアログが表示されます。vault として使いたいフォルダを選択してください。
- 以後は「File > Vault を変更…」メニューからいつでも vault を切り替えられます。
- Node.js や bun のインストールは不要です（バイナリに同梱済み）。

### セルフビルド（開発者向け）

```bash
# 前提: bun, Rust, および OS ごとの依存パッケージ（DEPLOY.md 外 — README 参照）

# 1. サイドカーバイナリをビルド
bash packages/app-tauri/scripts/build-sidecar.sh

# 2. Tauri アプリをビルド（バンドルなし — バイナリのみ確認）
cargo build --release --manifest-path packages/app-tauri/src-tauri/Cargo.toml

# 3. フル bundle（インストーラー生成）
cargo tauri build --project-path packages/app-tauri
```

---

## 5. バージョンとリリース（タグ運用）

Loamium はバージョン文字列を **git タグ `vX.Y.Z`** から埋め込みます。専用のバージョンファイルは持たず、タグが唯一の入力です。

### バージョンの埋め込み

- **UI**: ビルド時に Vite の `define` が `__APP_VERSION__` を注入します（`packages/ui/vite.config.ts` の `resolveAppVersion()`）。解決順は
  1. 環境変数 `LOAMIUM_VERSION`（CI がタグから設定）
  2. `git describe --tags`（開発時）
  3. ルート `package.json` の version（フォールバック）
  ロゴ右に控えめに表示されます。リリースタグちょうどなら `v0.1.0`、タグ以降の開発ビルドは `v0.1.0+NN`（NN = タグからのコミット数）と表示されます（ハッシュ付きの完全値はツールチップ）。
- **サーバー**: `GET /api/health` の `version` フィールドで返します（`LOAMIUM_VERSION` → `package.json`。git 非依存）。CLI／エージェントから参照できます。

### タグを切ると 3 つの成果物が自動リリース

`vX.Y.Z` タグを push すると、GitHub Actions が同じタグの Release に成果物を集約します。

```bash
git tag v1.2.3
git push origin v1.2.3
```

| ワークフロー | 成果物 |
|---|---|
| `release-web.yml`   | サーバー + UI ビルド済みの自己完結 tar.gz（`loamium-web-vX.Y.Z.tar.gz`、linux-x64。同梱 tsx で `node_modules/.bin/tsx packages/server/src/index.ts` 起動） |
| `docker-publish.yml`| GHCR の Docker イメージ（`ghcr.io/<repo>:X.Y.Z` ほか。`LOAMIUM_VERSION` を build-arg で埋め込み） |
| `electron-build.yml`| Windows デスクトップアプリ（NSIS インストーラー + zip） |

いずれもタグ名からバージョンを解決します。さらに CI は `scripts/apply-version.mjs` で各成果物の `package.json` の version もタグから焼き込むため、**リポジトリの `package.json` を手で更新する必要はありません**（据え置きのままでよい）。`vX.Y.Z` タグを切ることが唯一の操作です。
