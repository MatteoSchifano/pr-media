/**
 * The "browser" upload strategy.
 *
 * Produces canonical `github.com/user-attachments/assets/<uuid>` URLs, which
 * can only be minted by GitHub's web upload flow (endpoint
 * `github.com/upload/policies/assets`, session-cookie only — a PAT gets 422).
 *
 * We never touch the cookie store. Instead we drive the user's REAL, already
 * logged-in browser and use the PR comment textarea as a staging area: drop a
 * file on the comment file-input, let GitHub upload it and insert the asset
 * markdown into the textarea, read the URL back out, then clear the textarea
 * WITHOUT ever submitting the comment. The real comment is posted elsewhere
 * (via `gh api`).
 *
 * Two backends are tried in order:
 *   1. the `agent-browser` CLI (uses its own persistent, logged-in profile);
 *   2. `playwright-core` over CDP against the user's Chrome
 *      (`chromium.connectOverCDP`).
 *
 * Hard rules:
 *   - NEVER read, copy or persist session credentials of any kind (no access
 *     to the browser's stored credentials, no Playwright cookie APIs).
 *   - NEVER submit the comment from the browser.
 *   - Every failure throws `StrategyError('browser', ...)` so the caller can
 *     fall back to another strategy.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  StrategyError,
  type MediaFile,
  type PrContext,
  type UploadResult,
  type UploadStrategy,
} from '../types.js';
import { toMarkdown } from '../gh.js';

const execFileAsync = promisify(execFile);

/**
 * Comment textarea selectors, in priority order. Covers the classic server
 * rendered PR page (`#new_comment_field`) and the newer React experience
 * (an aria-labelled Markdown textarea inside the new-comment form).
 */
const TEXTAREA_SELECTORS = [
  '#new_comment_field',
  'textarea[name="comment[body]"]',
  'textarea[aria-label*="Markdown" i]',
  'textarea[aria-label*="comment" i]',
  'form[id*="new_comment"] textarea',
] as const;

/**
 * File-input selectors for the comment composer, in priority order. On GitHub
 * the input lives inside a `<file-attachment>` element wired to the textarea;
 * the classic id is `#fc-new_comment_field`. `input[type=file]` is the last
 * resort catch-all.
 */
const FILE_INPUT_SELECTORS = [
  '#fc-new_comment_field',
  'file-attachment input[type="file"]',
  'input#fc-new_comment_field',
  'form[id*="new_comment"] input[type="file"]',
  'input[type="file"]',
] as const;

/** If any of these is present we are on a login/session wall. */
const LOGIN_SELECTORS = [
  'input#login_field',
  'input[name="login"][type="text"]',
  'input[name="password"][type="password"]',
] as const;

/** Extracts every asset URL GitHub may insert (images -> assets, files -> files). */
const ASSET_URL_RE =
  /https?:\/\/github\.com\/user-attachments\/(?:assets|files)\/[^\s)"'<>\]]+/g;
/** Cheap "is it ready yet?" probe used while polling the textarea value. */
const ASSET_READY_RE = /user-attachments\/(?:assets|files)\//;

/** GIFs and large media can be slow; allow generous per-file budget. */
const PER_FILE_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_CDP_URL = 'http://localhost:9222';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Markdown for a `user-attachments` asset. Images/GIFs → `![name](url)`.
 * Videos (mp4/mov/webm) → the BARE URL on its own line: GitHub renders a
 * `user-attachments` video URL inline as a native player only when it stands
 * alone. A `[name](url)` link (or a `<video>` tag, which GitHub sanitizes for
 * these URLs) would render as a plain link with no inline player, so we must
 * emit the bare URL here. `buildMarkdown` already puts each result on its own
 * line. See {@link toMarkdown} in ../gh.ts for the shared logic.
 */
function embedMarkdown(file: MediaFile, url: string): string {
  return toMarkdown(file, url, 'bare-url');
}

/** First asset URL found in a textarea value, or `undefined`. */
function firstAssetUrl(value: string): string | undefined {
  const matches = value.match(ASSET_URL_RE);
  return matches?.[0];
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ---------------------------------------------------------------------------
// Shared page-side JS (used verbatim by agent-browser `eval` and, in spirit,
// by the playwright evaluate calls).
// ---------------------------------------------------------------------------

/** Returns "LOGIN" when a sign-in wall is detected, otherwise "OK". */
function loginCheckJs(): string {
  return `(() => {
    const L = ${JSON.stringify(LOGIN_SELECTORS)};
    for (const s of L) if (document.querySelector(s)) return 'LOGIN';
    if (/^\\/(login|session)/.test(location.pathname)) return 'LOGIN';
    return 'OK';
  })()`;
}

/** Returns "FOUND" when a comment textarea exists, otherwise "MISSING". */
function ensureTextareaJs(): string {
  return `(() => {
    const S = ${JSON.stringify(TEXTAREA_SELECTORS)};
    for (const s of S) if (document.querySelector(s)) return 'FOUND';
    return 'MISSING';
  })()`;
}

/** Returns the value of the first matching comment textarea (or ""). */
function readTextareaJs(): string {
  return `(() => {
    const S = ${JSON.stringify(TEXTAREA_SELECTORS)};
    for (const s of S) { const el = document.querySelector(s); if (el) return el.value || ''; }
    return '';
  })()`;
}

/**
 * Clears the comment textarea using the native value setter so React-controlled
 * inputs also register the change. Never submits anything.
 */
function clearTextareaJs(): string {
  return `(() => {
    const S = ${JSON.stringify(TEXTAREA_SELECTORS)};
    for (const s of S) {
      const el = document.querySelector(s);
      if (!el) continue;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'CLEARED';
    }
    return 'NOTFOUND';
  })()`;
}

// ---------------------------------------------------------------------------
// Availability probes
// ---------------------------------------------------------------------------

async function agentBrowserAvailable(): Promise<boolean> {
  try {
    await execFileAsync('agent-browser', ['--help'], { timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** HTTP base for the CDP debugging endpoint (accepts ws:// or http:// input). */
function cdpHttpBase(cdpUrl: string): string {
  return cdpUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
}

/** Cheap ~2s probe: does a CDP debugger answer at the configured endpoint? */
async function cdpReachable(cdpUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${cdpHttpBase(cdpUrl)}/json/version`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Backend 1: agent-browser CLI
// ---------------------------------------------------------------------------

/** Runs an agent-browser subcommand; throws on non-zero exit. */
async function runAgentBrowser(
  args: string[],
  timeout: number,
): Promise<string> {
  const { stdout } = await execFileAsync('agent-browser', args, { timeout });
  return stdout;
}

/** Runs page-side JS via `eval -b <base64>` and returns raw (JSON) stdout. */
async function evalAgentBrowser(js: string, timeout = 15_000): Promise<string> {
  const b64 = Buffer.from(js, 'utf8').toString('base64');
  return runAgentBrowser(['eval', '-b', b64], timeout);
}

/** Sets files on the comment input, trying each candidate selector in order. */
async function uploadFileAgentBrowser(path: string): Promise<void> {
  let lastErr: unknown;
  for (const sel of FILE_INPUT_SELECTORS) {
    try {
      await runAgentBrowser(['upload', sel, path], 30_000);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new StrategyError(
    'browser',
    'could not find the PR comment file input (tried all known selectors)',
    lastErr,
  );
}

async function uploadViaAgentBrowser(
  files: MediaFile[],
  ctx: PrContext,
): Promise<UploadResult[]> {
  try {
    await runAgentBrowser(['open', ctx.prUrl], 60_000);

    if ((await evalAgentBrowser(loginCheckJs())).includes('LOGIN')) {
      throw new StrategyError(
        'browser',
        "agent-browser's browser is not logged into GitHub. Open a GitHub " +
          'page with `agent-browser open https://github.com/login`, sign in ' +
          'once (agent-browser keeps its own session), then retry.',
      );
    }

    if ((await evalAgentBrowser(ensureTextareaJs())).includes('MISSING')) {
      // Give a lazy React composer a moment, then re-check once.
      await sleep(2_000);
      if ((await evalAgentBrowser(ensureTextareaJs())).includes('MISSING')) {
        throw new StrategyError(
          'browser',
          'could not find the PR comment textarea on the page',
        );
      }
    }

    const results: UploadResult[] = [];
    for (const file of files) {
      await evalAgentBrowser(clearTextareaJs());
      await uploadFileAgentBrowser(file.path);

      const url = await pollForAssetAgentBrowser(file);
      results.push({
        file,
        url,
        markdown: embedMarkdown(file, url),
        strategy: 'browser',
      });

      // Leave the staging area pristine — never submit.
      await evalAgentBrowser(clearTextareaJs());
    }
    return results;
  } catch (err) {
    if (err instanceof StrategyError) throw err;
    throw new StrategyError(
      'browser',
      `agent-browser backend failed: ${describeError(err)}`,
      err,
    );
  } finally {
    // Best-effort teardown of agent-browser's own session.
    try {
      await runAgentBrowser(['close'], 10_000);
    } catch {
      /* ignore */
    }
  }
}

/** Polls the textarea value until GitHub inserts the asset URL, or times out. */
async function pollForAssetAgentBrowser(file: MediaFile): Promise<string> {
  const deadline = Date.now() + PER_FILE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const out = await evalAgentBrowser(readTextareaJs());
    if (ASSET_READY_RE.test(out)) {
      const url = firstAssetUrl(out);
      if (url) return url;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new StrategyError(
    'browser',
    `timed out after ${PER_FILE_TIMEOUT_MS / 1_000}s waiting for GitHub to ` +
      `finish uploading ${file.name}`,
  );
}

// ---------------------------------------------------------------------------
// Backend 2: playwright-core over CDP
// ---------------------------------------------------------------------------

async function uploadViaCdp(
  files: MediaFile[],
  ctx: PrContext,
): Promise<UploadResult[]> {
  let playwright: typeof import('playwright-core');
  try {
    playwright = await import('playwright-core');
  } catch (err) {
    throw new StrategyError(
      'browser',
      'playwright-core is not installed. Install it with ' +
        '`npm install playwright-core` to enable the CDP browser backend.',
      err,
    );
  }

  const cdpUrl = process.env.PR_MEDIA_CDP_URL || DEFAULT_CDP_URL;

  let browser: import('playwright-core').Browser;
  try {
    browser = await playwright.chromium.connectOverCDP(cdpUrl);
  } catch (err) {
    throw new StrategyError(
      'browser',
      `could not connect to Chrome over CDP at ${cdpUrl}. Start Chrome using ` +
        'YOUR normal profile with remote debugging enabled so this reuses your ' +
        'logged-in GitHub session, e.g.:\n' +
        '  "Google Chrome" --remote-debugging-port=9222 ' +
        '--user-data-dir="$HOME/Library/Application Support/Google/Chrome"\n' +
        'Override the endpoint with the PR_MEDIA_CDP_URL env var.',
      err,
    );
  }

  let page: import('playwright-core').Page | undefined;
  try {
    // Reuse the first EXISTING context (carries the user's session); never
    // enumerate cookies.
    const context = browser.contexts()[0];
    if (!context) {
      throw new StrategyError(
        'browser',
        'no existing browser context found over CDP — is a normal Chrome ' +
          'window open in the debugged instance?',
      );
    }

    page = await context.newPage();
    await page.goto(ctx.prUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    const loggedOut = await page.evaluate((selectors) => {
      for (const s of selectors) if (document.querySelector(s)) return true;
      return /^\/(login|session)/.test(location.pathname);
    }, LOGIN_SELECTORS as unknown as string[]);
    if (loggedOut) {
      throw new StrategyError(
        'browser',
        'the connected browser is not logged into GitHub. Sign in there and ' +
          'retry.',
      );
    }

    try {
      await page.waitForFunction(
        (selectors) => selectors.some((s) => document.querySelector(s)),
        TEXTAREA_SELECTORS as unknown as string[],
        { timeout: 15_000 },
      );
    } catch (err) {
      throw new StrategyError(
        'browser',
        'could not find the PR comment textarea on the page',
        err,
      );
    }

    const results: UploadResult[] = [];
    for (const file of files) {
      await clearTextareaCdp(page);

      const inputSel = await page.evaluate((selectors) => {
        for (const s of selectors) if (document.querySelector(s)) return s;
        return null;
      }, FILE_INPUT_SELECTORS as unknown as string[]);
      if (!inputSel) {
        throw new StrategyError(
          'browser',
          'could not find the PR comment file input (tried all known selectors)',
        );
      }

      // setInputFiles works on hidden inputs and dispatches the change event
      // GitHub's <file-attachment> listens for.
      await page.locator(inputSel).first().setInputFiles(file.path);

      try {
        await page.waitForFunction(
          ({ selectors, readyRe }) => {
            const el = selectors
              .map((s) => document.querySelector(s))
              .find(Boolean) as HTMLTextAreaElement | undefined;
            return !!el && new RegExp(readyRe).test(el.value);
          },
          {
            selectors: TEXTAREA_SELECTORS as unknown as string[],
            readyRe: ASSET_READY_RE.source,
          },
          { timeout: PER_FILE_TIMEOUT_MS, polling: 500 },
        );
      } catch (err) {
        throw new StrategyError(
          'browser',
          `timed out after ${PER_FILE_TIMEOUT_MS / 1_000}s waiting for GitHub ` +
            `to finish uploading ${file.name}`,
          err,
        );
      }

      const value = await readTextareaCdp(page);
      const url = firstAssetUrl(value);
      if (!url) {
        throw new StrategyError(
          'browser',
          `no asset URL found in the textarea after uploading ${file.name}`,
        );
      }

      results.push({
        file,
        url,
        markdown: embedMarkdown(file, url),
        strategy: 'browser',
      });

      await clearTextareaCdp(page);
    }
    return results;
  } catch (err) {
    if (err instanceof StrategyError) throw err;
    throw new StrategyError(
      'browser',
      `CDP backend failed: ${describeError(err)}`,
      err,
    );
  } finally {
    // Close ONLY the page we opened. NEVER close the user's browser.
    if (page) {
      try {
        await page.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function readTextareaCdp(
  page: import('playwright-core').Page,
): Promise<string> {
  return page.evaluate((selectors) => {
    for (const s of selectors) {
      const el = document.querySelector(s) as HTMLTextAreaElement | null;
      if (el) return el.value || '';
    }
    return '';
  }, TEXTAREA_SELECTORS as unknown as string[]);
}

async function clearTextareaCdp(
  page: import('playwright-core').Page,
): Promise<void> {
  await page.evaluate((selectors) => {
    for (const s of selectors) {
      const el = document.querySelector(s) as HTMLTextAreaElement | null;
      if (!el) continue;
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
  }, TEXTAREA_SELECTORS as unknown as string[]);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

export const browserStrategy: UploadStrategy = {
  name: 'browser',

  async isAvailable(ctx: PrContext): Promise<boolean> {
    const cdpUrl = process.env.PR_MEDIA_CDP_URL;

    // In CI there is no interactive, logged-in browser unless the user has
    // explicitly wired up a CDP endpoint.
    if (ctx.isCI) {
      return cdpUrl ? cdpReachable(cdpUrl) : false;
    }

    if (await agentBrowserAvailable()) return true;
    return cdpReachable(cdpUrl || DEFAULT_CDP_URL);
  },

  async upload(files: MediaFile[], ctx: PrContext): Promise<UploadResult[]> {
    if (files.length === 0) return [];

    const failures: string[] = [];

    if (await agentBrowserAvailable()) {
      try {
        return await uploadViaAgentBrowser(files, ctx);
      } catch (err) {
        failures.push(describeError(err));
      }
    }

    try {
      return await uploadViaCdp(files, ctx);
    } catch (err) {
      failures.push(describeError(err));
      throw new StrategyError(
        'browser',
        `all browser backends failed:\n- ${failures.join('\n- ')}`,
        err,
      );
    }
  },
};
