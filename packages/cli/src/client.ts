/**
 * REST API への薄い HTTP クライアント。
 *
 * - 失敗はすべて CliError に正規化する。error コードはサーバーの機械可読コード
 *   (not_found / permission_denied / old_not_found / invalid_path 等) をそのまま透過し、
 *   接続不能は server_unreachable とする (AC-S0c9a48-1-2)。
 * - 成功時は「生のレスポンステキスト」も保持する (--json は API レスポンスを 1:1 でそのまま出す)。
 */
import { errorResponseSchema, normalizeVaultPath, VaultPathError } from '@loamium/shared';

/** CLI の失敗を表すエラー。stderr への 1 行 JSON と終了コードに変換される。 */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export interface ApiResult {
  /** レスポンスボディの生テキスト (--json 出力用) */
  raw: string;
  /** JSON.parse 済みボディ (人間可読フォーマット用) */
  data: unknown;
}

export async function apiFetch(baseUrl: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const url = `${baseUrl}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new CliError(
      'server_unreachable',
      `could not reach loamium server at ${baseUrl} — is it running? (start it with \`make serve\` or set LOAMIUM_URL)`,
    );
  }
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    // JSON でないボディ (プロキシのエラーページ等) は null のまま扱う
  }
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(data);
    if (parsed.success) {
      throw new CliError(parsed.data.error, parsed.data.message);
    }
    throw new CliError('http_error', `HTTP ${res.status} from ${url}: ${raw.slice(0, 200)}`);
  }
  return { raw, data };
}

/**
 * ユーザー入力のパスを vault 相対に正規化してエンドポイント用に percent-encode する。
 * CLAUDE.md: vault 内パスは必ず shared のパス正規化 (`..` 脱出検証込み) を経由する。
 * サーバー側でも再度正規化されるが、CLI で先に検証することで `..` などの不正パスが
 * URL 正規化に食われて曖昧な http_error になるのを防ぎ、機械可読な invalid_path を返す。
 */
export function encodeNotePath(raw: string): string {
  return toVaultPath(raw)
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/** ユーザー入力パスを vault 相対に正規化する (不正パスは invalid_path の CliError)。 */
export function toVaultPath(raw: string): string {
  try {
    return normalizeVaultPath(raw);
  } catch (err) {
    if (err instanceof VaultPathError) {
      throw new CliError('invalid_path', err.message);
    }
    throw err;
  }
}

export function postJson(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export function putJson(body: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}
