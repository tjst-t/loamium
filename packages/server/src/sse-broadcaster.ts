/**
 * SSE イベント配信ブロードキャスター (Sd5c9f4-3)。
 *
 * subscribe(writer) でクライアントを登録し、broadcast(data) で全クライアントへ
 * `data: JSON\n\n` 形式で送信する。書き込みエラー (クライアント切断等) は
 * catch → Map から除去 → stderr に記録する (例外は再スローしない)。
 *
 * テスト可能性: StreamWriter インターフェースを経由するためモック注入が容易。
 *
 * SSE は UI 受動購読インフラであり、エージェントが操作する対象ではないため
 * エージェントツールは追加しない (ADR-0014 判断)。
 */

/** Hono streaming の StreamWriter 互換インターフェース (テスト用モック可)。 */
export interface StreamWriter {
  write(data: string): Promise<void>;
}

export class SSEBroadcaster {
  private readonly clients = new Map<number, StreamWriter>();
  private nextId = 0;

  /**
   * クライアントを購読登録する。
   * 戻り値の関数を呼ぶことで購読を解除できる (クリーンアップ用)。
   */
  subscribe(writer: StreamWriter): () => void {
    const id = this.nextId++;
    this.clients.set(id, writer);
    return () => {
      this.clients.delete(id);
    };
  }

  /**
   * 全クライアントにイベントを配信する。
   * 書き込みに失敗したクライアントは Map から除去する。
   */
  async broadcast(data: unknown): Promise<void> {
    const payload = `data: ${JSON.stringify(data)}\n\n`;
    const toRemove: number[] = [];
    const writes: Promise<void>[] = [];
    for (const [id, writer] of this.clients) {
      writes.push(
        writer.write(payload).catch((err: unknown) => {
          console.error(`[loamium] SSE write error (client ${String(id)}):`, err);
          toRemove.push(id);
        }),
      );
    }
    await Promise.all(writes);
    for (const id of toRemove) {
      this.clients.delete(id);
    }
  }

  /** 現在の購読者数 (テスト用)。 */
  get clientCount(): number {
    return this.clients.size;
  }
}
