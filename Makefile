# 環境メモ: /usr/bin/node は v20 なので nvm で 22 を明示的に使う。bun は ~/.bun/bin。
NVM  := . $$HOME/.nvm/nvm.sh && nvm use 22 >/dev/null &&
BUN  := $$HOME/.bun/bin/bun
CORPUS ?= packages/server/src/samples

.PHONY: install lint roundtrip build serve clean

install:
	$(NVM) npm install

lint:
	$(NVM) npx tsc -p packages/shared --noEmit
	$(NVM) npx tsc -p packages/server --noEmit

## 不変条件 2 の gate。B (冪等性) と C (意味の保存) が通らなければ失敗する
roundtrip:
	$(BUN) run scripts/roundtrip-check.ts $(CORPUS)

## 本番ビルド: プラグインは静的登録。動的 import を持ち込まないこと
build:
	$(BUN) build --compile --target=bun-linux-x64 ./packages/server/src/index.ts --outfile dist/loamium-server

serve:
	LOAMIUM_VAULT=./dev-vault PORT=$${PORT:-$$(portman lease --name loamium 2>/dev/null || echo 8200)} $(BUN) run packages/server/src/index.ts

clean:
	rm -rf dist
