# ──────────────────────────────────────────────
# Stage 1: builder
# ──────────────────────────────────────────────
FROM node:22-alpine AS builder

RUN apk add --no-cache make

WORKDIR /app

# npm workspaces のロックファイルと package.json 群を先にコピーしてキャッシュを活かす
COPY package.json package-lock.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/server/package.json   ./packages/server/
COPY packages/cli/package.json      ./packages/cli/
COPY packages/ui/package.json       ./packages/ui/

RUN npm ci

# 残りのソース全体をコピーしてビルド
COPY . .

# タグ由来のバージョンを UI ビルドへ埋め込む (CI が --build-arg で渡す)。
# 未指定なら vite が git describe / package.json でフォールバック解決する。
ARG LOAMIUM_VERSION=""
ENV LOAMIUM_VERSION=${LOAMIUM_VERSION}

# タグが指定されていれば各 package.json の version にも焼き込む (空ならスキップ)。
# イメージ内 package.json / server health の fallback をタグ準拠にする。
RUN node scripts/apply-version.mjs "$LOAMIUM_VERSION"

RUN make build

# ──────────────────────────────────────────────
# Stage 2: runner
# ──────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# ビルド成果物と実行に必要なファイルだけをコピー
COPY --from=builder /app/package.json       ./package.json
COPY --from=builder /app/package-lock.json  ./package-lock.json
COPY --from=builder /app/node_modules       ./node_modules
COPY --from=builder /app/packages/shared    ./packages/shared
COPY --from=builder /app/packages/server    ./packages/server
COPY --from=builder /app/packages/ui/dist   ./packages/ui/dist

# /api/health がバージョンを返せるよう runner 側にも引き継ぐ (stage 跨ぎで再宣言)
ARG LOAMIUM_VERSION=""
ENV LOAMIUM_VERSION=${LOAMIUM_VERSION}

ENV LOAMIUM_VAULT=/vault
ENV LOAMIUM_UI_DIST=/app/packages/ui/dist
ENV LOAMIUM_HOST=0.0.0.0

VOLUME ["/vault"]

EXPOSE 3000

CMD ["node_modules/.bin/tsx", "packages/server/src/index.ts"]
