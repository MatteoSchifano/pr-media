/**
 * "release" upload strategy — uploads files as assets of a dedicated
 * prerelease tagged `pr-<N>-media`, created (once) via `gh release create`
 * and then reused across the PR's lifetime via `gh release upload --clobber`.
 *
 * Every GitHub interaction goes through the `gh` binary via `execFile`
 * (never a shell, never a direct fetch), so `gh` remains solely responsible
 * for authentication and no token is ever read, logged, or interpolated.
 */

import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MediaFile, PrContext, UploadResult, UploadStrategy } from '../types.js';
import { StrategyError } from '../types.js';
import { describeGhError, hasGhAuth, runGh, toMarkdown } from '../gh.js';

function tagName(prNumber: number): string {
  return `pr-${prNumber}-media`;
}

async function releaseExists(owner: string, repo: string, tag: string): Promise<boolean> {
  try {
    await runGh(['release', 'view', tag, '-R', `${owner}/${repo}`]);
    return true;
  } catch {
    return false;
  }
}

async function createRelease(owner: string, repo: string, tag: string, prNumber: number): Promise<void> {
  await runGh([
    'release',
    'create',
    tag,
    '-R',
    `${owner}/${repo}`,
    '--prerelease',
    '--title',
    `Media assets for PR #${prNumber}`,
    '--notes',
    `Media assets for PR #${prNumber} (uploaded by pr-media)`,
  ]);
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

async function fetchReleaseAssets(owner: string, repo: string, tag: string): Promise<ReleaseAsset[]> {
  const { stdout } = await runGh(['api', `repos/${owner}/${repo}/releases/tags/${tag}`]);
  const parsed = JSON.parse(stdout) as { assets?: ReleaseAsset[] };
  return parsed.assets ?? [];
}

/**
 * `gh release upload` names each asset after the *actual* basename of the
 * file on disk, which may differ from our sanitized `MediaFile.name`. To
 * guarantee the asset name matches the sanitized name, each file is first
 * copied into a throwaway tempdir under its sanitized name and uploaded
 * from there; the tempdir is always removed afterwards.
 */
async function withStagedCopies<T>(
  files: MediaFile[],
  fn: (stagedPaths: string[]) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pr-media-release-'));
  try {
    const stagedPaths: string[] = [];
    for (const file of files) {
      const dest = path.join(dir, file.name);
      await copyFile(file.path, dest);
      stagedPaths.push(dest);
    }
    return await fn(stagedPaths);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const releaseStrategy: UploadStrategy = {
  name: 'release',
  isAvailable: hasGhAuth,

  async upload(files: MediaFile[], ctx: PrContext): Promise<UploadResult[]> {
    try {
      const tag = tagName(ctx.prNumber);
      const alreadyExisted = await releaseExists(ctx.owner, ctx.repo, tag);

      if (!alreadyExisted) {
        await createRelease(ctx.owner, ctx.repo, tag, ctx.prNumber);
        if (!ctx.isPrivate) {
          // First upload on a public repo: release asset URLs are public,
          // regardless of who can see the PR itself. Warn once, on stderr.
          process.stderr.write(
            `[pr-media] Warning: ${ctx.owner}/${ctx.repo} is a public repository — ` +
              `asset URLs on release "${tag}" are publicly accessible to anyone with the link.\n`,
          );
        }
      }

      await withStagedCopies(files, async (stagedPaths) => {
        await runGh([
          'release',
          'upload',
          tag,
          ...stagedPaths,
          '-R',
          `${ctx.owner}/${ctx.repo}`,
          '--clobber',
        ]);
      });

      const assets = await fetchReleaseAssets(ctx.owner, ctx.repo, tag);
      const assetByName = new Map(assets.map((asset) => [asset.name, asset]));

      return files.map((file) => {
        const asset = assetByName.get(file.name);
        if (!asset) {
          throw new StrategyError(
            'release',
            `Uploaded asset "${file.name}" was not found on release "${tag}" afterwards.`,
          );
        }
        const url = asset.browser_download_url;
        return {
          file,
          url,
          markdown: toMarkdown(file, url),
          strategy: 'release',
        };
      });
    } catch (err) {
      if (err instanceof StrategyError) throw err;
      throw new StrategyError('release', describeGhError(err), err);
    }
  },
};
