/**
 * "hidden-ref" upload strategy — same technique as enthus-appdev/gh-attach,
 * ported to TypeScript: files are committed straight into the Git Data API
 * under a ref (`refs/uploads/pr/<N>`) that lives outside `refs/heads/*`, so
 * it never shows up in the Branches UI and never triggers workflows.
 *
 * Every GitHub call goes through `gh api` via `execFile` (never a shell, and
 * never a direct fetch) so authentication stays entirely `gh`'s problem and
 * no token ever needs to be read, logged, or interpolated into a string.
 */

import { readFile } from 'node:fs/promises';
import type { MediaFile, PrContext, UploadResult, UploadStrategy } from '../types.js';
import { StrategyError } from '../types.js';
import { describeGhError, hasGhAuth, runGh, toMarkdown } from '../gh.js';

/**
 * Blob content above this size (raw bytes, before base64 inflation) is sent
 * as a JSON body on stdin (`--input -`) instead of as a `-f content=...`
 * argv field, so we never risk exceeding the OS argv/env size limit.
 */
const ARGV_SAFE_BYTES = 100 * 1024;

function isNotFoundError(err: unknown): boolean {
  const e = err as { stderr?: string };
  const stderr = (e.stderr ?? '').toLowerCase();
  return stderr.includes('404') || stderr.includes('not found');
}

function refPath(prNumber: number): string {
  return `uploads/pr/${prNumber}`;
}

/** Reads the current tip commit of the hidden ref, or null if it doesn't exist yet. */
async function readExistingRef(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<{ commitSha: string } | null> {
  try {
    // Note: GitHub's "get a single ref" endpoint uses the singular "git/ref/..."
    // (plural "git/refs/..." is used for create/update/delete/list).
    const { stdout } = await runGh(['api', `repos/${owner}/${repo}/git/ref/${refPath(prNumber)}`]);
    const parsed = JSON.parse(stdout) as { object?: { sha?: string } };
    return parsed.object?.sha ? { commitSha: parsed.object.sha } : null;
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') throw err;
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

async function getCommitTreeSha(owner: string, repo: string, commitSha: string): Promise<string> {
  const { stdout } = await runGh(['api', `repos/${owner}/${repo}/git/commits/${commitSha}`]);
  const parsed = JSON.parse(stdout) as { tree?: { sha?: string } };
  if (!parsed.tree?.sha) {
    throw new Error(`\`gh api\` did not return a tree sha for commit ${commitSha}.`);
  }
  return parsed.tree.sha;
}

async function createBlob(owner: string, repo: string, file: MediaFile): Promise<string> {
  const data = await readFile(file.path);
  const base64 = data.toString('base64');
  const endpoint = `repos/${owner}/${repo}/git/blobs`;

  const { stdout } =
    data.byteLength > ARGV_SAFE_BYTES
      ? await runGh(['api', endpoint, '-X', 'POST', '--input', '-'], {
          stdin: JSON.stringify({ encoding: 'base64', content: base64 }),
        })
      : await runGh(['api', endpoint, '-X', 'POST', '-f', 'encoding=base64', '-f', `content=${base64}`]);

  const parsed = JSON.parse(stdout) as { sha?: string };
  if (!parsed.sha) {
    throw new Error(`\`gh api\` did not return a blob sha for "${file.name}".`);
  }
  return parsed.sha;
}

interface TreeEntry {
  path: string;
  sha: string;
}

async function createTree(
  owner: string,
  repo: string,
  baseTreeSha: string | undefined,
  entries: TreeEntry[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    tree: entries.map((entry) => ({
      path: entry.path,
      mode: '100644',
      type: 'blob',
      sha: entry.sha,
    })),
  };
  if (baseTreeSha) payload.base_tree = baseTreeSha;

  const { stdout } = await runGh(
    ['api', `repos/${owner}/${repo}/git/trees`, '-X', 'POST', '--input', '-'],
    { stdin: JSON.stringify(payload) },
  );
  const parsed = JSON.parse(stdout) as { sha?: string };
  if (!parsed.sha) throw new Error('`gh api` did not return a tree sha.');
  return parsed.sha;
}

async function createCommit(
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string | undefined,
): Promise<string> {
  const payload: Record<string, unknown> = {
    message,
    tree: treeSha,
    parents: parentSha ? [parentSha] : [],
  };
  const { stdout } = await runGh(
    ['api', `repos/${owner}/${repo}/git/commits`, '-X', 'POST', '--input', '-'],
    { stdin: JSON.stringify(payload) },
  );
  const parsed = JSON.parse(stdout) as { sha?: string };
  if (!parsed.sha) throw new Error('`gh api` did not return a commit sha.');
  return parsed.sha;
}

async function upsertRef(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  refAlreadyExists: boolean,
): Promise<void> {
  if (refAlreadyExists) {
    // NOTE: last-writer-wins. The PATCH is a force update with no
    // compare-and-swap (the API supports `force` but not an expected-old-sha
    // precondition here), so two runs racing on the SAME PR can interleave:
    // both read the same parent, each commits on top of it, and whichever
    // PATCHes second overwrites the ref — dropping the other run's blob(s)
    // from the ref history. Assets already uploaded as blobs are not lost
    // (they are content-addressed and still referenced by the emitted URLs),
    // but the ref tree ends up missing one run's files. Concurrent uploads to
    // the same PR are expected to be rare; if that changes, add a retry loop
    // that re-reads the ref and rebuilds the tree on 422/conflict.
    await runGh(
      ['api', `repos/${owner}/${repo}/git/refs/${refPath(prNumber)}`, '-X', 'PATCH', '--input', '-'],
      { stdin: JSON.stringify({ sha: commitSha, force: true }) },
    );
  } else {
    await runGh(
      ['api', `repos/${owner}/${repo}/git/refs`, '-X', 'POST', '--input', '-'],
      { stdin: JSON.stringify({ ref: `refs/${refPath(prNumber)}`, sha: commitSha }) },
    );
  }
}

export const hiddenRefStrategy: UploadStrategy = {
  name: 'hidden-ref',
  isAvailable: hasGhAuth,

  async upload(files: MediaFile[], ctx: PrContext): Promise<UploadResult[]> {
    try {
      const existing = await readExistingRef(ctx.owner, ctx.repo, ctx.prNumber);
      const parentSha = existing?.commitSha;
      const baseTreeSha = existing
        ? await getCommitTreeSha(ctx.owner, ctx.repo, existing.commitSha)
        : undefined;

      const blobEntries: TreeEntry[] = [];
      for (const file of files) {
        const sha = await createBlob(ctx.owner, ctx.repo, file);
        blobEntries.push({ path: file.name, sha });
      }

      const treeSha = await createTree(ctx.owner, ctx.repo, baseTreeSha, blobEntries);
      const message = `Media assets for PR #${ctx.prNumber} (uploaded by pr-media)`;
      const commitSha = await createCommit(ctx.owner, ctx.repo, message, treeSha, parentSha);
      await upsertRef(ctx.owner, ctx.repo, ctx.prNumber, commitSha, existing !== null);

      return files.map((file) => {
        const url = `https://github.com/${ctx.owner}/${ctx.repo}/blob/${commitSha}/${file.name}?raw=true`;
        return {
          file,
          url,
          markdown: toMarkdown(file, url),
          strategy: 'hidden-ref',
        };
      });
    } catch (err) {
      if (err instanceof StrategyError) throw err;
      throw new StrategyError('hidden-ref', describeGhError(err), err);
    }
  },
};
