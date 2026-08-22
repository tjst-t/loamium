/**
 * サービス層のドメインエラー。HTTP への写像は `plugins/http.ts` の onError が一箇所で行う。
 * ルートハンドラで status を組み立てないこと (REST と CLI で挙動が食い違う原因になる)。
 */
export class VaultConflictError extends Error {
  override readonly name = 'VaultConflictError'
}

export class VaultNotFoundError extends Error {
  override readonly name = 'VaultNotFoundError'
}
