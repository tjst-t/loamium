/**
 * Story Sb7f458-1「pty ブリッジ (WebSocket + node-pty)」受け入れテスト。
 * scenario-Sb7f458-1.json を機械的に実行する。
 *
 * test-discipline Rule 2 (api): 実サーバーをサブプロセスとして起動し、
 * 実 WS クライアント (ws) / 実 HTTP クライアント (fetch) で叩く。
 * 実対話は LOAMIUM_TERMINAL_CMD=/bin/bash の実シェルで検証する
 * (claude CLI 本体はログイン前提の外部依存のため AC 外 — README 参照)。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { cleanupVault, makeTempVault, startServer, type TestServer } from './helpers/server.js';

const BASH = '/bin/bash';

interface AuditLine {
  ts: string;
  op: string;
  path: string;
  mode: string;
  result: string;
  status: number;
}

async function readAuditLog(vault: string): Promise<AuditLine[]> {
  const raw = await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AuditLine);
}

function wsUrl(server: TestServer): string {
  return `${server.baseUrl.replace('http://', 'ws://')}/api/terminal`;
}

/** WS 接続を試み、確立するか (open) 拒否されるか (HTTP status) を観測する。 */
function tryConnect(
  url: string,
): Promise<{ opened: boolean; status?: number | undefined; ws?: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('WS connection attempt did not settle within 10s'));
    }, 10_000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve({ opened: true, ws });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      ws.terminate();
      resolve({ opened: false, status: res.statusCode });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 指定 Origin で接続し、結果を観測する。
 * cross-origin は即座に close(1008) される。same-origin はセッションが張られたまま
 * になるので、close が来なければ「開いたまま」として settle する。
 */
function connectWithOrigin(
  url: string,
  origin: string,
): Promise<{ closeCode: number | null; gotOutput: boolean; stayedOpen: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin } });
    let gotOutput = false;
    let opened = false;
    // 接続確立後この時間 close が来なければ「開いたまま」と判定する
    const openHold = setTimeout(() => {
      if (opened) {
        ws.close();
        resolve({ closeCode: null, gotOutput, stayedOpen: true });
      }
    }, 1500);
    const hardTimer = setTimeout(() => {
      ws.terminate();
      reject(new Error('connection did not settle within 10s'));
    }, 10_000);
    ws.on('open', () => {
      opened = true;
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as { type: string };
      if (msg.type === 'output') gotOutput = true;
    });
    ws.on('close', (code) => {
      clearTimeout(openHold);
      clearTimeout(hardTimer);
      resolve({ closeCode: code, gotOutput, stayedOpen: false });
    });
    ws.on('unexpected-response', (_req, res) => {
      clearTimeout(openHold);
      clearTimeout(hardTimer);
      ws.terminate();
      resolve({ closeCode: res.statusCode ?? 0, gotOutput: false, stayedOpen: false });
    });
    ws.on('error', (err) => {
      clearTimeout(openHold);
      clearTimeout(hardTimer);
      reject(err);
    });
  });
}

/** 接続済み WS のターミナルセッション操作ヘルパー。 */
class TerminalSession {
  private output = '';
  private exitCode: number | null = null;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as
        | { type: 'output'; data: string }
        | { type: 'exit'; exitCode: number };
      if (msg.type === 'output') this.output += msg.data;
      else this.exitCode = msg.exitCode;
    });
  }

  static async connect(server: TestServer): Promise<TerminalSession> {
    const res = await tryConnect(wsUrl(server));
    if (!res.opened || res.ws === undefined) {
      throw new Error(`WS connection rejected (status=${String(res.status)})`);
    }
    return new TerminalSession(res.ws);
  }

  type(data: string): void {
    this.ws.send(JSON.stringify({ type: 'input', data }));
  }

  resize(cols: number, rows: number): void {
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  /** 出力に re がマッチするまで待つ (実シェルの応答待ち)。 */
  async waitForOutput(re: RegExp, timeoutMs = 10_000): Promise<RegExpExecArray> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = re.exec(this.output);
      if (m !== null) return m;
      if (Date.now() > deadline) {
        throw new Error(`output did not match ${String(re)} within ${String(timeoutMs)}ms.\noutput: ${this.output}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async waitForExit(timeoutMs = 10_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.exitCode === null) {
      if (Date.now() > deadline) throw new Error('exit message did not arrive');
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.exitCode;
  }

  close(): void {
    this.ws.close();
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !processAlive(pid);
}

// ---------------------------------------------------------------------------
// AC-Sb7f458-1-1: 三重ガード — LOAMIUM_TERMINAL=1 かつ full のときだけ有効
// ---------------------------------------------------------------------------

describe('[AC-Sb7f458-1-1] terminal is opt-in: LOAMIUM_TERMINAL=1 + LOAMIUM_MODE=full only', () => {
  it('rejects WS connection when LOAMIUM_TERMINAL is not set (default disabled)', async () => {
    const vault = await makeTempVault();
    const server = await startServer({ vault, mode: 'full' });
    try {
      const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
        terminal: { enabled: boolean; reason: string | null };
      };
      expect(health.terminal).toEqual({ enabled: false, reason: 'terminal_env_not_set' });

      const res = await tryConnect(wsUrl(server));
      expect(res.opened).toBe(false);
      expect(res.status).toBe(403);

      // 非 WS の GET も 403 + 有効化手順つきメッセージ
      const get = await fetch(`${server.baseUrl}/api/terminal`);
      expect(get.status).toBe(403);
      const body = (await get.json()) as { error: string; message: string };
      expect(body.error).toBe('forbidden');
      expect(body.message).toContain('LOAMIUM_TERMINAL=1');
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('rejects WS connection in read-only mode even with LOAMIUM_TERMINAL=1', async () => {
    const vault = await makeTempVault();
    const server = await startServer({
      vault,
      mode: 'read-only',
      env: { LOAMIUM_TERMINAL: '1', LOAMIUM_TERMINAL_CMD: BASH },
    });
    try {
      const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
        terminal: { enabled: boolean; reason: string | null };
      };
      expect(health.terminal).toEqual({ enabled: false, reason: 'mode_not_full' });

      const res = await tryConnect(wsUrl(server));
      expect(res.opened).toBe(false);
      expect(res.status).toBe(403);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('rejects WS connection in append-only mode even with LOAMIUM_TERMINAL=1', async () => {
    const vault = await makeTempVault();
    const server = await startServer({
      vault,
      mode: 'append-only',
      env: { LOAMIUM_TERMINAL: '1', LOAMIUM_TERMINAL_CMD: BASH },
    });
    try {
      const res = await tryConnect(wsUrl(server));
      expect(res.opened).toBe(false);
      expect(res.status).toBe(403);
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('accepts WS connection with LOAMIUM_TERMINAL=1 + mode=full and reports it via health', async () => {
    const vault = await makeTempVault();
    const server = await startServer({
      vault,
      mode: 'full',
      env: { LOAMIUM_TERMINAL: '1', LOAMIUM_TERMINAL_CMD: BASH },
    });
    try {
      const health = (await (await fetch(`${server.baseUrl}/api/health`)).json()) as {
        terminal: { enabled: boolean; reason: string | null; cmd?: string };
      };
      expect(health.terminal).toEqual({ enabled: true, reason: null, cmd: BASH });

      const res = await tryConnect(wsUrl(server));
      expect(res.opened).toBe(true);
      res.ws?.close();
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });

  it('rejects a cross-origin browser connection (CSWSH) without spawning a pty', async () => {
    const vault = await makeTempVault();
    const server = await startServer({
      vault,
      mode: 'full',
      env: { LOAMIUM_TERMINAL: '1', LOAMIUM_TERMINAL_CMD: BASH },
    });
    try {
      // 別サイト (Origin が Host と異なる) からの接続は pty を起動せず即座に閉じる
      const foreign = await connectWithOrigin(wsUrl(server), 'http://evil.example');
      expect(foreign.closeCode).toBe(1008);
      expect(foreign.gotOutput).toBe(false);
      expect(foreign.stayedOpen).toBe(false);

      // same-origin (Origin host == server host) は許可され、セッションが張られる
      const same = await connectWithOrigin(wsUrl(server), server.baseUrl);
      expect(same.stayedOpen).toBe(true);
      expect(same.closeCode).not.toBe(1008);

      // cross-origin 拒否は監査ログに denied として残る
      const entries = await readAuditLog(vault);
      const denied = entries.find(
        (e) => e.op === 'terminal.connect' && e.result === 'denied' && e.status === 403,
      );
      expect(denied).toBeDefined();
    } finally {
      await server.stop();
      await cleanupVault(vault);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-Sb7f458-1-2: 実シェルとの双方向対話・リサイズ・切断時の子プロセス終了
// ---------------------------------------------------------------------------

describe('[AC-Sb7f458-1-2] pty session: real-shell interaction, resize, child cleanup, audit', () => {
  let vault: string;
  let server: TestServer;

  beforeAll(async () => {
    vault = await makeTempVault();
    server = await startServer({
      vault,
      mode: 'full',
      env: { LOAMIUM_TERMINAL: '1', LOAMIUM_TERMINAL_CMD: BASH },
    });
  });

  afterAll(async () => {
    await server.stop();
    await cleanupVault(vault);
  });

  it('spawns a real shell with the vault as cwd and streams I/O both ways', async () => {
    const session = await TerminalSession.connect(server);
    try {
      // 実対話: 計算入りの echo で「入力がシェルに届き、評価結果が返る」ことを確認
      session.type('echo terminal-ok-$((6*7))\r');
      await session.waitForOutput(/terminal-ok-42/);

      // cwd = vault (realpath 差 /tmp vs /private/tmp を吸収するため pwd -P を実 fs と比較)
      session.type('pwd\r');
      await session.waitForOutput(new RegExp(vault.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
      session.close();
    }
  });

  it('propagates resize messages to the pty (stty size reflects cols/rows)', async () => {
    const session = await TerminalSession.connect(server);
    try {
      session.resize(120, 40);
      session.type('stty size\r');
      await session.waitForOutput(/40 120/);

      session.resize(80, 24);
      session.type('stty size\r');
      await session.waitForOutput(/24 80/);
    } finally {
      session.close();
    }
  });

  it('terminates the child process when the client disconnects (SIGTERM→SIGKILL)', async () => {
    const session = await TerminalSession.connect(server);
    session.type('echo pid-marker-$$\r');
    const m = await session.waitForOutput(/pid-marker-(\d+)/);
    const shellPid = Number(m[1]);
    expect(processAlive(shellPid)).toBe(true);

    // クライアント切断 → SIGTERM (対話 bash は無視) → 3 秒で SIGKILL エスカレーション
    session.close();
    expect(await waitForProcessGone(shellPid, 8_000)).toBe(true);
  });

  it('notifies the client and closes the WS when the shell exits by itself', async () => {
    const session = await TerminalSession.connect(server);
    session.type('exit 7\r');
    const code = await session.waitForExit();
    expect(code).toBe(7);
  });

  it('records session start/end in audit.log without recording command content', async () => {
    const marker = 'audit-secret-marker';
    const session = await TerminalSession.connect(server);
    session.type(`echo ${marker}\r`);
    await session.waitForOutput(new RegExp(`${marker}`));
    session.close();

    // session_end は SIGTERM→SIGKILL 後に記録されるため待つ
    const deadline = Date.now() + 10_000;
    let entries: AuditLine[] = [];
    for (;;) {
      entries = await readAuditLog(vault);
      const starts = entries.filter((e) => e.op === 'terminal.session_start').length;
      const ends = entries.filter((e) => e.op === 'terminal.session_end').length;
      if (starts > 0 && starts === ends) break;
      if (Date.now() > deadline) {
        throw new Error(
          `audit start/end mismatch: starts=${String(starts)} ends=${String(ends)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    const start = entries.find((e) => e.op === 'terminal.session_start');
    expect(start).toBeDefined();
    expect(start?.path).toBe('/api/terminal');
    expect(start?.mode).toBe('full');
    expect(start?.result).toBe('ok');

    // コマンド内容 (入力文字列) は監査ログに残らない
    const rawLog = await readFile(path.join(vault, '.loamium', 'audit.log'), 'utf8');
    expect(rawLog).not.toContain(marker);
    expect(rawLog).not.toContain('echo');
  });

  it('rejected attempts on a disabled server are audited as denied', async () => {
    const v2 = await makeTempVault();
    const disabled = await startServer({ vault: v2, mode: 'full' });
    try {
      await tryConnect(wsUrl(disabled));
      const entries = await readAuditLog(v2);
      const denied = entries.find((e) => e.op === 'terminal.connect');
      expect(denied).toBeDefined();
      expect(denied?.result).toBe('denied');
      expect(denied?.status).toBe(403);
    } finally {
      await disabled.stop();
      await cleanupVault(v2);
    }
  });
});
