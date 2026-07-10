/**
 * Shared helpers for talking to the GitHub CLI (`gh`) and for turning an
 * uploaded asset into embeddable markdown.
 *
 * Every strategy and the CLI go through `runGh` here, which invokes `gh`
 * directly via `execFile` (never a shell) with each argument passed
 * separately, so user-provided values are argv — never interpolated — and
 * authentication stays entirely `gh`'s problem. No token is ever read,
 * logged, or interpolated into a string, and no cookie/session store is ever
 * touched.
 */

import { execFile } from 'node:child_process';
import type { MediaFile } from './types.js';

/** Generous ceiling: blob/asset payloads can be large (base64-inflated media). */
const DEFAULT_MAX_BUFFER = 200 * 1024 * 1024;

export interface GhResult {
  stdout: string;
  stderr: string;
}

export interface RunGhOptions {
  /** Data to pipe to the child's stdin (used for `--input -` JSON payloads). */
  stdin?: string;
  /** Override the default stdout/stderr buffer ceiling. */
  maxBuffer?: number;
}

/**
 * Runs `gh <args>`, optionally feeding `stdin` to the child. Resolves with the
 * raw `{ stdout, stderr }`. On failure rejects with the original error object
 * augmented with `stdout`/`stderr` so callers can inspect `.code` (e.g.
 * `ENOENT`) and the captured `stderr`; pass the rejection to `describeGhError`
 * for a user-facing message.
 */
export function runGh(args: string[], opts: RunGhOptions = {}): Promise<GhResult> {
  const { stdin, maxBuffer = DEFAULT_MAX_BUFFER } = opts;
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    // Always close stdin so `gh` never blocks waiting for input we won't send.
    child.stdin?.end(stdin ?? undefined);
  });
}

/**
 * Classifies a `runGh` rejection into a clear, user-facing message.
 * Distinguishes a missing `gh` binary (ENOENT) and authentication failures
 * from generic command errors (which surface `gh`'s own stderr).
 */
export function describeGhError(err: unknown): string {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e.code === 'ENOENT') {
    return 'The GitHub CLI (`gh`) is not installed or not on PATH. Install it from https://cli.github.com.';
  }
  const stderr = (e.stderr ?? '').trim();
  const lower = stderr.toLowerCase();
  if (lower.includes('auth') || lower.includes('logged in')) {
    return 'You are not authenticated with the GitHub CLI. Run `gh auth login` first.';
  }
  return stderr || e.message || String(err);
}

/** Best-effort `gh auth token` lookup. The token is never logged. */
export async function getGhAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await runGh(['auth', 'token']);
    const token = stdout.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cheap availability probe shared by the `gh`-based strategies: true when a
 * usable token is already on the context or `gh` can produce one.
 */
export async function hasGhAuth(ctx?: { token?: string }): Promise<boolean> {
  if (ctx?.token) return true;
  return (await getGhAuthToken()) !== undefined;
}

/**
 * How a video asset should be embedded, which depends on where it is hosted:
 *  - `video-tag`  — a `<video src controls>` element. Used for blob/release
 *    URLs (hidden-ref, release), which GitHub does NOT auto-render.
 *  - `bare-url`   — the raw URL on its own line. Used for
 *    `user-attachments` URLs (browser strategy), which GitHub renders inline
 *    as a native player only when the URL stands alone (a `[name](url)` link
 *    would render as a plain link, not a player).
 */
export type VideoEmbedStyle = 'video-tag' | 'bare-url';

/**
 * Builds ready-to-embed markdown for an uploaded asset.
 *  - images/GIFs → `![name](url)`
 *  - videos      → per `videoStyle` (see {@link VideoEmbedStyle})
 *  - anything else (not produced by the validator today) → `[name](url)`
 */
export function toMarkdown(
  file: MediaFile,
  url: string,
  videoStyle: VideoEmbedStyle = 'video-tag',
): string {
  if (file.mime.startsWith('image/')) {
    return `![${file.name}](${url})`;
  }
  if (file.mime.startsWith('video/')) {
    return videoStyle === 'bare-url' ? url : `<video src="${url}" controls></video>`;
  }
  return `[${file.name}](${url})`;
}
