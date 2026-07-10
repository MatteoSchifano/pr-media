/**
 * Resolves the PR context (owner/repo/number/url/token) from CLI options or by
 * auto-detecting via the `gh` CLI. All `gh` invocations use execFile (never a
 * shell) so user-provided values are passed as argv, not interpolated.
 */

import type { PrContext } from './types.js';
import { describeGhError, getGhAuthToken, runGh } from './gh.js';

export interface ResolveOptions {
  pr?: string;
  prUrl?: string;
  repo?: string;
}

/** github.com/<owner>/<repo>/pull/<number>, tolerant of trailing paths/queries. */
const PR_URL_RE =
  /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i;

/** owner/repo, both segments non-empty and slash-free. */
const REPO_RE = /^([^/\s]+)\/([^/\s]+)$/;

/**
 * Runs a `gh` subcommand. Throws a user-friendly error (via `describeGhError`)
 * if gh is missing or the user is not authenticated, otherwise surfaces gh's
 * own stderr.
 */
async function gh(args: string[]): Promise<string> {
  try {
    const { stdout } = await runGh(args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new Error(describeGhError(err));
  }
}

/** Best-effort token lookup. Never logged. Falls back to GITHUB_TOKEN. */
async function resolveToken(): Promise<string | undefined> {
  return (await getGhAuthToken()) ?? process.env.GITHUB_TOKEN ?? undefined;
}

async function repoMeta(
  owner: string,
  repo: string,
): Promise<{ isPrivate: boolean }> {
  try {
    const out = await gh([
      'repo',
      'view',
      `${owner}/${repo}`,
      '--json',
      'isPrivate',
    ]);
    const parsed = JSON.parse(out) as { isPrivate?: boolean };
    return { isPrivate: !!parsed.isPrivate };
  } catch {
    // If we cannot determine visibility, assume private (safer default).
    return { isPrivate: true };
  }
}

export async function resolvePrContext(
  opts: ResolveOptions,
): Promise<PrContext> {
  const isCI = !!process.env.CI;
  const token = await resolveToken();

  // 1. Explicit PR URL wins.
  if (opts.prUrl) {
    const m = PR_URL_RE.exec(opts.prUrl.trim());
    if (!m) {
      throw new Error(
        `Could not parse --pr-url "${opts.prUrl}". ` +
          'Expected a URL like https://github.com/<owner>/<repo>/pull/<number>.',
      );
    }
    const [, owner, repo, num] = m;
    const { isPrivate } = await repoMeta(owner, repo);
    return {
      owner,
      repo,
      prNumber: Number(num),
      prUrl: `https://github.com/${owner}/${repo}/pull/${num}`,
      isPrivate,
      isCI,
      token,
    };
  }

  // 2. Explicit --pr + --repo.
  if (opts.pr && opts.repo) {
    const rm = REPO_RE.exec(opts.repo.trim());
    if (!rm) {
      throw new Error(
        `Invalid --repo "${opts.repo}". Expected the form <owner>/<repo>.`,
      );
    }
    const prNumber = Number(opts.pr);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      throw new Error(`Invalid --pr "${opts.pr}". Expected a positive integer.`);
    }
    const [, owner, repo] = rm;
    const { isPrivate } = await repoMeta(owner, repo);
    return {
      owner,
      repo,
      prNumber,
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      isPrivate,
      isCI,
      token,
    };
  }

  // 3. Auto-detect from the current directory.
  const repoOut = await gh([
    'repo',
    'view',
    '--json',
    'owner,name,isPrivate,url',
  ]);
  let owner: string;
  let repo: string;
  let isPrivate: boolean;
  try {
    const parsed = JSON.parse(repoOut) as {
      owner?: { login?: string };
      name?: string;
      isPrivate?: boolean;
    };
    owner = parsed.owner?.login ?? '';
    repo = parsed.name ?? '';
    isPrivate = !!parsed.isPrivate;
  } catch {
    throw new Error('Could not read repository info from `gh repo view`.');
  }
  if (!owner || !repo) {
    throw new Error(
      'Could not determine the repository. Run inside a git repo or pass ' +
        '--repo <owner/repo> (and --pr <number> or --pr-url <url>).',
    );
  }

  let prNumber: number;
  let prUrl: string;
  try {
    const prOut = await gh(['pr', 'view', '--json', 'number,url']);
    const parsed = JSON.parse(prOut) as { number?: number; url?: string };
    if (!parsed.number) throw new Error('no PR');
    prNumber = parsed.number;
    prUrl = parsed.url ?? `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  } catch {
    throw new Error(
      'No pull request found for the current branch. ' +
        'Pass --pr <number> or --pr-url <url> to target a specific PR.',
    );
  }

  return { owner, repo, prNumber, prUrl, isPrivate, isCI, token };
}
