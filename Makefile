PROJECT_NAME := loamium

# ローカル起動設定 (.env, git 管理外) があれば読み込む。KEY=value 形式 (make 互換)。
# HOST / LOAMIUM_UI_ALLOWED_HOSTS
# などをここに書いておけば毎回コマンドに渡さなくてよい (テンプレは .env.example)。
# -include なので存在しなくてもエラーにしない。export で全変数を子プロセスへ渡す。
-include .env
export

DEV_VAULT ?= $(CURDIR)/dev-vault
# デフォルトはローカルのみ。LAN からアクセスするなら `make serve HOST=0.0.0.0` か .env で HOST=0.0.0.0 (無認証なので注意)
HOST ?= 127.0.0.1

# make は /bin/sh でレシピを実行するため、portman が /usr/local/bin にあっても
# 対話シェルの PATH 次第で見つからないことがある。ここで確実に通す。
export PATH := /usr/local/bin:$(PATH)

# ポートは portman があればリースで動的取得 (CLAUDE.md 準拠)。
# portman が見つからない/失敗する環境では、固定の既定ポートにフォールバックする。
# 既定を変えたいときは `make serve API_PORT=9000` のように上書き可。
API_PORT ?= 8202
UI_PORT ?= 8203

.PHONY: serve serve-ui stop test test-ui build lint verify clean samples websearch

# serve / serve-ui は起動前に対象ポートを掴んでいる LISTEN プロセスを解放する
# (stale な .pid で kill しそこねた古いサーバーによる EADDRINUSE を防ぐ。
#  lsof か fuser があれば使い、無ければスキップ)。
serve:
	@mkdir -p "$(DEV_VAULT)"
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		kill $$(cat .server.pid); sleep 1; \
	fi
	@PORT=$$(command -v portman >/dev/null 2>&1 && portman lease --name $(PROJECT_NAME) || echo $(API_PORT)) && { \
		if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:$$PORT -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true; \
		elif command -v fuser >/dev/null 2>&1; then fuser -k $$PORT/tcp 2>/dev/null || true; fi; \
		LOAMIUM_VAULT="$(DEV_VAULT)" PORT=$$PORT LOAMIUM_HOST=$(HOST) \
			nohup node_modules/.bin/tsx watch packages/server/src/index.ts > .server.log 2>&1 & \
		echo $$! > .server.pid; \
	}
	@sleep 2 && tail -1 .server.log || true
	@# API に続けて UI 開発サーバーも起動する (make serve だけで一式立ち上げる)。
	@# UI だけ起動したい場合は従来どおり make serve-ui を直接呼べる。
	@$(MAKE) --no-print-directory serve-ui

serve-ui:
	@if [ -f .ui.pid ] && kill -0 $$(cat .ui.pid) 2>/dev/null; then \
		kill $$(cat .ui.pid); sleep 1; \
	fi
	@UI_PORT=$$(command -v portman >/dev/null 2>&1 && portman lease --name $(PROJECT_NAME)-ui || echo $(UI_PORT)) && \
	API_PORT=$$(command -v portman >/dev/null 2>&1 && portman lease --name $(PROJECT_NAME) || echo $(API_PORT)) && { \
		if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:$$UI_PORT -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true; \
		elif command -v fuser >/dev/null 2>&1; then fuser -k $$UI_PORT/tcp 2>/dev/null || true; fi; \
		LOAMIUM_API_URL=http://127.0.0.1:$$API_PORT \
			nohup node_modules/.bin/vite packages/ui --host $(HOST) --port $$UI_PORT --strictPort > .ui.log 2>&1 & \
		echo $$! > .ui.pid; \
	}
	@sleep 2 && grep -m1 "Local:" .ui.log || tail -3 .ui.log

stop:
	@if [ -f .server.pid ]; then kill $$(cat .server.pid) 2>/dev/null || true; rm -f .server.pid; fi
	@if [ -f .ui.pid ]; then kill $$(cat .ui.pid) 2>/dev/null || true; rm -f .ui.pid; fi
	@# pid ファイルが stale でも、対象ポートを LISTEN しているプロセス(tsx watch の
	@# 子 node = 実サーバー含む)をポート基準で確実に止める。lsof 優先・fuser 代替。
	@API=$$(command -v portman >/dev/null 2>&1 && portman lease --name $(PROJECT_NAME) 2>/dev/null || echo $(API_PORT)); \
	 UI=$$(command -v portman >/dev/null 2>&1 && portman lease --name $(PROJECT_NAME)-ui 2>/dev/null || echo $(UI_PORT)); \
	 for p in $$API $$UI; do \
	   if command -v lsof >/dev/null 2>&1; then lsof -ti tcp:$$p -sTCP:LISTEN 2>/dev/null | xargs -r kill -9 2>/dev/null || true; \
	   elif command -v fuser >/dev/null 2>&1; then fuser -k $$p/tcp 2>/dev/null || true; fi; \
	 done
	@portman release --name $(PROJECT_NAME) 2>/dev/null || true
	@portman release --name $(PROJECT_NAME)-ui 2>/dev/null || true

test:
	@mkdir -p reports
	npm test

# UI の Playwright テスト (mock + e2e)。実サーバー + Vite はテストハーネスが
# 一時 vault・エフェメラルポートで起動する (packages/ui/tests/harness/)。
test-ui:
	@mkdir -p reports/ui
	cd packages/ui && npx playwright test

verify: test

# 機能サンプルノート集を vault へ投入する (S7e2d5c-3: SeedService シム)。
# 正本は packages/server/src/samples/ に移動済み (S7e2d5c-2)。
# このターゲットは後方互換シムとして SeedService を直接 tsx で呼び出す
# (サーバー起動不要)。ユーザー向けの正式手順は `loamium init-samples` を使うこと。
# 送り先は LOAMIUM_VAULT (未設定なら dev-vault)。既存ファイルは上書きしない。
samples:
	@DEST="$${LOAMIUM_VAULT:-$(DEV_VAULT)}"; \
	mkdir -p "$$DEST"; \
	LOAMIUM_VAULT="$$DEST" node_modules/.bin/tsx scripts/seed-samples.mjs \
	|| { echo "SeedService 呼び出し失敗 (tsx が見つかりません等)"; exit 1; }

build:
	npm run build --workspaces --if-present

lint:
	npm run lint --workspaces --if-present
	npm run lint:tests --if-present

# ローカル Web 検索アダプタ (ADR-0017 webSearch / API キー不要)。
# agent.json の webSearch.endpoint (http://127.0.0.1:8765/search) が指す先。
# フォアグラウンド起動 — 別ターミナルで動かしたまま Loamium を使う。
websearch:
	node dev-tools/websearch-adapter.mjs
