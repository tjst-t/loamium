#!/usr/bin/env bash
set -euo pipefail

# Loamium server を bun compile でスタンドアロンバイナリにする
# 出力: packages/app-tauri/src-tauri/binaries/loamium-server-{target-triple}
#
# Tauri の externalBin は {name}-{target-triple} 命名を要求する。
# 現在のターゲットトリプルを取得:

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/../src-tauri/binaries"

mkdir -p "$OUT_DIR"

# ターゲットトリプルを取得 (rustc 優先、なければ uname から推定)
if command -v rustc &>/dev/null; then
  TARGET=$(rustc -vV | grep '^host:' | awk '{print $2}')
else
  ARCH=$(uname -m)
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$OS" in
    linux)  TARGET="${ARCH}-unknown-linux-gnu" ;;
    darwin) TARGET="${ARCH}-apple-darwin" ;;
    *)      TARGET="${ARCH}-unknown-${OS}" ;;
  esac
fi
echo "Target triple: $TARGET"

# Rust triple → bun target のマッピング
case "$TARGET" in
  x86_64-unknown-linux-*)   BUN_TARGET="bun-linux-x64" ;;
  aarch64-unknown-linux-*)  BUN_TARGET="bun-linux-arm64" ;;
  x86_64-apple-darwin)      BUN_TARGET="bun-darwin-x64" ;;
  aarch64-apple-darwin)     BUN_TARGET="bun-darwin-arm64" ;;
  x86_64-pc-windows-*)      BUN_TARGET="bun-windows-x64" ;;
  *)                         BUN_TARGET="bun-linux-x64" ;;  # fallback
esac
echo "Bun target: $BUN_TARGET"

BUN="${HOME}/.bun/bin/bun"
if ! command -v "$BUN" &>/dev/null; then
  BUN=$(command -v bun)
fi

echo "Building sidecar with bun..."
"$BUN" build --compile \
  --target="$BUN_TARGET" \
  "$PROJECT_ROOT/packages/server/src/index.ts" \
  --outfile "$OUT_DIR/loamium-server-$TARGET"

echo "Built: $OUT_DIR/loamium-server-$TARGET"
