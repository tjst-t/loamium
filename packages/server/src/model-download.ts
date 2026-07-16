/**
 * 内蔵 LLM モデルのダウンロードジョブ管理 (S8a3f2e-3 / AC-S8a3f2e-3-2)。
 *
 * POST /api/llm/models/download はジョブを受理して id を返し、実 DL は
 * バックグラウンドで進める。進捗は GET /api/llm/models/download/:id/status の
 * ポーリングで取得する (SSE ではなくポーリング方式を採用 — pi/UI 双方で扱いやすく、
 * 単一ユーザーローカルでは十分)。
 *
 * ## 封じ込め (DESIGN_PRINCIPLES priority 2)
 * 保存先は必ず `.loamium/models/llm/<filename>` に収める。filename は
 * `resolveModelFilePath` (model-paths.ts) が英数・._- のみ許可し、パス区切り /
 * `..` / サブフォルダ脱出を FS に触れる前に弾く。ここでは検証済み絶対パスにのみ
 * 書き込む。
 *
 * ## テスト可能性 (環境制約: 実 DL は行わない)
 * fetch はコンストラクタ注入 (`FetchFn`)。テストは fetch をスタブして
 * 「封じ込め・進捗報告・完了/失敗・監査記録」ロジックを検証し、実 URL へは
 * 発信しない (GB 級モデルの実取得は環境上できない)。
 */
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { LocalModelDownloadStatus } from '@loamium/shared';
import {
  ensureModelKindDir,
  resolveModelFilePath,
  InvalidModelFilenameError,
} from './model-paths.js';

/** 注入可能な fetch (テストでスタブする)。 */
export type FetchFn = (url: string) => Promise<Response>;

/** ダウンロードジョブの内部状態。 */
export interface DownloadJob {
  id: string;
  filename: string;
  status: LocalModelDownloadStatus;
  receivedBytes: number;
  totalBytes: number | null;
  error?: string;
  /** バックグラウンド DL の完了 Promise (テストが待てる)。 */
  done: Promise<void>;
}

/** URL のパス末尾からファイル名候補を導出する (拡張子含む)。 */
export function deriveFilenameFromUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return '';
  }
  const last = pathname.split('/').filter((s) => s.length > 0).pop() ?? '';
  return decodeURIComponent(last);
}

/**
 * ダウンロードジョブを管理するマネージャ。
 * プロセス内 (単一ユーザーローカル) の in-memory ストア。
 */
export class ModelDownloadManager {
  private readonly vaultRoot: string;
  private readonly fetchFn: FetchFn;
  private readonly jobs = new Map<string, DownloadJob>();

  constructor(vaultRoot: string, fetchFn: FetchFn = globalThis.fetch) {
    this.vaultRoot = vaultRoot;
    this.fetchFn = fetchFn;
  }

  /** id からジョブを取得する (無ければ undefined)。 */
  getJob(id: string): DownloadJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * ダウンロードを開始する。filename は指定が無ければ URL 末尾から導出する。
   * ファイル名は必ず `resolveModelFilePath` を通し、封じ込めを FS 前に検証する。
   * 検証に落ちたら `InvalidModelFilenameError` を同期的に投げる (呼び出し元が 400)。
   *
   * 成功時はジョブを登録し即座に返す (実 DL は非同期)。進捗は getJob で追える。
   */
  start(url: string, filename?: string): DownloadJob {
    const rawName = filename ?? deriveFilenameFromUrl(url);
    // 封じ込め検証を FS に触れる前に実施する。不正なら投げる (呼び出し元 400)。
    // resolveModelFilePath が英数・._- 以外/パス区切り/.. を弾く。
    const dest = resolveModelFilePath(this.vaultRoot, 'llm', rawName);

    const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const job: DownloadJob = {
      id,
      filename: rawName,
      status: 'pending',
      receivedBytes: 0,
      totalBytes: null,
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);

    job.done = this.run(job, url, dest);
    return job;
  }

  /** 実 DL 本体。fetch → ストリームをファイルへ書き出し、進捗を更新する。 */
  private async run(job: DownloadJob, url: string, dest: string): Promise<void> {
    job.status = 'downloading';
    try {
      await ensureModelKindDir(this.vaultRoot, 'llm');

      const res = await this.fetchFn(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const lenHeader = res.headers.get('content-length');
      job.totalBytes = lenHeader !== null ? Number(lenHeader) : null;
      if (job.totalBytes !== null && !Number.isFinite(job.totalBytes)) {
        job.totalBytes = null;
      }

      if (res.body === null) {
        throw new Error('response has no body');
      }

      // Web ReadableStream → Node Readable。各チャンクで受信バイトを計上する。
      const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
      nodeStream.on('data', (chunk: Buffer | string) => {
        job.receivedBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      });

      const tmp = `${dest}.partial`;
      await pipeline(nodeStream, createWriteStream(tmp));
      // 完了後にアトミックにリネーム (途中失敗した .partial を本物と混同しない)。
      await fs.rename(tmp, dest);

      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      // 失敗した部分ファイルは残さない (封じ込め領域内のみ削除)。
      await fs.rm(`${dest}.partial`, { force: true }).catch(() => undefined);
    }
  }
}

export { InvalidModelFilenameError };

/** dest ディレクトリ path (テスト等が使う)。 */
export function modelsLlmDir(vaultRoot: string): string {
  return path.join(vaultRoot, '.loamium', 'models', 'llm');
}
