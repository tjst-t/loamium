#!/bin/sh
# 決定論的なテスト用シェル (Playwright E2E の terminal specs 用)。
#
# LOAMIUM_TERMINAL_CMD は引数を分解しない (シェル文字列ではなく単一コマンド) ため、
# bash に --norc などのフラグを渡すにはこのラッパを経由する。狙いは
# 「E2E が実行環境の dotfile に依存しないこと」:
#   - --norc --noprofile: ~/.bashrc・/etc/bash.bashrc を読まない。starship などの
#     カスタムプロンプト (例: `❯`) を無視し、プロンプトを決定論的にする。
#   - PS1 を固定: プロンプト末尾が常に `$` になり、terminal specs の
#     「プロンプト到着 = 接続確立」待ち (toContainText('$')) が環境非依存で安定する。
#
# これがないと、開発者や CI のログインシェル設定によってプロンプト文字が変わり、
# claude-sidebar / search-slim の terminal E2E が「常に落ちる」不健全なテストになる。
export PS1='loamium-test$ '
exec /bin/bash --norc --noprofile -i
