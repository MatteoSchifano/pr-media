/**
 * Chooses an upload strategy and runs it, with an automatic fallback chain when
 * `auto` is requested. Strategies are provided by sibling modules (written by
 * other agents) and each implements the shared UploadStrategy contract.
 */

import type {
  MediaFile,
  PrContext,
  StrategyName,
  UploadResult,
  UploadStrategy,
} from '../types.js';
import { StrategyError } from '../types.js';
import { browserStrategy } from './browser.js';
import { hiddenRefStrategy } from './hidden-ref.js';
import { releaseStrategy } from './release.js';

const REGISTRY: Record<StrategyName, UploadStrategy> = {
  browser: browserStrategy,
  'hidden-ref': hiddenRefStrategy,
  release: releaseStrategy,
};

/**
 * Computes the ordered list of strategies to try for `auto`, tuned to the
 * environment:
 *  - Base preference: browser, hidden-ref, release.
 *  - In CI, the browser strategy is unreliable/interactive, so it goes last.
 *  - For a public repo in CI, releases are cheap and robust, so try release first.
 */
function autoOrder(ctx: PrContext): StrategyName[] {
  let order: StrategyName[] = ['browser', 'hidden-ref', 'release'];

  if (ctx.isCI) {
    // Move browser to the end.
    order = order.filter((s) => s !== 'browser');
    order.push('browser');

    // Public repo in CI: prefer release first.
    if (!ctx.isPrivate) {
      order = order.filter((s) => s !== 'release');
      order.unshift('release');
    }
  }

  return order;
}

export async function selectAndUpload(
  files: MediaFile[],
  ctx: PrContext,
  requested: StrategyName | 'auto',
): Promise<UploadResult[]> {
  // Specific strategy requested: use only that one.
  if (requested !== 'auto') {
    const strategy = REGISTRY[requested];
    if (!strategy) {
      throw new Error(`Unknown strategy "${requested}".`);
    }
    const available = await strategy.isAvailable(ctx);
    if (!available) {
      throw new Error(
        `Strategy "${requested}" is not available in this environment.`,
      );
    }
    return strategy.upload(files, ctx);
  }

  // Auto: try each available strategy in order, falling back on StrategyError.
  const order = autoOrder(ctx);
  const failures: string[] = [];
  let anyAvailable = false;

  for (const name of order) {
    const strategy = REGISTRY[name];
    let available = false;
    try {
      available = await strategy.isAvailable(ctx);
    } catch (err) {
      // Treat a broken availability check as "unavailable" and keep going.
      failures.push(`${name}: availability check failed (${errMsg(err)})`);
      continue;
    }
    if (!available) continue;

    anyAvailable = true;
    try {
      return await strategy.upload(files, ctx);
    } catch (err) {
      if (err instanceof StrategyError) {
        process.stderr.write(
          `warning: strategy "${name}" failed, trying next: ${err.message}\n`,
        );
        failures.push(`${name}: ${err.message}`);
        continue;
      }
      // Non-StrategyError: unexpected — do not swallow, surface immediately.
      throw err;
    }
  }

  if (!anyAvailable) {
    throw new Error(
      'No upload strategy is available in this environment. ' +
        'Ensure `gh` is authenticated' +
        (failures.length ? `:\n  - ${failures.join('\n  - ')}` : '.'),
    );
  }

  throw new Error(
    `All upload strategies failed:\n  - ${failures.join('\n  - ')}`,
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
