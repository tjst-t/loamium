/**
 * [[WikiLink]] ターゲット → vault 相対パス解決。
 *
 * 解決規則 (Obsidian 準拠、DESIGN_PRINCIPLES priority 4 / decisions.json 参照):
 * 1. ターゲットは NFC 正規化して比較 (NFD 入力・macOS ファイル名ゆれを吸収)
 * 2. `.md` 拡張子は省略可
 * 3. 大文字小文字は不区別
 * 4. `/` を含むターゲットは vault ルートからのパス一致
 * 5. ファイル名のみのターゲットは全フォルダ横断で basename 一致
 * 6. 複数候補は「パスのセグメント数が少ない順 → パス昇順」で決定的に選ぶ
 */

/** 比較用キー: NFC + 小文字 */
function comparableKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/**
 * リンクターゲットを vault 内のノートパスに解決する。
 *
 * @param target [[...]] の中身からheading/alias を除いた部分 (extractLinks の WikiLink.target)
 * @param vaultPaths vault 内の全ノートの相対パス (`a/b.md` 形式)
 * @returns 解決された相対パス。見つからなければ null (壊れたリンク)
 */
export function resolveLinkTarget(target: string, vaultPaths: Iterable<string>): string | null {
  let t = target.normalize('NFC').trim();
  if (t.length === 0) return null;
  // 先頭 "/" は vault ルート基準の明示 (Obsidian 互換)
  t = t.replace(/^\/+/, '');
  if (t.length === 0) return null;
  if (!t.toLowerCase().endsWith('.md')) t += '.md';
  const key = comparableKey(t);

  if (t.includes('/')) {
    // パス指定: vault ルートからの一致のみ
    for (const p of vaultPaths) {
      if (comparableKey(p) === key) return p;
    }
    return null;
  }

  // ファイル名のみ: 全フォルダ横断で basename 一致
  const candidates: string[] = [];
  for (const p of vaultPaths) {
    const base = p.split('/').pop() ?? p;
    if (comparableKey(base) === key) candidates.push(p);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const da = a.split('/').length;
    const db = b.split('/').length;
    if (da !== db) return da - db;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return candidates[0] ?? null;
}

/**
 * notePath を指す [[リンク]] に書くべき最短ターゲット表記 (拡張子なし) を返す。
 *
 * Obsidian の「可能なら最短パス」慣行に合わせる:
 * - basename が vault 内で notePath に一意解決するなら basename (例: "メモ")
 * - 同名衝突で解決が別ノートへ向かうならフルパス (例: "projects/メモ")
 *
 * リネーム追従の書き換え先とオートコンプリートの挿入テキストの両方で使い、
 * 書いたリンクが必ず notePath に解決することを保証する。
 *
 * @param notePath リンク先ノートの vault 相対パス (`a/b.md`)
 * @param vaultPaths リンクが解決される時点の全ノートパス (notePath を含むこと)
 */
export function preferredLinkTarget(notePath: string, vaultPaths: Iterable<string>): string {
  const path = notePath.normalize('NFC');
  const base = path.split('/').pop() ?? path;
  const baseNoExt = base.replace(/\.md$/i, '');
  if (resolveLinkTarget(baseNoExt, vaultPaths) === path) return baseNoExt;
  return path.replace(/\.md$/i, '');
}
