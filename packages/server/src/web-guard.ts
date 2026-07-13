/**
 * Web アクセスの SSRF ガード (ADR-0017 / S5e0206)。
 *
 * web_fetch が取得してよい URL を純関数で判定する。DNS 解決はしない (単純化) —
 * ホスト名が数値 IP のときだけ IP レンジ判定を行い、それ以外の名前解決に依存する
 * リバインド攻撃等は本 sprint のスコープ外 (allowPrivate=false の本番既定で
 * localhost / プライベート / ループバック / リンクローカルの直書きを拒否する)。
 *
 * 許可: http: / https: のみ。
 * 拒否: 他スキーム、ホスト `localhost`、IPv4 ループバック (127.0.0.0/8)、
 *       プライベート (10/8, 172.16/12, 192.168/16)、リンクローカル (169.254/16)、
 *       `0.0.0.0`、IPv6 `::1` / ULA (fc00::/7) / リンクローカル (fe80::/10)。
 */

export type PublicUrlResult = { ok: true; url: URL } | { ok: false; reason: string };

/** IPv4 ドット表記か判定し、4 オクテットの数値配列へ分解する (0-255 の範囲外は null)。 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** IPv4 がループバック / プライベート / リンクローカル / 0.0.0.0 なら true。 */
function isPrivateIpv4(octets: number[]): boolean {
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 0) return true; // 0.0.0.0/8 (0.0.0.0 含む)
  if (a === 127) return true; // 127.0.0.0/8 ループバック
  if (a === 10) return true; // 10.0.0.0/8 プライベート
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 リンクローカル
  return false;
}

/**
 * URL のホストが数値 IPv6 か判定して非公開 (ループバック / ULA / リンクローカル) なら true。
 * URL.hostname は IPv6 を角括弧付きで返す (例 "[::1]", "[fe80::1]")。
 */
function isPrivateIpv6(hostname: string): boolean {
  // 角括弧を外す。ゾーン ID (%...) は除去。
  const unbracketed = hostname.replace(/^\[/, '').replace(/\]$/, '');
  // ':' が含まれる = IPv6 リテラル。
  if (!unbracketed.includes(':')) return false;
  const h = (unbracketed.split('%')[0] ?? unbracketed).toLowerCase();
  if (h === '::1' || h === '::') return true; // ループバック / 未指定
  // fc00::/7 (ULA) = 先頭バイト 0xfc / 0xfd。
  if (/^f[cd]/.test(h)) return true;
  // fe80::/10 リンクローカル (fe80..febf)。
  if (/^fe[89ab]/.test(h)) return true;
  // IPv4-mapped (::ffff:127.0.0.1 等) は保守的に、埋め込み IPv4 を再判定。
  const mapped = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (mapped && mapped[1]) {
    const octets = parseIpv4(mapped[1]);
    if (octets && isPrivateIpv4(octets)) return true;
  }
  return false;
}

/**
 * 生 URL 文字列が「取得してよい公開 HTTP(S) URL」かを判定する純関数。
 *
 * - スキームは http: / https: のみ許可 (大文字小文字は URL が正規化する)。
 * - ホストが `localhost` (末尾 `.localhost` 含む) は文字列で拒否。
 * - ホストが数値 IP のときはループバック / プライベート / リンクローカルを拒否。
 * - 名前解決はしない (DNS を引かない) — ホスト名が数値でない限り IP 判定は行わない。
 */
export function isPublicHttpUrl(rawUrl: string): PublicUrlResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `URL の形式が不正です: ${rawUrl}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `許可されていないスキームです (http/https のみ): ${url.protocol}` };
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === '') {
    return { ok: false, reason: 'ホストが空です' };
  }

  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: `localhost へのアクセスは許可されていません: ${hostname}` };
  }

  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== null) {
    if (isPrivateIpv4(ipv4)) {
      return { ok: false, reason: `プライベート/ループバック IP へのアクセスは許可されていません: ${hostname}` };
    }
    return { ok: true, url };
  }

  if (isPrivateIpv6(hostname)) {
    return { ok: false, reason: `プライベート/ループバック IPv6 へのアクセスは許可されていません: ${hostname}` };
  }

  return { ok: true, url };
}
