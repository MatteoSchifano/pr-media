import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { MediaFile, PrContext } from '../src/types.js';
import { StrategyError } from '../src/types.js';

/**
 * Mock `node:child_process` so `gh` is never actually spawned. The shared
 * `runGh` (src/gh.ts) invokes `execFile('gh', args, opts, cb)` and writes any
 * `--input -` JSON to `child.stdin.end(...)`, so our fake records `{ file,
 * args, stdin }` per call and drives the callback from a per-test `router`.
 * No test touches the network or the real `gh` binary.
 */
const h = vi.hoisted(() => {
  interface Call {
    file: string;
    args: string[];
    stdin?: string;
  }
  interface GhReply {
    stdout?: string;
    stderr?: string;
    error?: Error;
  }
  const calls: Call[] = [];
  let router: (file: string, args: string[]) => GhReply = () => ({ stdout: '' });

  // Node's promisify looks up this well-known symbol; providing it lets any
  // promisify(execFile) resolve to `{ stdout, stderr }` like the real thing.
  const kCustom = Symbol.for('nodejs.util.promisify.custom');

  const execFile: any = (file: string, args: string[], opts: unknown, cb: unknown) => {
    const callback = (typeof opts === 'function' ? opts : cb) as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    const call: Call = { file, args, stdin: undefined };
    calls.push(call);
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
    return { stdin: { end: (data?: string) => { call.stdin = data; } } };
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

import { hiddenRefStrategy } from '../src/strategies/hidden-ref.js';

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

const files: MediaFile[] = [
  { path: PNG, name: 'a.png', mime: 'image/png', size: 70 },
];

function ghError(stderr: string, code?: string): Error {
  const e = new Error(stderr) as Error & { code?: string };
  if (code) e.code = code;
  return e;
}

beforeEach(() => {
  h.reset();
});

describe('hiddenRefStrategy.upload — new ref (happy path)', () => {
  it('commits blob → tree → commit → new ref and returns a ?raw=true blob URL', async () => {
    h.setRouter((_file, args) => {
      const ep = args[1];
      if (ep === 'repos/acme/widgets/git/ref/uploads/pr/42') {
        // Ref does not exist yet.
        return { error: ghError('gh: Not Found'), stderr: 'HTTP 404: Not Found (https://api.github.com/...)' };
      }
      if (ep === 'repos/acme/widgets/git/blobs') return { stdout: JSON.stringify({ sha: 'bl0bsha' }) };
      if (ep === 'repos/acme/widgets/git/trees') return { stdout: JSON.stringify({ sha: 'tr33sha' }) };
      if (ep === 'repos/acme/widgets/git/commits') return { stdout: JSON.stringify({ sha: 'c0ffee' }) };
      if (ep === 'repos/acme/widgets/git/refs') return { stdout: JSON.stringify({ ref: 'refs/uploads/pr/42' }) };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });

    const results = await hiddenRefStrategy.upload(files, makeCtx());

    expect(results).toHaveLength(1);
    expect(results[0].strategy).toBe('hidden-ref');
    expect(results[0].url).toBe(
      'https://github.com/acme/widgets/blob/c0ffee/a.png?raw=true',
    );
    expect(results[0].markdown).toBe('![a.png](https://github.com/acme/widgets/blob/c0ffee/a.png?raw=true)');

    // New ref: created via POST to .../git/refs (not PATCH), with no base_tree.
    const refCreate = h.calls.find((c) => c.args[1] === 'repos/acme/widgets/git/refs');
    expect(refCreate).toBeDefined();
    expect(refCreate!.args).toContain('POST');
    expect(JSON.parse(refCreate!.stdin!)).toEqual({ ref: 'refs/uploads/pr/42', sha: 'c0ffee' });

    const treeCall = h.calls.find((c) => c.args[1] === 'repos/acme/widgets/git/trees');
    const treePayload = JSON.parse(treeCall!.stdin!);
    expect(treePayload.base_tree).toBeUndefined();
    expect(treePayload.tree).toEqual([
      { path: 'a.png', mode: '100644', type: 'blob', sha: 'bl0bsha' },
    ]);

    // Never used a PATCH (no existing ref to update).
    expect(h.calls.some((c) => c.args.includes('PATCH'))).toBe(false);
  });
});

describe('hiddenRefStrategy.upload — existing ref (base_tree merge)', () => {
  it('reuses the parent commit tree as base_tree and force-updates the ref via PATCH', async () => {
    h.setRouter((_file, args) => {
      const ep = args[1];
      if (ep === 'repos/acme/widgets/git/ref/uploads/pr/42') {
        return { stdout: JSON.stringify({ object: { sha: 'p4rent' } }) };
      }
      if (ep === 'repos/acme/widgets/git/commits/p4rent') {
        return { stdout: JSON.stringify({ tree: { sha: 'basetr33' } }) };
      }
      if (ep === 'repos/acme/widgets/git/blobs') return { stdout: JSON.stringify({ sha: 'bl0b2' }) };
      if (ep === 'repos/acme/widgets/git/trees') return { stdout: JSON.stringify({ sha: 'tr332' }) };
      if (ep === 'repos/acme/widgets/git/commits') return { stdout: JSON.stringify({ sha: 'c0mmit2' }) };
      if (ep === 'repos/acme/widgets/git/refs/uploads/pr/42') return { stdout: '{}' };
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });

    const results = await hiddenRefStrategy.upload(files, makeCtx());

    expect(results[0].url).toBe('https://github.com/acme/widgets/blob/c0mmit2/a.png?raw=true');

    // The new tree is built on top of the parent commit's tree.
    const treeCall = h.calls.find((c) => c.args[1] === 'repos/acme/widgets/git/trees');
    expect(JSON.parse(treeCall!.stdin!).base_tree).toBe('basetr33');

    // The commit parents the previous tip.
    const commitCall = h.calls.find((c) => c.args[1] === 'repos/acme/widgets/git/commits');
    expect(JSON.parse(commitCall!.stdin!).parents).toEqual(['p4rent']);

    // Existing ref: force-updated via PATCH, never re-created.
    const refPatch = h.calls.find((c) => c.args[1] === 'repos/acme/widgets/git/refs/uploads/pr/42');
    expect(refPatch).toBeDefined();
    expect(refPatch!.args).toContain('PATCH');
    expect(JSON.parse(refPatch!.stdin!)).toEqual({ sha: 'c0mmit2', force: true });
    expect(h.calls.some((c) => c.args[1] === 'repos/acme/widgets/git/refs')).toBe(false);
  });
});

describe('hiddenRefStrategy.upload — gh failure', () => {
  it('wraps an unexpected gh error in StrategyError("hidden-ref")', async () => {
    h.setRouter((_file, args) => {
      const ep = args[1];
      if (ep === 'repos/acme/widgets/git/ref/uploads/pr/42') {
        // A real error (not a 404) while reading the ref must abort the upload.
        return { error: ghError('boom'), stderr: 'HTTP 500: the server exploded' };
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    });

    const err = await hiddenRefStrategy.upload(files, makeCtx()).catch((e) => e);
    expect(err).toBeInstanceOf(StrategyError);
    expect((err as StrategyError).strategy).toBe('hidden-ref');
    expect((err as Error).message).toContain('the server exploded');
    // We must not have gone on to write anything.
    expect(h.calls.some((c) => c.args[1] === 'repos/acme/widgets/git/blobs')).toBe(false);
  });
});
