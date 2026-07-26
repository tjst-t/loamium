# Vault 同期の使い方

Loamium の Vault 同期は、ローカル Markdown ファイルをリモート git リポジトリと同期する機能です。  
専用同期サーバーは不要で、システムの `git` コマンドにシェルアウトして push/pull を行います (ADR-0032)。

## 前提

- **Vault のルート自身が git リポジトリであること** (`git init` 済み)。未初期化だと同期は無効化され、
  ステータスに「vault が git 未初期化」と表示されます。vault が repo でない、または別リポジトリの中に
  ネストしている場合、エンジンは git 操作を一切行いません (親リポジトリの誤操作を防ぐため)。
- システムに `git` (2.x 以上) がインストールされていること
- リモートリポジトリ (GitHub private / self-hosted bare / NAS 上の bare repo) が用意されていること
- Vault のルートに `.loamium/` を除外する `.gitignore` があること (エンジンが自動追加します)

> [!important] .loamium/ は同期しない
> `.loamium/` ディレクトリ (audit.log / sync.json / sync-credentials.json / models/) は
> gitignore 必須で、端末間には同期されません。
> これは audit ログ・トークン・ローカルキャッシュが vault (git) に誤ってコミットされないようにするためです。
> エンジンは commit 前に `.loamium/` が gitignore されているか自動確認し、なければ `.gitignore` に追記します。

---

## リモートの設定

### GUI から設定する (推奨)

アプリの **設定 → 同期** から、リモート URL・ブランチ・自動同期・デバイス名・PAT を GUI で設定・保存できます。CLI/REST を触らずにアプリ内で同期を設定・開始できます。

### REST API / CLI

```bash
# リモート URL とブランチを設定する
loamium sync config --remote https://github.com/yourname/vault.git --branch main

# 設定確認
loamium sync config
```

または REST:

```http
PUT /api/sync/config
Content-Type: application/json
{ "remoteUrl": "https://github.com/yourname/vault.git", "branch": "main" }
```

### 認証

**git credential 委譲 (推奨)**: PAT を設定しない場合、システムの `git credential helper` がそのまま使われます。  
macOS の Keychain や Git Credential Manager (Windows) を設定しておくと自動認証されます。

**PAT フォールバック**: credential helper が無い環境では PAT (Personal Access Token) を設定します。

```bash
# PAT を .loamium/sync-credentials.json に 0600 で保存
# (vault 管理外・git にコミットされない)
curl -X PUT http://localhost:3000/api/sync/credential \
  -H 'Content-Type: application/json' \
  -d '{"token":"ghp_xxx..."}'
```

> [!warning] PAT はVaultに保存しない
> PAT は `.loamium/sync-credentials.json` (gitignore 済み) または環境変数 `LOAMIUM_SYNC_TOKEN` に置き、
> vault の Markdown ノートや `.git/config` には絶対に書かないでください。
> Loamium は PAT を push/pull コマンドの `http.extraheader` に per-command で注入し、
> ディスクの `.git/config` には残しません。

---

## 手動同期

### UI

右上の同期バッジ (`⇅`) の「今すぐ同期」ボタンをクリックします。

### CLI

```bash
# commit→pull--rebase→push を実行
loamium sync now

# 状態確認
loamium sync status

# 個別操作
loamium sync pull   # リモートから pull のみ
loamium sync push   # リモートへ push のみ
```

### エージェントツール

```
// 状態確認 (read-only セッションでも使える)
sync_status {}

// 今すぐ同期 (full 権限が必要)
sync_now {}
```

詳細は `help "sync"` を参照してください。

---

## 自動同期 (Auto-Sync)

自動同期を有効にすると、ファイルの変更を検知して自動的に commit→push します。

```bash
# 自動同期を有効化
loamium sync config --auto on
```

| トリガー | 動作 |
| --- | --- |
| 編集停止 (デバウンス 30 秒) | auto-commit → push |
| ウィンドウフォーカス時 | pull (リモートの最新を取得) |
| 定期 (15 分ごと) | pull (定期更新) |
| ウィンドウブラー / アプリ終了 | 保留中の commit を即時 flush |

---

## オフラインキュー

ネットワーク不通時の push/pull 失敗は「未 push のローカルコミット」として保持されます。  
接続が回復すると次のトリガーで自動的に再送します。

```
// 状態確認でオフラインとキューを見る
sync_status {}
// → offline: true, queued: 3  ← 3 コミットが push 待ち
```

---

## 競合の処理

`git rebase --rebase` 中に自動解決できない競合が発生した場合:

1. Loamium は `diff3Merge` (ADR-0030) で自動マージを試みます。
2. 自動解決できたファイルは自動的に追加して rebase を続けます。
3. 解決できなかったファイルのみ UI の競合ダイアログ (同期バッジ) に表示されます。
4. ユーザーはエディタで競合ファイルを編集し、再度「今すぐ同期」で解決します。

> [!note] 競合マーカーはファイルに書かれない
> `<<<`, `===`, `>>>` の競合マーカーは Markdown ファイルに保存されません。
> Loamium はリベースを中断 (`--abort`) してローカル編集を保護します。

---

## 対応リモート

| リモート種別 | URL 例 | 備考 |
| --- | --- | --- |
| GitHub private | `https://github.com/user/vault.git` | PAT または credential helper で認証 |
| self-hosted bare | `git@myserver.example.com:vault.git` | SSH 鍵で認証 |
| ローカル bare (NAS / USB) | `file:///path/to/vault.git` | 認証不要 |

---

## CLI リファレンス

| コマンド | 説明 |
| --- | --- |
| `loamium sync status` | 同期状態を表示 |
| `loamium sync now` | 今すぐ同期 (commit→pull→push) |
| `loamium sync config` | 設定を表示 |
| `loamium sync config --remote <url>` | リモート URL を設定 |
| `loamium sync config --branch <b>` | ブランチを設定 |
| `loamium sync config --auto on\|off` | 自動同期の有効/無効 |
| `loamium sync pull` | リモートから pull |
| `loamium sync push` | リモートへ push |
| `loamium sync link --remote <url> --preview` | 初回リンクのプレビュー (dry-run、push しない) |
| `loamium sync link --remote <url>` | 初回リンクを実行 (衝突は既定 keep-both) |
| `loamium sync link --remote <url> --on-conflict <action>` | 衝突の既定操作を指定して適用 (keep-both\|local\|remote) |

---

## 初回リンク (既存 Vault と既存リモートの安全なリンク)

既にローカル Vault にノートがあり、かつリモートリポジトリにもデータがある場合、素朴な `git pull` は
「unrelated histories」エラーになります。Loamium の初回リンクはこの問題を安全に解決します。

### auto-init

同期セットアップ時に Vault が git 未初期化なら、Loamium が自動で `git init` を行います。
既存ファイルは「link 前スナップショット」として 1 コミットにまとめます。Vault が
別リポジトリ内にネストしている場合はリンクを拒否します (誤操作防止)。

### GUI から始める

**設定 → 同期 → 同期をセットアップ** をクリックするだけです。

1. リモート URL を入力して「リンク開始」をクリック
2. 衝突がなければ自動でマージ・push が完了し、**完了ダイアログ** に結果サマリが表示されます
3. 衝突がある場合は **初回リンク競合ダイアログ** が表示されます

### 初回リンク競合ダイアログ

衝突ファイルごと、または全件まとめて解決方法を選べます。

| 選択肢 | 動作 |
| --- | --- |
| 両方保持 (既定) | ローカルはそのまま、リモートを `<名前>.remote.<拡張子>` として保存 |
| 3-way で統合 | ConflictResolverDialog で 2 つのバージョンを手動マージ |
| ローカル採用 | ローカルのファイルを採用 (リモートは backup ref から復元可) |
| リモート採用 | リモートのファイルを採用 (ローカルは backup ref から復元可) |

> [!important] バックアップ ref
> リンク前に必ず `backup/pre-link-<timestamp>` ref が作成されます。
> どの選択肢を選んでも `git checkout backup/pre-link-<ts> -- <file>` で復元できます。

### keep-both のファイル名規約

`<名前>.remote.<拡張子>` が既存の場合は `<名前>.remote-2.<拡張子>` と連番が付きます。
コピーも通常の追跡ファイルとして全端末に伝播します。不要になったら削除して再同期してください。

### CLI から始める

```bash
# プレビュー (作業ツリーを変更しない dry-run)
loamium sync link --remote https://github.com/you/vault.git --preview
# → plan: merge, addedFromRemote: 5, addedFromLocal: 3, conflicts: 2

# 衝突を keep-both (既定) で適用
loamium sync link --remote https://github.com/you/vault.git

# 衝突をリモート採用で適用
loamium sync link --remote https://github.com/you/vault.git --on-conflict remote
```

### クラッシュ安全

リンク処理中に Loamium がクラッシュ・強制終了した場合、次回起動時に
「前回のリンク処理が途中です」バナーが **同期をセットアップ** ダイアログ内に表示されます。
`git merge --abort` 相当の取り消しはコマンドラインで行えます。
