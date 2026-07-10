import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { MediaFile, PrContext } from '../src/types.js';
import { StrategyError } from '../src/types.js';

/**
 * Mock `node:child_process` so neither `agent-browser` nor `gh` is ever
 * spawned, and mock `playwright-core` so the CDP backend never opens a real
 * socket. No test touches the network or a real browser.
 */
const h = vi.hoisted(() => {
  let router: (file: string, args: string[]) => { stdout?: string; stderr?: string; error?: Error } =
    () => ({ stdout: '' });
  const kCustom = Symbol.for('nodejs.util.promisify.custom');

  const execFile: any = (file: string, args: string[], opts: unknown, cb: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    queueMicrotask(() => {
      const r = router(file, args);
      if (r.error) callback(r.error, r.stdout ?? '', r.stderr ?? '');
      else callback(null, r.stdout ?? '', r.stderr ?? '');
    });
    return { stdin: { end: () => {} } };
  };
  execFile[kCustom] = (file: string, args: string[], opts: unknown) =>
    new Promise((resolve, reject) => {
      execFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      );
    });

  return {
    execFile,
    setRouter: (r: typeof router) => { router = r; },
    reset: () => { router = () => ({ stdout: '' }); },
  };
});

const connectOverCDP = vi.fn();

vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP } }));

import { browserStrategy } from '../src/strategies/browser.js';

const PNG = fileURLToPath(new URL('./fixtures/sample.png', import.meta.url));

function makeCtx(overrides: Partial<PrContext> = {}): PrContext {
  return {
    owner: 'acme',
    repo: 'widgets',
    prNumber: 42,
    prUrl: 'https://github.com/acme/widgets/pull/42',
    isPrivate: true,
    isCI: false,
    token: 'tok',
    ...overrides,
  };
}

const files: MediaFile[] = [{ path: PNG, name: 'a.png', mime: 'image/png', size: 70 }];

let savedCdpUrl: string | undefined;

beforeEach(() => {
  h.reset();
  connectOverCDP.mockReset();
  savedCdpUrl = process.env.PR_MEDIA_CDP_URL;
  delete process.env.PR_MEDIA_CDP_URL;
});

afterEach(() => {
  if (savedCdpUrl === undefined) delete process.env.PR_MEDIA_CDP_URL;
  else process.env.PR_MEDIA_CDP_URL = savedCdpUrl;
});

describe('browserStrategy.isAvailable', () => {
  it('is false in CI when PR_MEDIA_CDP_URL is not set', async () => {
    // In CI there is no interactive logged-in browser and no CDP endpoint
    // configured, so the strategy must decline without probing anything.
    const available = await browserStrategy.isAvailable(makeCtx({ isCI: true }));
    expect(available).toBe(false);
  });
});

describe('browserStrategy.upload — both backends fail', () => {
  it('throws an aggregated StrategyError("browser") when agent-browser and CDP both fail', async () => {
    // agent-browser is "installed" (--help succeeds) so the backend is tried,
    // but every real action fails; the CDP backend then fails to connect.
    h.setRouter((file, args) => {
      if (file === 'agent-browser' && args[0] === '--help') return { stdout: 'usage: agent-browser' };
      if (file === 'agent-browser') {
        return { error: new Error('agent-browser: open failed') };
      }
      return { stdout: '' };
    });
    connectOverCDP.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:9222'));

    const err = await browserStrategy.upload(files, makeCtx({ isCI: false })).catch((e) => e);

    expect(err).toBeInstanceOf(StrategyError);
    expect((err as StrategyError).strategy).toBe('browser');
    expect((err as Error).message).toMatch(/all browser backends failed/i);
    expect(connectOverCDP).toHaveBeenCalled();
  });
});
