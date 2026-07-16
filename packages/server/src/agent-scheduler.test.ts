/**
 * Unit tests for agent-scheduler defaults (S2fe109-3)
 *
 * [AC-S2fe109-3-4]
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentSession } from '@earendil-works/pi-coding-agent';

vi.mock('./agent-service.js', () => ({
  loadAgentConfig: vi.fn().mockResolvedValue({
    ok: true,
    config: { api: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'gpt-4o', apiKey: 'key' },
  }),
  createPiSession: vi.fn(),
  getEffectiveCapabilities: vi.fn().mockReturnValue(['read']),
}));

vi.mock('./agent-job-state.js', () => ({
  getJobState: vi.fn().mockResolvedValue({ lastRunAt: null }),
  setJobLastRunAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./agent-jobs-service.js', () => ({
  loadAgentJobs: vi.fn().mockResolvedValue([]),
  computeNextRunAt: vi.fn().mockReturnValue(null),
}));

describe('agent-scheduler defaults', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('SCHEDULER_MAX_TURNS default is 10 (AC-S2fe109-3-4)', async () => {
    // [AC-S2fe109-3-4]
    const { SCHEDULER_MAX_TURNS } = await import('./agent-scheduler.js');
    expect(SCHEDULER_MAX_TURNS).toBe(10);
  });

  it('SCHEDULER_TIMEOUT_MS default is 300000 (AC-S2fe109-3-4)', async () => {
    // [AC-S2fe109-3-4]
    const { SCHEDULER_TIMEOUT_MS } = await import('./agent-scheduler.js');
    expect(SCHEDULER_TIMEOUT_MS).toBe(300_000);
  });

  it('runJobSession calls session.prompt and aborts after SCHEDULER_TIMEOUT_MS (AC-S2fe109-3-4)', async () => {
    // [AC-S2fe109-3-4]
    vi.useFakeTimers();

    const abortMock = vi.fn().mockResolvedValue(undefined);
    const promptMock = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const mockSession = {
      prompt: promptMock,
      abort: abortMock,
      sessionId: 'test-session',
      subscribe: vi.fn().mockReturnValue(() => {}),
    };

    const { createPiSession } = await import('./agent-service.js');
    vi.mocked(createPiSession).mockResolvedValue(mockSession as unknown as AgentSession);

    const { runJobSession, SCHEDULER_MAX_TURNS, SCHEDULER_TIMEOUT_MS } = await import('./agent-scheduler.js');

    const serverConfig = {
      vaultRoot: '/tmp/test-vault',
      mode: 'full' as const,
    };

    const job = {
      name: 'test-job',
      schedule: '0 7 * * *',
      prompt: 'Do something',
      permission: 'read-only' as const,
      enabled: true,
    };

    const index = {} as import('./noteIndex.js').VaultIndex;

    await runJobSession(
      serverConfig as import('./config.js').ServerConfig,
      index,
      job,
      SCHEDULER_MAX_TURNS,
      SCHEDULER_TIMEOUT_MS,
    );

    expect(promptMock).toHaveBeenCalledWith('Do something');

    vi.advanceTimersByTime(SCHEDULER_TIMEOUT_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(abortMock).toHaveBeenCalled();
  });

  it('runJobSession aborts when turn_end count reaches maxTurns (AC-S2fe109-3-4)', async () => {
    // [AC-S2fe109-3-4] — verifies maxTurns is wired to abort, not just a constant
    const abortMock = vi.fn().mockResolvedValue(undefined);
    const promptMock = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    let capturedListener: ((event: { type: string }) => void) | undefined;

    const mockSession = {
      prompt: promptMock,
      abort: abortMock,
      sessionId: 'test-session',
      subscribe: vi.fn().mockImplementation((listener: (event: { type: string }) => void) => {
        capturedListener = listener;
        return () => { capturedListener = undefined; };
      }),
    };

    const { createPiSession } = await import('./agent-service.js');
    vi.mocked(createPiSession).mockResolvedValue(mockSession as unknown as AgentSession);

    const { runJobSession } = await import('./agent-scheduler.js');

    const serverConfig = { vaultRoot: '/tmp/test-vault', mode: 'full' as const };
    const job = {
      name: 'turns-test-job',
      schedule: '0 7 * * *',
      prompt: 'Do something',
      permission: 'read-only' as const,
      enabled: true,
    };
    const index = {} as import('./noteIndex.js').VaultIndex;

    // Use maxTurns=3 so we don't need to fire 10 events
    await runJobSession(
      serverConfig as import('./config.js').ServerConfig,
      index,
      job,
      3,
      60_000,
    );

    expect(mockSession.subscribe).toHaveBeenCalled();
    expect(capturedListener).toBeDefined();

    // Fire 2 turn_end events — abort should NOT have been called yet
    capturedListener!({ type: 'turn_end' });
    capturedListener!({ type: 'turn_end' });
    expect(abortMock).not.toHaveBeenCalled();

    // Fire the 3rd turn_end — abort should now be called
    capturedListener!({ type: 'turn_end' });
    expect(abortMock).toHaveBeenCalledTimes(1);
  });
});
