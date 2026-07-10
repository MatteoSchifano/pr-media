import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFiles } from '../src/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const SAMPLE_PNG = path.join(FIXTURES_DIR, 'sample.png');
const SAMPLE_GIF = path.join(FIXTURES_DIR, 'sample.gif');

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-media-validate-'));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('validateFiles — happy path', () => {
  it('accepts real png and gif fixtures', async () => {
    const results = await validateFiles([SAMPLE_PNG, SAMPLE_GIF]);
    expect(results).toHaveLength(2);

    expect(results[0].name).toBe('sample.png');
    expect(results[0].mime).toBe('image/png');
    expect(results[0].path).toBe(path.resolve(SAMPLE_PNG));
    expect(results[0].size).toBeGreaterThan(0);

    expect(results[1].name).toBe('sample.gif');
    expect(results[1].mime).toBe('image/gif');
    expect(results[1].path).toBe(path.resolve(SAMPLE_GIF));
    expect(results[1].size).toBeGreaterThan(0);
  });
});

describe('validateFiles — unsupported extension', () => {
  it('rejects a file with an extension outside the supported map', async () => {
    const badExtFile = path.join(tmpDir, 'notes.txt');
    await fs.writeFile(badExtFile, 'just some text, not media');

    await expect(validateFiles([badExtFile])).rejects.toThrow(
      /unsupported file extension "\.txt"/,
    );
  });

  it('lists the supported extensions in the error message', async () => {
    const badExtFile = path.join(tmpDir, 'notes2.md');
    await fs.writeFile(badExtFile, '# hello');

    await expect(validateFiles([badExtFile])).rejects.toThrow(/\.png/);
  });
});

describe('validateFiles — missing file', () => {
  it('reports a clear "file not found" error', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.png');

    await expect(validateFiles([missing])).rejects.toThrow(/file not found/);
  });
});

describe('validateFiles — magic bytes mismatch', () => {
  it('rejects a .png file that is actually text content', async () => {
    const fakePng = path.join(tmpDir, 'fake.png');
    await fs.writeFile(fakePng, 'this is definitely not a real PNG file');

    await expect(validateFiles([fakePng])).rejects.toThrow(
      /magic bytes mismatch/,
    );
  });

  it('rejects a .gif file with a PNG signature', async () => {
    const pngBytes = await fs.readFile(SAMPLE_PNG);
    const mislabeled = path.join(tmpDir, 'mislabeled.gif');
    await fs.writeFile(mislabeled, pngBytes);

    await expect(validateFiles([mislabeled])).rejects.toThrow(
      /magic bytes mismatch/,
    );
  });
});

describe('validateFiles — name sanitization', () => {
  it('replaces spaces and unsafe characters with "-"', async () => {
    const pngBytes = await fs.readFile(SAMPLE_PNG);
    const weirdName = path.join(tmpDir, 'my great shot #1 (final)!.png');
    await fs.writeFile(weirdName, pngBytes);

    const [result] = await validateFiles([weirdName]);
    expect(result.name).toMatch(/^[a-zA-Z0-9._-]+\.png$/);
    expect(result.name).not.toMatch(/[ #()!]/);
  });

  it('de-duplicates collisions with a numeric suffix', async () => {
    const pngBytes = await fs.readFile(SAMPLE_PNG);
    const fileA = path.join(tmpDir, 'my file!.png');
    const fileB = path.join(tmpDir, 'my file@.png');
    await fs.writeFile(fileA, pngBytes);
    await fs.writeFile(fileB, pngBytes);

    const results = await validateFiles([fileA, fileB]);
    expect(results).toHaveLength(2);

    // Both original names sanitize to the same base ("my-file-.png"), so the
    // second one must be de-duplicated with a numeric suffix.
    expect(results[0].name).toBe('my-file-.png');
    expect(results[1].name).toBe('my-file--2.png');
    expect(results[0].name).not.toBe(results[1].name);
  });

  it('replaces an all-unsafe base name with dashes (never crashes, always a valid name)', async () => {
    // NOTE: sanitizeFileName() has a `if (!safeBase) safeBase = 'file'`
    // fallback for a *fully empty* base name, but that branch looks
    // unreachable in practice: Node's `path.extname`/`path.basename` can
    // only produce a non-empty extension when at least one character
    // precedes it, so the base slice is never zero-length once we've
    // already passed the supported-extension check. "!!!.png" sanitizes to
    // "---.png", not the "file.png" fallback.
    const pngBytes = await fs.readFile(SAMPLE_PNG);
    const onlyUnsafe = path.join(tmpDir, '!!!.png');
    await fs.writeFile(onlyUnsafe, pngBytes);

    const [result] = await validateFiles([onlyUnsafe]);
    expect(result.name).toBe('---.png');
    expect(result.name).toMatch(/^[a-zA-Z0-9._-]+\.png$/);
  });
});

describe('validateFiles — size limits', () => {
  it('rejects an image file larger than the 10MB GitHub limit', async () => {
    const oversized = path.join(tmpDir, 'huge.png');
    // Valid PNG magic bytes up front are irrelevant here — the size check
    // runs before the magic-byte check — but included for realism.
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const filler = Buffer.alloc(10 * 1024 * 1024 + 1024, 0);
    await fs.writeFile(oversized, Buffer.concat([pngHeader, filler]));

    await expect(validateFiles([oversized])).rejects.toThrow(
      /exceeds the 10\.0 MB limit GitHub applies to images/,
    );
  });

  it('aggregates errors across multiple broken files into a single message', async () => {
    const oversized = path.join(tmpDir, 'huge2.png');
    await fs.writeFile(oversized, Buffer.alloc(10 * 1024 * 1024 + 1, 0));

    const badExt = path.join(tmpDir, 'readme.doc');
    await fs.writeFile(badExt, 'not media');

    const missing = path.join(tmpDir, 'ghost.gif');

    let caught: Error | undefined;
    try {
      await validateFiles([oversized, badExt, missing]);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/^Invalid media file\(s\):/);

    // All three broken files must be represented, and none should have
    // short-circuited the others.
    expect(caught!.message).toContain('huge2.png');
    expect(caught!.message).toMatch(/exceeds the 10\.0 MB limit/);
    expect(caught!.message).toContain('readme.doc');
    expect(caught!.message).toMatch(/unsupported file extension "\.doc"/);
    expect(caught!.message).toContain('ghost.gif');
    expect(caught!.message).toMatch(/file not found/);

    // Three distinct bullet lines.
    const bulletCount = (caught!.message.match(/^\s+- /gm) ?? []).length;
    expect(bulletCount).toBe(3);
  });

  it('accepts an image file just under the 10MB limit', async () => {
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const filler = Buffer.alloc(10 * 1024 * 1024 - pngHeader.length - 1, 0);
    const underLimit = path.join(tmpDir, 'just-under.png');
    await fs.writeFile(underLimit, Buffer.concat([pngHeader, filler]));

    const [result] = await validateFiles([underLimit]);
    expect(result.name).toBe('just-under.png');
  });
});

describe('validateFiles — empty file', () => {
  it('rejects a zero-byte file', async () => {
    const empty = path.join(tmpDir, 'empty.png');
    await fs.writeFile(empty, Buffer.alloc(0));

    await expect(validateFiles([empty])).rejects.toThrow(/file is empty/);
  });
});
