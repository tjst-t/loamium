# ADR-0034 調査メモ — 初回同期(既存 vault ↔ 既存 remote)の先行事例と実装レシピ

2026-07-26 サーベイ。ADR-0034 の裏付け。実装時の一次資料。

## 要約
成熟ツールで「両側にデータがある初回リンクを完全自動・無損失でマージ」できるものは**存在しない**(Obsidian Git はユーザーを CLI に落とす)。収束する実装パターンは **『先にバックアップ → マージ → add/add は keep-both 別ファイル → 決して上書きしない』**。`-X ours/theirs` はバイナリを片側に倒す silent data-loss なので既定にしない。

## 実装レシピ

### 0. 事前(ローカル確定 + リモート判別)
```sh
git init                                   # 冪等
git add -A && git commit -m "loamium: snapshot local vault before linking" || true
git remote add origin <URL>                # 既存なら set-url
git ls-remote --exit-code origin >/dev/null 2>&1
#   exit 0 + refs -> リモート非空
#   exit 2        -> リモート空 -> push するだけ
#   その他非0     -> 到達不能/auth 失敗 -> 中止(『空』と誤認しない)
```

### 1. プレビュー(作業ツリーを触らない dry-run) — 推奨エンジン
```sh
git fetch origin
MERGED_TREE=$(git merge-tree --write-tree --allow-unrelated-histories --name-only HEAD origin/main)
# exit 0=clean / 1=conflict。衝突ファイルの内容は「トップレベル tree から」読む
#   (stage OID を再マージしない — 情報が落ちる)。
# UI へ: リモートから X 追加 / ローカルから Y / 衝突 Z 件 を平易に提示。
```

### 2. 実マージ(両側データあり)+ keep-both
```sh
git branch backup/pre-link-<ts>            # 安全 ref
git merge --allow-unrelated-histories --no-commit --no-ff origin/main
# git が "both added" と報告する各 path について:
git show :2:<path> > "<path>"                          # ローカルをその場に
git show :3:<path> > "<path> (リモート <ts>).<ext>"    # リモートを keep-both 別ファイル
git add "<path>" "<path> (リモート <ts>).<ext>"
git commit -m "loamium: link vault to remote (conflicts kept as copies)"
git push -u origin main
```
- 片側だけのファイルは自動で両立。既定 keep-both。ユーザー希望時は ADR-0030 の 3-way UI で個別解決。

## エッジケース(順位付き)と緩和
1. **unrelated histories / add/add** → snapshot commit + `--allow-unrelated-histories` + keep-both。
2. **macOS NFD / 大文字小文字衝突** → checkout 前にパス衝突を事前スキャンし隔離。`core.precomposeunicode`(mac 既定 true)。Loamium は既に NFC 正規化。
3. **mid-merge クラッシュ残留** → merge-tree は作業ツリー非汚染。working-tree マージ時は起動時 `.git/MERGE_HEAD` 検出→ abort/復元をワンクリック。
4. **auth 失敗 vs 空** → `git ls-remote --exit-code` で判別、非0(no-refs 以外)は中止。
5. **大バイナリ / GitHub 100MB** → 初回コミット前にサイズスキャン→ gitignore or LFS を促す。
6. **CRLF/LF** → vault に `.gitattributes`(`* text=auto eol=lf`)を配置。per-device `core.autocrlf` に依存しない。
7. **巨大 vault 初回コミット perf** → UI スレッド外 + 進捗表示。ローカル snapshot を先に確定。
8. **.gitignore drift / 追跡済み ignore ファイル** → 共有 ignore を揃え、`git rm --cached`。

## UX パターン(非専門家向け)
- 初回リンクを**独立した1回きりのウィザード**として名付ける(通常同期と混ぜない)。
- **バックアップした旨を明示**(「統合前にローカル全体を保存しました。いつでも復元可」)。
- merge-tree で**平易な件数プレビュー**(git 用語・競合マーカーを表に出さない)。
- **keep-both を既定**。衝突は `名前 (リモート <時刻>).md` 等のサフィックス別ファイル(Syncthing `.sync-conflict-…` / Dropbox「Conflicted copy」/ Obsidian Sync「(Conflicted copy …)」に倣う)。素人に競合マーカー手編集をさせない。
- probe の**3結果を3メッセージ**で(空→アップロード / 非空→マージ・衝突は両方保持 / 到達不能→サインイン確認)。
- クラッシュ後は起動時に「再開 / 取り消し(復元)」を提示。

## 主要一次資料
- git-scm: [git-merge](https://git-scm.com/docs/git-merge) / [git-merge-tree](https://git-scm.com/docs/git-merge-tree) / [merge-strategies](https://git-scm.com/docs/merge-strategies)
- Obsidian Git: [README](https://github.com/Vinzent03/obsidian-git) / forum [unrelated-histories](https://forum.obsidian.md/t/obsidian-git-pull-failed-merge-failed-refusing-to-merge-unrelated-histories/77140) / issues #331 #688
- [Direct Git Sync plugin](https://community.obsidian.md/plugins/direct-git-sync)(backup-before-checkout + keep-both を実装済みの近接事例)
- Obsidian Sync: [help](https://obsidian.md/help/sync/vault-types) / [DeepWiki 2.3](https://deepwiki.com/obsidianmd/obsidian-help/2.3-synchronization-and-conflict-resolution)
- [Syncthing syncing](https://docs.syncthing.net/users/syncing.html)

## 確度
- 高: git-merge/merge-tree/strategy のフラグ意味、Syncthing 命名、Obsidian Git の unrelated-histories 失敗、mac precomposeunicode。
- 中: Obsidian Sync の**初回**マージ挙動(公式は継続時の記述のみ→初回特別扱いは無いと推定)。
- 要再確認(実装時): Direct Git Sync の conflict-copy 命名規則、Unison の初回挙動。
