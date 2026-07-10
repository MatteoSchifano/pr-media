/**
 * Embeds uploaded media into a PR — either as a new comment or appended to the
 * PR description. Bodies are passed to `gh` via stdin (`--input -` / `--body-file -`)
 * so large markdown blocks never hit argv length limits.
 */

import { execFile } from 'node:child_process';
import type { PrContext, UploadResult } from './types.js';

const MARKER = '<!-- pr-media -->';

/** Builds the markdown block for a set of upload results. */
export function buildMarkdown(results: UploadResult[]): string {
  const lines = results.map((r) => r.markdown);
  return `${MARKER}\n${lines.join('\n')}`;
}

/**
 * Runs a `gh` command, optionally piping `input` to its stdin. Rejects with the
 * command's stderr on non-zero exit.
 */
function runGh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      { maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as NodeJS.ErrnoException;
          if (e.code === 'ENOENT') {
            reject(
              new Error(
                'The GitHub CLI (`gh`) is not installed or not on PATH.',
              ),
            );
            return;
          }
          reject(new Error(stderr?.trim() || e.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

export async function embedInPr(
  results: UploadResult[],
  ctx: PrContext,
  to: 'description' | 'comment',
): Promise<void> {
  if (results.length === 0) return;
  const block = buildMarkdown(results);

  if (to === 'comment') {
    // `--input -` sends the raw stdin as the JSON request body, avoiding argv
    // length limits that `-f body=...` would hit for large markdown blocks.
    await runGh(
      [
        'api',
        '--method',
        'POST',
        `repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments`,
        '--input',
        '-',
      ],
      JSON.stringify({ body: block }),
    );
    return;
  }

  // description: read the current body, append our block, write it back.
  let current = '';
  try {
    const out = await runGh([
      'pr',
      'view',
      String(ctx.prNumber),
      '--repo',
      `${ctx.owner}/${ctx.repo}`,
      '--json',
      'body',
    ]);
    const parsed = JSON.parse(out) as { body?: string };
    current = parsed.body ?? '';
  } catch {
    current = '';
  }

  const nextBody = current.trim().length > 0 ? `${current}\n\n${block}` : block;

  await runGh(
    [
      'pr',
      'edit',
      String(ctx.prNumber),
      '--repo',
      `${ctx.owner}/${ctx.repo}`,
      '--body-file',
      '-',
    ],
    nextBody,
  );
}
