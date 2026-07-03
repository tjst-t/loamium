# Loamium — 引き継ぎドキュメント

LogSeq と Obsidian の「いいとこどり」を狙った個人用ノートアプリ。ローカルの Markdown ファイルを正とし、アウトライナー編集とエージェント統合を両立させる。

---

## 1. プロダクト概要

### コンセプト

「**ファイルはピュア Markdown、編集はアウトライナー、操作はエージェントからも**」

- **Obsidian から**: ローカルの `.md` ファイルがすべて。ロックインなし。フォルダ構造そのまま。Git やエディタで直接触れる。
- **LogSeq から**: アウトライナー編集（インデントでブロック管理）、デイリージャーナル中心ワークフロー、タスク管理。
- **独自**: エージェント（Claude Code 等）が REST API / CLI / Skill 経由でノートを読み書き・整理できる。

### 設計上の重要な割り切り

- **編集モデルは「素直な Markdown を正、アウトラインはリストへのオプトイン操作」（C 方式）**。ノートの正本は 1 本のプレーンな Markdown テキスト。見出し `#`・段落・リスト `- `・コードフェンスをすべて標準記法のまま保存する。LogSeq のように全行を `- ` リストへ変換しない（Obsidian で開くと箇条書き地獄になり、文章中心ノートが歪むため）。アウトライン操作（`Tab`/`Shift+Tab`/折りたたみ）はカーソルがリスト行にあるときだけ効く。ジャーナルや断片メモは自然にアウトライナー的に、設計メモや議事録は普通の Markdown として振る舞う。
- **LogSeq のブロック ID 方式は採用しない**。ファイルにブロック ID を埋め込むと Markdown が汚れ、Obsidian 互換性が崩れるため。ファイルシステムを正とする。
- **LogSeq のブロック参照は捨てる**（複雑性の元凶）。
- **プラグイン API は作らない**（個人用なのでコア機能で完結）。
- グラフビューは MVP 後でよい（見た目は良いが実用頻度は低い）。

### 編集体験（C 方式の具体）

- **正本**: `note.md` のテキストそのもの。データモデルは「ブロック配列」ではなく Markdown 文字列。
- **エディタ**: CodeMirror 6。ソース編集とライブプレビュー（or 装飾表示）を行き来する。Obsidian の Live Preview に近い。
- **アウトライン操作の適用範囲**: リスト行（`- ` / `1. ` / `- [ ]`）にカーソルがあるとき `Tab`/`Shift+Tab` でインデント、行の折りたたみ。見出し・段落には効かない。
- **実装難度**: C は A（全行ブロック化）より重い。「リスト行だけインデント・折りたたみ」は CodeMirror の構文解析（lezer-markdown）に乗せて実装する。Obsidian も同等機能を持つため実績ある組み合わせ。

---

## 2. アーキテクチャ

```
外部（スマホ・外出先）
    │ HTTPS
    ▼
Cloudflare Tunnel + Cloudflare Access（認証）
    │
    ▼
自宅 PC（localhost）
 ┌───────────────────────────────────┐
 │  Loamium アプリ本体                    │
 │  ├── UI (React + CodeMirror 6)     │
 │  ├── REST API (Hono)               │
 │  │     └── ファイルインデックス      │ ← バックリンク・全文検索
 │  │           ジャーナル管理          │
 │  └── ファイルシステム (.md ファイル群) │
 └───────────────────────────────────┘
    ▲
    │ HTTP
 ┌──────────────┐     ┌─────────────────────┐
 │ CLI (`loamium`) │ ◄── │ Skill (claude-skills形式) │
 └──────────────┘     └─────────────────────┘
    ▲
    │ 人間も直接利用可
```

### エージェント統合方式の決定理由

MCP サーバー方式も検討したが、**REST API + CLI + Skill** を採用：

- CLI が使えるので人間・エージェント両方から操作できる
- 特定エージェントに依存しない（Claude Code 以外でも動く）
- `curl` で直接叩けてデバッグが容易
- Skill を自分でチューニングできる

トレードオフ: 自然言語→CLI 変換の精度は MCP より落ちる。Skill 側でエラーハンドリングと変換例を丁寧に書いて補う。

---

## 3. 技術スタック

| 層 | 技術 | 備考 |
|----|------|------|
| フロントエンド | React + CodeMirror 6 | エディタは CodeMirror |
| バックエンド | Hono | 型安全・軽量。Node.js 上で動かす |
| CLI | Node.js（薄いラッパー） | API を叩くだけ。将来 Rust 単一バイナリも検討可 |
| 検索 | Fuse.js | ローカル全文検索 |
| グラフ | D3.js | MVP 後 |
| デスクトップ化 | Tauri（当面）/ Deno Desktop（将来候補）| 下記参照。将来対応 |
| Web 版ファイルアクセス | File System Access API | Chrome/Edge 限定（許容） |
| 外部公開 | Cloudflare Tunnel + Access | `cloudflared` + OAuth 認証 |

**Tauri 推奨理由**: Electron よりバンドルサイズが 1/10 以下、メモリも軽い。Web 版と React コードをほぼ共有できる。

### デスクトップ化の two-track 方針（当面 Tauri / Deno Desktop をウォッチ）

2026/6/25 リリースの Deno 2.9 で `deno desktop`（実験的機能）が登場した。Web プロジェクト（単一 TS〜Next.js/Astro/Vite 等）を単一バイナリのネイティブアプリにする。デフォルトは system webview でバイナリは小さい（macOS WebView 版で約 68MB、CEF 版で約 309MB）。Loamium のスタック（Hono + React + TS）と相性が良く、将来有力。

**当面は Tauri を採用する**。理由は、Deno Desktop が現時点で experimental であり、Loamium にとって致命的な欠落があるため:

- ファイルピッカー・クリップボードアクセスが未実装。Loamium はローカル `.md` を正本とするため、ファイルアクセスの弱さは本質的に困る。
- webview バインディングの統合が手動で、すぐ使える体験が Electron/Tauri より未成熟。
- macOS で閉じるボタンが効かない等のバグ報告あり。モバイル未対応。
- 成熟度は「Tauri の 2021 年時点」相当という評価。

**Deno Desktop の魅力（将来乗り換え検討に値する点）**: バックエンドが Rust ではなく TypeScript。Tauri で問題になる「node-pty が使えずサイドカーが必要」（下記 Claude Code タブ）が、Deno なら TypeScript のまま素直に解決しうる。Next.js 等の自動検出、バイナリ差分の自動更新も組み込み。

**判断**: file dialog と webview バインディングが安定版で固まったら再評価。それまでは Tauri、あるいはそもそもデスクトップ化を急がず Cloudflare Tunnel 構成のままブラウザで運用する。

---

## 4. データモデル / ファイル仕様

- ノートは `.md` ファイル。フォルダ構造は自由（Obsidian 流）。**正本は Markdown テキスト 1 本**（ブロック配列ではない）。
- デイリージャーナルは `YYYY-MM-DD.md` を自動生成。
- 見出し `#`、段落、リスト `- ` / `1. `、コードフェンスはすべて標準記法のまま保存。全行リスト化はしない（C 方式）。
- アウトライン操作（`Tab` / `Shift+Tab` / 折りたたみ）はリスト行に対してのみ作用。
- リンクは `[[WikiLink]]` 形式。
- タスクは `- [ ]` チェックボックス。LogSeq のクエリは「絞り込み検索」で代替。
- タグは Obsidian 流の `#tag` を想定（要確定）。
- frontmatter（YAML、`---` 区切り）をプロパティとして第一級で扱う。
- **ブロック ID は埋め込まない。** バックリンクはインメモリインデックスで解決。

---

## 5. REST API / CLI 仕様（ドラフト）

次のステップで確定させる。現時点のドラフト。エンドポイントと CLI コマンドは 1:1 対応させる方針。

### 読み取り系

| CLI | 機能 |
|-----|------|
| `loamium read <path>` | ノート取得 |
| `loamium search <query>` | 全文検索 |
| `loamium backlinks <path>` | バックリンク一覧 |
| `loamium journal [date]` | デイリージャーナル取得 |
| `loamium list [--tag <tag>] [--folder <folder>]` | ノート一覧・フィルタ |

### 書き込み系

| CLI | 機能 |
|-----|------|
| `loamium write <path> <content>` | 作成・上書き |
| `loamium append <path> <content>` | 末尾追記 |
| `loamium journal-append <content> [date]` | **今日のジャーナルに追記（最重要）** |
| `loamium patch <path> --old <str> --new <str>` | 部分書き換え |

### 構造系

| CLI | 機能 |
|-----|------|
| `loamium tags <path>` | タグ操作 |
| `loamium graph <path> [--depth 2]` | 関連ノード取得 |

**特に重要**: `journal-append` と `search`。Claude Code の作業ログ・決定事項を自動でジャーナルに書かせるユースケースが強力なため、この 2 つは Skill に自然言語→コマンド変換の例を丁寧に書く。

---

## 6. アプリ内 Claude Code タブ（将来機能）

UI のタブ内で TUI 版 Claude Code を動かし、ノート内容を踏まえた応答・整理をさせる。

```
React UI
└── Claude Code タブ
        │ WebSocket
        ▼
    バックエンド (Node.js)
        │ node-pty（pseudo terminal）
        ▼
    claude CLI プロセス
```

- フロントは **xterm.js** で TUI をレンダリング。
- ノートのコンテキストは `CLAUDE.md` や `--system` で事前注入。REST API の Skill を渡せば読み書きも可能。
- `stream-json` プロトコルより `pty` のほうがシンプルで確実。

### 制約・注意点

| 問題 | 深刻度 | 対処 |
|------|--------|------|
| Tauri 版は node-pty が使えない | 高 | サイドカーの Node.js プロセスで解決。※将来 Deno Desktop へ移行すれば TS のまま解決しうる |
| Cloudflare Tunnel 越しの WebSocket は遅延あり | 中 | 許容範囲 |
| claude CLI の認証がサーバー側に必要 | 中 | サーバー PC 側でログイン済みにする |
| xterm.js のモバイル操作性が悪い | 低 | 外出先はノート閲覧に割り切り |

---

## 7. 実装順序

1. **REST API（Hono）** — エンドポイント仕様の確定から。これを先に作ると、自分自身が Claude Code でノートを書きながら開発できる。
2. **CLI（`loamium`）** — API を叩くだけなので薄い。
3. **Skill** — CLI が動いてから書く。
4. **UI** — エディタ + ファイルツリー（CodeMirror）、`[[リンク]]` オートコンプリート、デイリージャーナル自動作成、バックリンクパネル。
5. **Cloudflare Tunnel + Access** — `cloudflared` 設定 + OAuth 認証。
6. **アプリ内 Claude Code タブ** — node-pty + xterm.js。
7. **デスクトップ化（Tauri）/ グラフビュー** — 最後。Deno Desktop の安定版が出ていれば、その時点で Tauri と再比較して選ぶ。

### MVP スコープ（UI 着手時）

1. ファイルツリー表示 + Markdown エディタ（CodeMirror）
2. `[[リンク]]` のオートコンプリート
3. デイリージャーナル自動作成
4. バックリンクパネル
5. Tauri 化

---

## 8. 拡張アーキテクチャ（レンダラー / 記法プラグイン）

draw.io・PlantUML・Mermaid・コードハイライト等を「個別機能」として足すと破綻する。**拡張可能なレンダリング機構**として一度だけ設計し、以降はその上に乗せる。

### 8.1 原則: ピュア Markdown を壊さない

すべての拡張は標準的な Markdown 記法（コードフェンス、インライン記法、callout 等）の上で表現する。Obsidian や素のエディタで開いても壊れたテキストにならないことが絶対条件。Loamium 固有の独自記法は導入しない。

### 8.2 3 つの拡張ポイント

```typescript
// 1. フェンスレンダラー: コードフェンスの言語識別子に対応
loamium.registerFenceRenderer({
  lang: string | string[],            // 'mermaid', ['drawio','xml-drawio'] 等
  kind: 'client' | 'server',          // クライアント描画 or REST API 経由
  mode: 'replace' | 'augment',        // コードを図に置換 or コードの下に描画を追加
  render(code, el, ctx): void | Promise<void>,
  edit?(code, ctx): Promise<string>,  // 専用エディタ（draw.io 等）。あればダブルクリックで起動
})

// 2. インライン記法: テキスト中のパターン → HTML
loamium.registerInlineRule({ pattern: RegExp, render(match, ctx) })
//   $math$, ==highlight==, [^footnote] 等

// 3. ブロック記法: 行頭パターン → ブロック変換
loamium.registerBlockRule({ match(line): boolean, render(lines, ctx) })
//   > [!note] callout, ![[embed]], frontmatter 等
```

この 3 種があれば Obsidian 互換記法はほぼすべて後付けできる。

### 8.3 client / server の 2 種別

| 種別 | 描画場所 | 例 |
|------|---------|-----|
| `client` | ブラウザ内で完結 | Mermaid、Shiki(ハイライト)、KaTeX、Chart.js、draw.io(iframe) |
| `server` | REST API 経由でレンダリング | PlantUML、Graphviz/dot、TikZ |

`server` 種別のため REST API に汎用エンドポイント `POST /render/:lang`（body: コード、返り: SVG/PNG）を 1 本生やす。これで将来 Graphviz でも LaTeX でも同じ仕組みで追加できる。

**PlantUML の注意**: Java ベースでクライアント完結しない。公式サーバーは社内ノートのプライバシー上不適。自宅 PC に `plantuml/plantuml-server`(Docker) を同梱し `/render/plantuml` から叩く。Cloudflare Tunnel 構成と自然に整合する。

### 8.4 対応候補一覧（すべて後付け可能）

| 識別子 / 記法 | 内容 | 種別 | 優先度 |
|--------------|------|------|--------|
| `mermaid` | 図全般 | client | 高 |
| 各言語コードフェンス | シンタックスハイライト（Shiki 推奨、CodeMirror と TextMate 文法を共有）| client | 高 |
| `$…$` / `$$…$$` | LaTeX 数式（KaTeX）| client(inline rule) | 高 |
| `dataview` | クエリ→動的リスト/表 | client(要クエリエンジン) | 高 |
| `plantuml` | UML | server | 中 |
| `graphviz` / `dot` | グラフ | server | 中 |
| `drawio` | 作図（XML 格納 or 別ファイル参照）| client(iframe) | 中 |
| `chart` | Chart.js グラフ | client | 中 |
| `> [!note]` callout | 注釈ボックス | block rule | 中 |
| `==highlight==` | ハイライト | inline rule | 中 |
| `![[embed]]` (transclusion) | ノート/画像埋め込み | block rule | 高 |
| frontmatter (YAML) | メタデータ/プロパティ | データモデル | 高 |
| `abc` / VexFlow | 楽譜 | client | 低 |
| `tikz` | 作図・数式 | server | 低 |

### 8.5 draw.io の保存形式

embed モード（embed.diagrams.net を iframe 埋め込み）は XML を返す。2 案:

- **A: `drawio` コードフェンスに XML を直接格納** — 単一ファイルで完結するが XML が巨大で Markdown 可読性を損なう。
- **B: 別ファイル参照 `![[diagram.drawio.svg]]`** — Obsidian の drawio プラグインと同方式。互換性が高く本文が汚れない。**こちらを推奨。**

### 8.6 ブロック参照を「生成しない」という設計判断

Obsidian の `[[note#^blockid]]` / LogSeq の `((uuid))` は **採用しない**（読み取り互換のみ）。理由:

1. **ファイルが汚れる**: `^a1b2c3` や `id:: uuid` が本文に散り、Git diff・grep・素のエディタで意味不明な文字列が混入。ピュア Markdown 原則（正本性）を直接破壊する。
2. **生成が編集と密結合**: リンクを張る操作が参照先ファイルへ ID を書き込む副作用を持つ。エージェントの `append` で ID 衝突や再採番が起きうる。
3. **行/ブロック/段落の不一致**: 複数行ブロックで ID をどこに付けるか曖昧。LogSeq は ID 前提で成立しており、ID を消すと参照が全断＝ファイルが自己完結しない。
4. **安定性の幻想**: 参照先が編集/削除されると dangling になり、内容が変わると参照元の意味が静かに変わる（通常リンクと違い文脈ごと引用するため気付きにくい）。
5. **ロックインの再来**: ツール固有セマンティクスで、解決できるツールでしか意味を持たない。Loamium が避けたかったもの。

**Loamium の立場**:

| 操作 | 方針 |
|------|------|
| 既存の `^blockid` / `((uuid))` を読む | 互換のため解決する |
| 自分から生成する | しない |
| 代替 | ノートリンク `[[note]]`、見出しリンク `[[note#heading]]`、埋め込み `![[note]]`、または粒度が要るならブロックを小ノートに切り出す（atomic note）|

### 8.7 実装順序への織り込み

- UI 着手時、エディタは **フェンス/インライン/ブロックの 3 レジストリ**を最初から持つ構造にする。
- **frontmatter はデータモデルの第一級市民**にする（後付けが最も高コスト。ファイル全体の扱いが変わるため）。
- リンク機構を作る段階で **`![[embed]]`（transclusion）**を想定に入れる（リンク解決と密結合）。
- 最初に実証するのは **Mermaid + KaTeX + Shiki**（すべて client で導入コスト低）。

---

## 9. 設計上の未決事項（実装着手前に判断すべきリスト）

後付けすると構造の作り直しになる順に並べる。特に【高】は最初のデータフロー設計に織り込む。

### 高：今すぐ決める（後付けが構造を壊す）

1. **同期と競合制御**。UI・CLI・Claude Code・別デバイスが同じ `.md` を同時に書き換える。Loamium が読んでいる最中にエージェントが追記したらどうなるか。方針候補: ファイル変更監視（chokidar 等）＋インメモリインデックスの再構築、last-write-wins か楽観ロックか。`journal-append` が競合の温床。検索・バックリンクの整合性に直結するため最初から組み込む。
2. **リンクのリネーム追従**。`[[Hydra]]` を多数貼った後にノート名を変更したらリンクが切れる。リネーム時に全 `[[旧名]]` を書き換えるか（Obsidian は自動）、やらないなら壊れたリンクの扱いを明確化（バックリンク赤表示は実装済み）。
3. **vault = Git リポジトリと最初から決める**。ピュア Markdown の最大利点。履歴・バックアップ・競合解決・差分がタダで手に入る。`.loamium/`（インデックスキャッシュ等）は `.gitignore`。
4. **ファイル監視 + インデックス再構築のタイミング**（1 と表裏）。起動時 / ファイル監視 / オンデマンドのどれを基本にするか。

### 中：方針だけ決めておく

5. **添付ファイルの置き場所**。`![[image.png]]`、PDF、draw.io の svg をどこに保存するか（`assets/` 配下かノート隣接か）。draw.io を別ファイル参照にすると決めたため、バイナリ資産の管理ルールが要る。
6. **エージェントの権限境界と監査ログ**。Claude Code が vault を削除・上書きできてしまう。医療系（LAMA / 慶和会）の機微情報がノートに入りうるため重要。CLI に「読み取り専用」「追記のみ」「削除禁止」の権限モードと、変更履歴のログ（Hydra で設計した audit logging の発想）を最初から。Cloudflare Access の認証とは別レイヤー。
7. **frontmatter のスキーマ方針**。Loamium が解釈するキー（`tags`, `aliases`, `created`, `status` 等）を緩く定義。将来の Dataview 的クエリの土台。
8. **文字コード・改行・正規化**。日本語前提なら UTF-8 固定、改行 LF 固定、`[[リンク]]` の全角/半角ゆれ、NFC/NFD 正規化（macOS のファイル名は NFD になる罠）。検索とリンク解決を静かに壊すため早めに固定。

### 低：認識だけしておく

9. **大規模時の性能**。全文検索の全ファイル走査は数千ノートで遅くなる。インデックス（SQLite FTS5 等）への移行余地を残す。
10. **モバイル編集体験**。外出先は閲覧中心と割り切り済みでよい。
11. **テスト戦略**。Markdown→プレビューのパーサーは壊れやすい。ここだけは早めにユニットテストを用意すると安心。

### 最優先の 3 つ

- vault = Git リポジトリと決める（バックアップ・履歴・競合を一気に解決）
- ファイル監視 + インデックス再構築をデータフローに最初から
- エージェントの権限境界と監査ログ（医療情報を扱う可能性があるため後付けは危険）

---

## 10. 次のアクション

**REST API のエンドポイント仕様を確定する。** 特に以下を詰める:

- 各エンドポイントのリクエスト/レスポンス JSON スキーマ
- パスの扱い（vault ルートからの相対パス）
- 検索のインデックス更新タイミング（起動時 / ファイル監視 / オンデマンド）
- タグの記法（`#tag` か frontmatter か）
- ジャーナルのテンプレート有無
- 認証（ローカルは無認証、Tunnel 経由は Cloudflare Access に委譲する想定で良いか）
- 拡張用 `POST /render/:lang` エンドポイント（server 種別レンダラー用。PlantUML/Graphviz 等）

---

## 付記: 命名について

`Loamium` は loam（肥沃な土壌）由来の造語。「知識が育つ場」というメタファーがジャーナル・アウトライン・エージェント統合のすべてにかかる。CLI・npm・crate 名はいずれも `loamium`。

命名の経緯: 当初案 `Loam` は Roam Research（同ジャンルの著名ツール）と1文字違いで、OSS 公開時にクローンと誤認されるリスクがあり不採用。土壌・鉱物・地質系の1語英名（Tilth, Geode, Accrete, Solum, Alluvia 等）は軒並み既存 OSS と衝突していたため、接尾辞つき造語 `Loamium` を採用した。

実在チェック結果（確認時点）:

- npm: 空き（404）
- crates.io: 空き（"does not exist"）
- GitHub user/org `loamium`・`tjst-t/loamium`: 空き（404）
- 残存リスク: 元素名的な接尾辞 `-ium` によりやや硬い響き。既知の名前衝突はなし。ドメイン（`loamium.dev` 等）は別途確認すること。