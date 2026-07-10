import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { MediaFile, PrContext } from '../src/types.js';
import { StrategyError } from '../src/types.js';

/**
 * Mock `node:child_process` so `gh` is never spawned. `node:fs/promises` is
 * left REAL: the release strategy stages files into a throwaway tempdir via
 * copyFile/mkdtemp/rm, and exercising that against real disk (a tiny fixture)
 * is both safe and part of what we want to verify (sanitized asset names).
 */
const h = vi.hoisted(() => {
  interface Call {
    file: string;
    args: string[];
  }
  interface GhReply {
    stdout?: string;
    stderr?: string;
    error?: Error;
  }
  const calls: Call[] = [];
  let router: (file: string, args: string[]) => GhReply = () => ({ stdout: '' });
  const kCustom = Symbol.for('nodejs.util.promisify.custom');

  const execFile: any = (file: string, args: string[], opts: unknown, cb: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    calls.push({ file, args });
    queueMicrotask(() => {
      const r = router(file, args);
      if (r.error) {
        callback(
          Object.assign(r.error, { stdout: r.stdout ?? '', stderr: r.stderr ?? '' }),
          r.stdout ?? '',
          r.stderr ?? '',
        );
      } else {
        callback(null, r.stdout ?? '', r.stderr ?? '');
      }
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
    calls,
    setRouter: (r: typeof router) => { router = r; },
    reset: () => { calls.length = 0; router = () => ({ stdout: '' }); },
  };
});

vi.mock('node:child_process', () => ({ execFile: h.execFile }));

import { releaseStrategy } from '../src/strategies/release.js';

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

const TAG = 'pr-42-media';

function assetsReply(names: string[]): string {
  return JSON.stringify({
    assets: names.map((name) => ({
      name,
      browser_download_url: `https://github.com/acme/widgets/releases/download/${TAG}/${name}`,
    })),
  });
}

beforeEach(() => {
  h.reset();
});

describe('releaseStrategy.upload — existing release', () => {
  it('reuses the release (no create) and returns the asset download URL', async () => {
    const files: MediaFile[] = [{ path: PNG, name: 'a.png', mime: 'image/png', size: 70 }];

    h.setRouter((_file, args) => {
      // `release view <tag>` succeeds → release already exists.
      if (args[0] === 'release' && args[1] === 'view') return { stdout: '{}' };
      if (args[0] === 'release' && args[1] === 'upload') return { stdout: '' };
      if (args[0] === 'api' && args[1] === `repos/acme/widgets/releases/tags/${TAG}`) {
        return { stdout: assetsReply(['a.png']) };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });

    const results = await releaseStrategy.upload(files, makeCtx());

    expect(results[0].strategy).toBe('release');
    expect(results[0].url).toBe(
      `https://github.com/acme/widgets/releases/download/${TAG}/a.png`,
    );
    expect(results[0].markdown).toBe(
      `![a.png](https://github.com/acme/widgets/releases/download/${TAG}/a.png)`,
    );
    // Must NOT have created a release when one already existed.
    expect(h.calls.some((c) => c.args[0] === 'release' && c.args[1] === 'create')).toBe(false);
  });
});

describe('releaseStrategy.upload — missing release + staged names', () => {
  it('creates the release and uploads assets under the sanitized name', async () => {
    // On-disk basename ("sample.png") differs from the sanitized MediaFile.name;
    // staging must upload the asset under the sanitized name.
    const files: MediaFile[] = [
      { path: PNG, name: 'clean-shot.png', mime: 'image/png', size: 70 },
    ];

    let uploadArgs: string[] | undefined;
    h.setRouter((_file, args) => {
      if (args[0] === 'release' && args[1] === 'view') {
        return { error: new Error('release not found'), stderr: 'release not found' };
      }
      if (args[0] === 'release' && args[1] === 'create') return { stdout: '' };
      if (args[0] === 'release' && args[1] === 'upload') {
        uploadArgs = args;
        return { stdout: '' };
      }
      if (args[0] === 'api' && args[1] === `repos/acme/widgets/releases/tags/${TAG}`) {
        return { stdout: assetsReply(['clean-shot.png']) };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });

    const results = await releaseStrategy.upload(files, makeCtx());

    expect(h.calls.some((c) => c.args[0] === 'release' && c.args[1] === 'create')).toBe(true);
    expect(uploadArgs).toBeDefined();
    // The staged path handed to `gh release upload` is named after the
    // sanitized name, not the original on-disk basename.
    const stagedPath = uploadArgs!.find((a) => a.endsWith('.png'))!;
    expect(path.basename(stagedPath)).toBe('clean-shot.png');
    expect(uploadArgs).toContain('--clobber');
    expect(results[0].url).toContain('/clean-shot.png');
  });
});

describe('releaseStrategy.upload — asset missing after upload', () => {
  it('throws StrategyError("release") when the uploaded asset is absent afterwards', async () => {
    const files: MediaFile[] = [{ path: PNG, name: 'a.png', mime: 'image/png', size: 70 }];

    h.setRouter((_file, args) => {
      if (args[0] === 'release' && args[1] === 'view') return { stdout: '{}' };
      if (args[0] === 'release' && args[1] === 'upload') return { stdout: '' };
      if (args[0] === 'api' && args[1] === `repos/acme/widgets/releases/tags/${TAG}`) {
        // Upload "succeeded" but the asset is not present on the release.
        return { stdout: assetsReply(['something-else.png']) };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });

    const err = await releaseStrategy.upload(files, makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(StrategyError);
    expect((err as StrategyError).strategy).toBe('release');
    expect((err as Error).message).toMatch(/was not found on release/i);
  });
});
