/**
 * エージェント機密領域 deny リスト用の軽量 glob マッチャ (ADR-0018)。
 *
 * `.loamium/agent-privacy.json` の deny パターン (vault 相対) をコンパイルし、
 * ノートの vault 相対パスが 1 つでもマッチすれば true を返すクロージャを生成する。
 *
 * 設計:
 * - 外部 glob ライブラリ (minimatch 等) は入れず自前実装。壊れやすいロジックのため
 *   privacy-glob.test.ts で網羅的にテストする (DESIGN_PRINCIPLES: glob マッチにユニットテスト)。
 * - 比較は NFC 正規化 + case-insensitive (macOS 由来の合成/分解ゆれ・大小差を吸収)。
 *   これはパス比較を NFC 正規化する既存方針 (path.ts / noteIndex) に揃える。
 * - 強制点はサーバー側の「エージェントに渡る直前の共通フィルタ」に集約されるが、
 *   glob → RegExp 変換ロジック自体はここ (shared) に一元化する。
 *
 * サポート構文 (vault 相対、"/" 区切り):
 *   - `**`  … 任意深さ (0 セグメント以上)。`private/**` は private 配下すべて。
 *   - `*`   … スラッシュ以外の任意 0 文字以上 (`*.md`, `dir/*.md`)。
 *   - `?`   … スラッシュ以外の任意 1 文字。
 *   - それ以外の文字はリテラル (正規表現メタ文字はエスケープ)。
 *
 * フォルダ指定:
 *   - `private/**` … private/ 配下のファイル/フォルダすべて (private ディレクトリ自身は含まない)。
 *   - `private`    … そのパス (private というノート) と、その配下すべて (private/ 以下) の両方。
 *                     フォルダ deny をパターン 1 つで直感的に書けるようにする。
 *   境界: `private` は `private2/...` にマッチしない (セグメント境界を厳守)。
 */

/** 正規表現メタ文字をエスケープする (glob の `*` `?` は事前に置換済み)。 */
function escapeRegexLiteral(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 単一 glob パターンを、フルパスにアンカーした RegExp ソース (先頭 `^`・末尾 `$` なし) へ変換する。
 * トークン単位で走査し、`**` / `*` / `?` を対応する正規表現片へ、その他はエスケープする。
 */
function globToRegexSource(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` = 任意深さ (スラッシュ含む任意 0 文字以上)
        out += '.*';
        i += 2;
        // `**/` は「0 セグメント以上」を素直に表すため直後の `/` を吸収する
        // (例: `a/**/b` が `a/b` にもマッチ)。`.*` が既にスラッシュを含みうるので
        // 直後スラッシュはオプショナル扱いにする。
        if (pattern[i] === '/') {
          out += '/?';
          i += 1;
        }
      } else {
        // `*` = スラッシュ以外の任意 0 文字以上
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      // `?` = スラッシュ以外の任意 1 文字
      out += '[^/]';
      i += 1;
    } else {
      out += escapeRegexLiteral(ch);
      i += 1;
    }
  }
  return out;
}

/**
 * deny パターン群を 1 つのマッチャ関数へコンパイルする。
 *
 * @param patterns vault 相対の glob パターン配列 (空 → 常に false)。
 * @returns relPath (vault 相対、"/" 区切り) を受け、いずれかにマッチすれば true。
 */
export function compilePrivacyMatcher(patterns: string[]): (relPath: string) => boolean {
  const regexes: RegExp[] = [];
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    // パターンも NFC 正規化し、先頭の `/` (絶対風表記) を落として vault 相対に揃える。
    const pattern = raw.normalize('NFC').replace(/^\/+/, '');
    if (pattern.length === 0) continue;

    const src = globToRegexSource(pattern);
    // 'i' フラグで大小吸収。'u' は付けない (合成/分解は事前 NFC 正規化で吸収済み)。
    // フルパスにアンカー。
    regexes.push(new RegExp(`^${src}$`, 'i'));

    // フォルダ deny の直感対応: 末尾が `**` や `*` を含まない「ディレクトリ的」パターン
    // (例: `private`, `a/b`) は、その配下 (`private/...`) も deny する。
    // `*`/`?`/`/` を含まない、または末尾が明示 glob でないパターンに対して配下マッチを追加する。
    // 判定は簡潔に: パターンが `*` を末尾に持たない場合、`<pattern>/**` 相当も足す。
    if (!pattern.endsWith('*')) {
      const childSrc = globToRegexSource(`${pattern}/`);
      regexes.push(new RegExp(`^${childSrc}.*$`, 'i'));
    }
  }

  if (regexes.length === 0) {
    return () => false;
  }

  return (relPath: string): boolean => {
    const p = relPath.normalize('NFC');
    for (const re of regexes) {
      if (re.test(p)) return true;
    }
    return false;
  };
}
