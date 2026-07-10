#!/usr/bin/env node
/**
 * pr-media CLI entrypoint.
 *
 * Commands:
 *   pr-media add [files...]   Upload media and embed it in a PR.
 *   pr-media cleanup          Delete the hidden upload ref for a PR.
 *
 * Expected errors are printed as a single readable line to stderr and exit
 * with code 1 — no raw stack traces.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command } from 'commander';
import type { StrategyName } from './types.js';
import { resolvePrContext } from './context.js';
import { validateFiles } from './validate.js';
import { selectAndUpload } from './strategies/select.js';
import { embedInPr, buildMarkdown } from './embed.js';

const execFileAsync = promisify(execFile);

const VALID_STRATEGIES: readonly (StrategyName | 'auto')[] = [
  'auto',
  'browser',
  'hidden-ref',
  'release',
];

const VALID_TARGETS = ['description', 'comment'] as const;
type Target = (typeof VALID_TARGETS)[number];

interface AddOptions {
  pr?: string;
  prUrl?: string;
  repo?: string;
  strategy: string;
  to: string;
  json?: boolean;
  dryRun?: boolean;
}

interface CleanupOptions {
  pr?: string;
  repo?: string;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function runAdd(files: string[], opts: AddOptions): Promise<void> {
  if (files.length === 0) {
    fail('No files provided. Usage: pr-media add <file...>');
  }

  const strategy = opts.strategy as StrategyName | 'auto';
  if (!VALID_STRATEGIES.includes(strategy)) {
    fail(
      `Invalid --strategy "${opts.strategy}". ` +
        `Choose one of: ${VALID_STRATEGIES.join(', ')}.`,
    );
  }

  const to = opts.to as Target;
  if (!VALID_TARGETS.includes(to)) {
    fail(
      `Invalid --to "${opts.to}". Choose one of: ${VALID_TARGETS.join(', ')}.`,
    );
  }

  const ctx = await resolvePrContext({
    pr: opts.pr,
    prUrl: opts.prUrl,
    repo: opts.repo,
  });

  const media = await validateFiles(files);

  if (opts.dryRun) {
    // Show what would happen without uploading or embedding.
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          {
            dryRun: true,
            pr: {
              owner: ctx.owner,
              repo: ctx.repo,
              number: ctx.prNumber,
              url: ctx.prUrl,
            },
            strategy,
            to,
            files: media.map((m) => ({
              name: m.name,
              path: m.path,
              mime: m.mime,
              size: m.size,
            })),
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stdout.write(
        `Dry run — would upload ${media.length} file(s) to PR #${ctx.prNumber} ` +
          `(${ctx.owner}/${ctx.repo}) via strategy "${strategy}", embedding as ${to}:\n`,
      );
      for (const m of media) {
        process.stdout.write(`  - ${m.name} (${m.mime}, ${m.size} bytes)\n`);
      }
    }
    return;
  }

  const results = await selectAndUpload(media, ctx, strategy);
  await embedInPr(results, ctx, to);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        results.map((r) => ({
          name: r.file.name,
          url: r.url,
          markdown: r.markdown,
          strategy: r.strategy,
        })),
        null,
        2,
      ) + '\n',
    );
  } else {
    process.stdout.write(buildMarkdown(results) + '\n');
  }
}

async function runCleanup(opts: CleanupOptions): Promise<void> {
  const ctx = await resolvePrContext({ pr: opts.pr, repo: opts.repo });
  const ref = `uploads/pr/${ctx.prNumber}`;
  try {
    await execFileAsync('gh', [
      'api',
      '--method',
      'DELETE',
      `repos/${ctx.owner}/${ctx.repo}/git/refs/${ref}`,
    ]);
    process.stdout.write(
      `Deleted ref refs/${ref} in ${ctx.owner}/${ctx.repo}.\n`,
    );
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') {
      fail('The GitHub CLI (`gh`) is not installed or not on PATH.');
    }
    const stderr = (e.stderr ?? '').toLowerCase();
    if (stderr.includes('not found') || stderr.includes('404')) {
      process.stdout.write(
        `No ref refs/${ref} found — nothing to clean up.\n`,
      );
      return;
    }
    fail(`Failed to delete ref refs/${ref}: ${e.stderr?.trim() || e.message}`);
  }
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('pr-media')
    .description('Upload images/GIFs into GitHub pull requests.')
    .version('0.1.0');

  program
    .command('add')
    .description('Upload media files and embed them in a pull request.')
    .argument('[files...]', 'paths to image/GIF/video files to upload')
    .option('--pr <number>', 'target PR number')
    .option('--pr-url <url>', 'target PR URL (github.com/<o>/<r>/pull/<n>)')
    .option('--repo <owner/repo>', 'target repository')
    .option(
      '--strategy <name>',
      'upload strategy: auto|browser|hidden-ref|release',
      'auto',
    )
    .option('--to <target>', 'embed target: description|comment', 'comment')
    .option('--json', 'print results as JSON')
    .option('--dry-run', 'show what would happen without uploading')
    .action(async (files: string[], opts: AddOptions) => {
      await runAdd(files, opts);
    });

  program
    .command('cleanup')
    .description('Delete the hidden upload ref (refs/uploads/pr/<N>) for a PR.')
    .option('--pr <number>', 'target PR number')
    .option('--repo <owner/repo>', 'target repository')
    .action(async (opts: CleanupOptions) => {
      await runCleanup(opts);
    });

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(message);
});
