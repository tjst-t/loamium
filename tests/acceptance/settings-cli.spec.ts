/**
 * 設定 CLI サブコマンド受け入れテスト (Sa10026-5)
 *
 * [AC-Sa10026-5-3] loamium settings 系サブコマンドが REST と 1:1 対応する
 *
 * テスト設計:
 *   - 実サーバー + 実 CLI (サブプロセス実行)
 *   - shared の zod スキーマと同じ型を CLI も使っていることを確認
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  cleanupVault,
  makeTempVault,
  startServer,
  type TestServer,
} from './helpers/server.js';
import { runCli, cliBin } from './helpers/cli.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _cliBin = cliBin; // import を使うだけ (使用確認)

async function seedAgentJson(vault: string, content: Record<string, unknown>): Promise<void> {
  const dir = path.join(vault, '.loamium');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'agent.json'), JSON.stringify(content), 'utf8');
}

let server: TestServer;
let vault: string;

afterEach(async () => {
  await server.stop();
  await cleanupVault(vault);
});

// ==========================================================================
// [AC-Sa10026-5-3] settings system サブコマンド
// ==========================================================================

describe('[AC-Sa10026-5-3] loamium settings system', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('settings system outputs JSON (GET /api/settings/system)', async () => {
    const res = await runCli(['settings', 'system', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { settings: Record<string, unknown> };
    // 統合後: 不在時は appSettingsSchema の既定値を返す (system-definitions.ts / Sa10026-3)
    expect(body.settings).toEqual({
      theme: 'system',
      defaultFolder: '',
      journalTemplate: 'system/templates/journal.md',
      showSystemFolder: false,
    });
  });

  it('settings system-set saves and settings system reads back', async () => {
    const set = await runCli(['settings', 'system-set', '{"theme":"dark"}', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(set.code).toBe(0);

    const get = await runCli(['settings', 'system', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(get.code).toBe(0);
    const body = JSON.parse(get.stdout) as { settings: { theme: string } };
    expect(body.settings.theme).toBe('dark');
  });
});

// ==========================================================================
// [AC-Sa10026-5-3] settings agent-connection サブコマンド
// ==========================================================================

describe('[AC-Sa10026-5-3] loamium settings agent-connection', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('agent-connection returns "not configured" when agent.json absent', async () => {
    const res = await runCli(['settings', 'agent-connection'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('not configured');
  });

  it('agent-connection --json returns null connection', async () => {
    const res = await runCli(['settings', 'agent-connection', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { connection: null };
    expect(body.connection).toBeNull();
  });

  it('agent-connection-set saves and agent-connection reads back', async () => {
    const set = await runCli([
      'settings', 'agent-connection-set',
      '--api', 'openai',
      '--base-url', 'http://test/v1',
      '--model', 'gpt-test',
      '--api-key', '$TEST_KEY',
    ], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(set.code).toBe(0);

    const get = await runCli(['settings', 'agent-connection', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(get.code).toBe(0);
    const body = JSON.parse(get.stdout) as {
      connection: { api: string; baseUrl: string; model: string; apiKeyRef: string };
    };
    expect(body.connection.api).toBe('openai');
    expect(body.connection.baseUrl).toBe('http://test/v1');
    expect(body.connection.model).toBe('gpt-test');
    expect(body.connection.apiKeyRef).toBe('$TEST_KEY');
  });
});

// ==========================================================================
// [AC-Sa10026-5-3] settings agent-permissions サブコマンド
// ==========================================================================

describe('[AC-Sa10026-5-3] loamium settings agent-permissions', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
    await seedAgentJson(vault, {
      api: 'openai',
      baseUrl: 'http://x/v1',
      model: 'x',
      apiKey: '$X',
    });
  });

  it('agent-permissions-set notes-rw and agent-permissions reads back', async () => {
    const set = await runCli(
      ['settings', 'agent-permissions-set', 'notes-rw'],
      { env: { LOAMIUM_URL: server.baseUrl } },
    );
    expect(set.code).toBe(0);

    const get = await runCli(['settings', 'agent-permissions', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(get.code).toBe(0);
    const body = JSON.parse(get.stdout) as {
      permissions: { value: unknown; effective: string[] };
    };
    expect(body.permissions.value).toBe('notes-rw');
    expect(body.permissions.effective).toContain('journal_append');
  });

  it('agent-permissions-set with comma-separated capabilities', async () => {
    const set = await runCli(
      ['settings', 'agent-permissions-set', 'read,note_edit'],
      { env: { LOAMIUM_URL: server.baseUrl } },
    );
    expect(set.code).toBe(0);

    const get = await runCli(['settings', 'agent-permissions', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    const body = JSON.parse(get.stdout) as { permissions: { effective: string[] } };
    expect(body.permissions.effective).toContain('read');
    expect(body.permissions.effective).toContain('note_edit');
  });
});

// ==========================================================================
// [AC-Sa10026-5-3] settings agent-privacy サブコマンド
// ==========================================================================

describe('[AC-Sa10026-5-3] loamium settings agent-privacy', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('agent-privacy-set saves and agent-privacy reads back', async () => {
    const set = await runCli(
      ['settings', 'agent-privacy-set', 'private/**', 'secret.md'],
      { env: { LOAMIUM_URL: server.baseUrl } },
    );
    expect(set.code).toBe(0);
    expect(set.stdout).toContain('2 glob');

    const get = await runCli(['settings', 'agent-privacy', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(get.code).toBe(0);
    const body = JSON.parse(get.stdout) as { deny: string[] };
    expect(body.deny).toContain('private/**');
    expect(body.deny).toContain('secret.md');
  });
});

// ==========================================================================
// [AC-Sa10026-5-3] settings agent-connection-test サブコマンド
// ==========================================================================

describe('[AC-Sa10026-5-3] loamium settings agent-connection-test', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('returns fail line when connection is unreachable', async () => {
    const res = await runCli([
      'settings', 'agent-connection-test',
      '--base-url', 'http://127.0.0.1:1/v1',
      '--model', 'stub',
      '--api', 'openai',
      '--api-key-ref', '$MISSING_SA10026',
    ], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('fail');
  });

  it('--json flag outputs raw JSON', async () => {
    const res = await runCli([
      'settings', 'agent-connection-test',
      '--base-url', 'http://127.0.0.1:1/v1',
      '--model', 'stub',
      '--api', 'openai',
      '--api-key-ref', '$MISSING_SA10026',
      '--json',
    ], { env: { LOAMIUM_URL: server.baseUrl } });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

// ==========================================================================
// [AC-Sa10026-5-3] settings agent-models サブコマンド
// ==========================================================================

describe('[AC-Sa10026-5-3] loamium settings agent-models', () => {
  beforeEach(async () => {
    vault = await makeTempVault();
    server = await startServer({ vault, mode: 'full' });
  });

  it('returns source:fallback line when agent.json not configured', async () => {
    const res = await runCli(['settings', 'agent-models'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('fallback');
  });

  it('--json flag outputs raw JSON with source field', async () => {
    const res = await runCli(['settings', 'agent-models', '--json'], {
      env: { LOAMIUM_URL: server.baseUrl },
    });
    expect(res.code).toBe(0);
    const body = JSON.parse(res.stdout) as { models: string[]; source: string };
    expect(body.source).toBe('fallback');
    expect(Array.isArray(body.models)).toBe(true);
  });
});
