# 環境メモ: /usr/bin/node は v20 なので nvm で 22 を明示的に使う。bun は ~/.bun/bin。
NVM  := . $$HOME/.nvm/nvm.sh && nvm use 22 >/dev/null &&
BUN  := $$HOME/.bun/bin/bun
CORPUS ?= packages/server/src/samples

.PHONY: install lint test roundtrip gate build serve serve-ui clean

install:
	$(NVM) npm install

lint:
	$(NVM) npx tsc -p packages/shared --noEmit
	$(NVM) npx tsc -p packages/server --noEmit
	$(NVM) npx tsc -p packages/ui --noEmit

## 不変条件 2 の gate (1): packages/shared のプロセッサ単体
roundtrip:
	$(BUN) run scripts/roundtrip-check.ts $(CORPUS)

## 不変条件 2 の gate (2): Milkdown 実体 + 書き手の収束 (jsdom)
test:
	$(NVM) npx vitest run

## 不変条件 2 を両側から検証する。CI はこれを回す
gate: roundtrip test

## 本番ビルド: プラグインは静的登録。動的 import を持ち込まないこと
build:
	$(BUN) build --compile --target=bun-linux-x64 ./packages/server/src/index.ts --outfile dist/loamium-server

serve:
	LOAMIUM_VAULT=./dev-vault PORT=$${PORT:-$$(portman lease --name loamium 2>/dev/null || echo 8200)} $(BUN) run packages/server/src/index.ts

## UI 開発サーバ (別ターミナルで make serve と併用する)
serve-ui:
	cd packages/ui && $(NVM) UI_PORT=$${UI_PORT:-5199} PORT=$${PORT:-8200} npx vite

clean:
	rm -rf dist
