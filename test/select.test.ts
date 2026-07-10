import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MediaFile, PrContext } from '../src/types.js';
import { StrategyError } from '../src/types.js';

vi.mock('../src/strategies/browser.js', () => ({
  browserStrategy: {
    name: 'browser',
    isAvailable: vi.fn(),
    upload: vi.fn(),
  },
}));
vi.mock('../src/strategies/hidden-ref.js', () => ({
  hiddenRefStrategy: {
    name: 'hidden-ref',
    isAvailable: vi.fn(),
    upload: vi.fn(),
  },
}));
vi.mock('../src/strategies/release.js', () => ({
  releaseStrategy: {
    name: 'release',
    isAvailable: vi.fn(),
    upload: vi.fn(),
  },
}));

// Imported *after* vi.mock — these bindings are the mocked objects, so the
// same vi.fn() instances used inside select.ts are the ones we configure
// and assert on below.
import { browserStrategy } from '../src/strategies/browser.js';
import { hiddenRefStrategy } from '../src/strategies/hidden-ref.js';
import { releaseStrategy } from '../src/strategies/release.js';
import { selectAndUpload } from '../src/strategies/select.js';

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

const files: MediaFile[] = [
  { path: '/tmp/a.png', name: 'a.png', mime: 'image/png', size: 10 },
];

beforeEach(() => {
  vi.mocked(browserStrategy.isAvailable).mockReset();
  vi.mocked(browserStrategy.upload).mockReset();
  vi.mocked(hiddenRefStrategy.isAvailable).mockReset();
  vi.mocked(hiddenRefStrategy.upload).mockReset();
  vi.mocked(releaseStrategy.isAvailable).mockReset();
  vi.mocked(releaseStrategy.upload).mockReset();
});

describe('selectAndUpload — explicit strategy', () => {
  it('throws when the requested strategy is unavailable', async () => {
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(false);

    await expect(
      selectAndUpload(files, makeCtx(), 'hidden-ref'),
    ).rejects.toThrow(/Strategy "hidden-ref" is not available/);

    expect(hiddenRefStrategy.upload).not.toHaveBeenCalled();
  });

  it('throws on an unknown strategy name', async () => {
    await expect(
      selectAndUpload(files, makeCtx(), 'bogus' as never),
    ).rejects.toThrow(/Unknown strategy "bogus"/);
  });

  it('runs the requested strategy directly when available', async () => {
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(releaseStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'https://x/rel', markdown: '![a](x)', strategy: 'release' },
    ]);

    const results = await selectAndUpload(files, makeCtx(), 'release');
    expect(results[0].strategy).toBe('release');
    expect(browserStrategy.isAvailable).not.toHaveBeenCalled();
    expect(hiddenRefStrategy.isAvailable).not.toHaveBeenCalled();
  });
});

describe('selectAndUpload — auto fallback', () => {
  it('falls back to the next strategy when one throws StrategyError', async () => {
    vi.mocked(browserStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(browserStrategy.upload).mockRejectedValue(
      new StrategyError('browser', 'no logged-in browser'),
    );
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(hiddenRefStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'https://x/hr', markdown: '![a](x)', strategy: 'hidden-ref' },
    ]);
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(true);

    const results = await selectAndUpload(files, makeCtx({ isCI: false }), 'auto');

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe('hidden-ref');
    expect(browserStrategy.upload).toHaveBeenCalledTimes(1);
    expect(hiddenRefStrategy.upload).toHaveBeenCalledTimes(1);
    expect(releaseStrategy.upload).not.toHaveBeenCalled();
  });

  it('skips strategies whose isAvailable() returns false', async () => {
    vi.mocked(browserStrategy.isAvailable).mockResolvedValue(false);
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(hiddenRefStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'https://x/hr', markdown: '![a](x)', strategy: 'hidden-ref' },
    ]);
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(true);

    const results = await selectAndUpload(files, makeCtx({ isCI: false }), 'auto');

    expect(results[0].strategy).toBe('hidden-ref');
    expect(browserStrategy.upload).not.toHaveBeenCalled();
  });

  it('aggregates every failure when all strategies fail', async () => {
    vi.mocked(browserStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(browserStrategy.upload).mockRejectedValue(
      new StrategyError('browser', 'browser-boom'),
    );
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(hiddenRefStrategy.upload).mockRejectedValue(
      new StrategyError('hidden-ref', 'hiddenref-boom'),
    );
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(releaseStrategy.upload).mockRejectedValue(
      new StrategyError('release', 'release-boom'),
    );

    let caught: Error | undefined;
    try {
      await selectAndUpload(files, makeCtx({ isCI: false }), 'auto');
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/All upload strategies failed/);
    expect(caught!.message).toContain('browser-boom');
    expect(caught!.message).toContain('hiddenref-boom');
    expect(caught!.message).toContain('release-boom');
  });

  it('propagates a non-StrategyError immediately without trying the rest', async () => {
    vi.mocked(browserStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(browserStrategy.upload).mockRejectedValue(
      new Error('unexpected crash, not a StrategyError'),
    );
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(hiddenRefStrategy.upload).mockResolvedValue([]);
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(releaseStrategy.upload).mockResolvedValue([]);

    await expect(
      selectAndUpload(files, makeCtx({ isCI: false }), 'auto'),
    ).rejects.toThrow('unexpected crash, not a StrategyError');

    expect(hiddenRefStrategy.upload).not.toHaveBeenCalled();
    expect(releaseStrategy.upload).not.toHaveBeenCalled();
  });

  it('reports guidance when no strategy is available at all', async () => {
    vi.mocked(browserStrategy.isAvailable).mockResolvedValue(false);
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(false);
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(false);

    await expect(
      selectAndUpload(files, makeCtx({ isCI: false }), 'auto'),
    ).rejects.toThrow(/No upload strategy is available/);
  });

  it('treats a broken availability check as unavailable and keeps going', async () => {
    vi.mocked(browserStrategy.isAvailable).mockRejectedValue(new Error('probe failed'));
    vi.mocked(hiddenRefStrategy.isAvailable).mockResolvedValue(true);
    vi.mocked(hiddenRefStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'https://x/hr', markdown: '![a](x)', strategy: 'hidden-ref' },
    ]);
    vi.mocked(releaseStrategy.isAvailable).mockResolvedValue(true);

    const results = await selectAndUpload(files, makeCtx({ isCI: false }), 'auto');
    expect(results[0].strategy).toBe('hidden-ref');
  });
});

describe('selectAndUpload — auto ordering', () => {
  it('tries browser first outside CI', async () => {
    const order: string[] = [];
    vi.mocked(browserStrategy.isAvailable).mockImplementation(async () => {
      order.push('browser');
      return true;
    });
    vi.mocked(browserStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'u', markdown: 'm', strategy: 'browser' },
    ]);
    vi.mocked(hiddenRefStrategy.isAvailable).mockImplementation(async () => {
      order.push('hidden-ref');
      return true;
    });
    vi.mocked(releaseStrategy.isAvailable).mockImplementation(async () => {
      order.push('release');
      return true;
    });

    await selectAndUpload(files, makeCtx({ isCI: false }), 'auto');
    expect(order[0]).toBe('browser');
  });

  it('moves browser to the end when running in CI', async () => {
    // Every strategy is "available" here; hidden-ref and release both fail
    // with a StrategyError so the fallback chain actually walks through all
    // three, letting us observe the full isAvailable() call order.
    const order: string[] = [];
    vi.mocked(hiddenRefStrategy.isAvailable).mockImplementation(async () => {
      order.push('hidden-ref');
      return true;
    });
    vi.mocked(hiddenRefStrategy.upload).mockRejectedValue(
      new StrategyError('hidden-ref', 'fail'),
    );
    vi.mocked(releaseStrategy.isAvailable).mockImplementation(async () => {
      order.push('release');
      return true;
    });
    vi.mocked(releaseStrategy.upload).mockRejectedValue(
      new StrategyError('release', 'fail'),
    );
    vi.mocked(browserStrategy.isAvailable).mockImplementation(async () => {
      order.push('browser');
      return true;
    });
    vi.mocked(browserStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'u', markdown: 'm', strategy: 'browser' },
    ]);

    const results = await selectAndUpload(
      files,
      makeCtx({ isCI: true, isPrivate: true }),
      'auto',
    );

    expect(order).toEqual(['hidden-ref', 'release', 'browser']);
    expect(results[0].strategy).toBe('browser');
  });

  it('prefers release first in CI for a public repo', async () => {
    const order: string[] = [];
    vi.mocked(releaseStrategy.isAvailable).mockImplementation(async () => {
      order.push('release');
      return true;
    });
    vi.mocked(releaseStrategy.upload).mockRejectedValue(
      new StrategyError('release', 'fail'),
    );
    vi.mocked(hiddenRefStrategy.isAvailable).mockImplementation(async () => {
      order.push('hidden-ref');
      return true;
    });
    vi.mocked(hiddenRefStrategy.upload).mockRejectedValue(
      new StrategyError('hidden-ref', 'fail'),
    );
    vi.mocked(browserStrategy.isAvailable).mockImplementation(async () => {
      order.push('browser');
      return true;
    });
    vi.mocked(browserStrategy.upload).mockResolvedValue([
      { file: files[0], url: 'u', markdown: 'm', strategy: 'browser' },
    ]);

    await selectAndUpload(files, makeCtx({ isCI: true, isPrivate: false }), 'auto');

    expect(order).toEqual(['release', 'hidden-ref', 'browser']);
  });
});
