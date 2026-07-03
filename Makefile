PROJECT_NAME := loamium
DEV_VAULT ?= $(CURDIR)/dev-vault

.PHONY: serve serve-ui stop test test-ui build lint verify clean

# ポートは portman が管理する (ハードコード禁止 — CLAUDE.md)。
# `portman lease` は同一プロジェクト・同一 name なら冪等に同じポートを返す。
serve:
	@mkdir -p "$(DEV_VAULT)"
	@if [ -f .server.pid ] && kill -0 $$(cat .server.pid) 2>/dev/null; then \
		kill $$(cat .server.pid); sleep 1; \
	fi
	@PORT=$$(portman lease --name $(PROJECT_NAME)) && { \
		LOAMIUM_VAULT="$(DEV_VAULT)" PORT=$$PORT \
			nohup node_modules/.bin/tsx watch packages/server/src/index.ts > .server.log 2>&1 & \
		echo $$! > .server.pid; \
	}
	@sleep 2 && tail -1 .server.log || true

serve-ui:
	@if [ -f .ui.pid ] && kill -0 $$(cat .ui.pid) 2>/dev/null; then \
		kill $$(cat .ui.pid); sleep 1; \
	fi
	@UI_PORT=$$(portman lease --name $(PROJECT_NAME)-ui) && \
	API_PORT=$$(portman lease --name $(PROJECT_NAME)) && { \
		LOAMIUM_API_URL=http://127.0.0.1:$$API_PORT \
			nohup node_modules/.bin/vite packages/ui --port $$UI_PORT --strictPort > .ui.log 2>&1 & \
		echo $$! > .ui.pid; \
	}
	@sleep 2 && grep -m1 "Local:" .ui.log || tail -3 .ui.log

stop:
	@if [ -f .server.pid ]; then kill $$(cat .server.pid) 2>/dev/null || true; rm -f .server.pid; fi
	@if [ -f .ui.pid ]; then kill $$(cat .ui.pid) 2>/dev/null || true; rm -f .ui.pid; fi
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

build:
	npm run build --workspaces --if-present

lint:
	npm run lint --workspaces --if-present
	npm run lint:tests --if-present
