/**
 * Embeds uploaded media into a PR — either as a new comment or appended to the
 * PR description. Bodies are passed to `gh` via stdin (`--input -` / `--body-file -`)
 * so large markdown blocks never hit argv length limits.
 */

import type { PrContext, UploadResult } from './types.js';
import { describeGhError, runGh } from './gh.js';

const MARKER = '<!-- pr-media -->';

/** Builds the markdown block for a set of upload results. */
export function buildMarkdown(results: UploadResult[]): string {
  const lines = results.map((r) => r.markdown);
  return `${MARKER}\n${lines.join('\n')}`;
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
      { stdin: JSON.stringify({ body: block }) },
    );
    return;
  }

  // description: read the current body, append our block, write it back.
  //
  // We must distinguish a body that is legitimately empty/absent (fine — we
  // just write our block) from a *failed* fetch. Defaulting a failed fetch to
  // '' would overwrite the PR description with only our new block, silently
  // destroying the author's text. So on fetch failure we throw instead.
  let current: string;
  try {
    const { stdout } = await runGh([
      'pr',
      'view',
      String(ctx.prNumber),
      '--repo',
      `${ctx.owner}/${ctx.repo}`,
      '--json',
      'body',
    ]);
    const parsed = JSON.parse(stdout) as { body?: string };
    current = parsed.body ?? '';
  } catch (err) {
    throw new Error(
      'Could not read the current PR description via `gh pr view`; refusing to ' +
        `overwrite it with only the new media block. ${describeGhError(err)}`,
    );
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
    { stdin: nextBody },
  );
}
