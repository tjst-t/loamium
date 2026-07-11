#!/bin/sh
# 決定論的なテスト用シェル (ターミナル機構は ADR-0007 により廃止: S53409d-1)。
# このファイルは歴史的に残っているが、E2E ハーネスでは使用しない。
export PS1='loamium-test$ '
exec /bin/bash --norc --noprofile -i
