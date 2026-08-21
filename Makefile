# ツールチェーンの解決。
# ローカル開発機は PATH に無い (/usr/bin/node は v20、bun は ~/.bun/bin)。
# CI では PATH 上のものをそのまま使う。どちらでも動くよう両対応にする。
NVM  := if [ -s "$$HOME/.nvm/nvm.sh" ]; then . "$$HOME/.nvm/nvm.sh"; nvm use 22 >/dev/null; fi;
BUN   = $$([ -x "$$HOME/.bun/bin/bun" ] && echo "$$HOME/.bun/bin/bun" || command -v bun)
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

## 不変条件 2 の gate (2): Milkdown 実体 + 書き手の収束、および vault の各種検証
test:
	$(NVM) npx vitest run

## CI が回すゲート一式
gate: lint roundtrip test

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
