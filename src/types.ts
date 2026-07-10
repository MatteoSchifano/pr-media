/**
 * Shared contract for pr-media. All strategies and the CLI depend on these
 * types — do not change them without updating every strategy.
 */

export type StrategyName = 'browser' | 'hidden-ref' | 'release';

export interface MediaFile {
  /** Absolute, resolved path on disk (already validated). */
  path: string;
  /** Sanitized file name used in URLs/markdown. */
  name: string;
  /** Detected MIME type, e.g. "image/png", "image/gif". */
  mime: string;
  /** Size in bytes. */
  size: number;
}

export interface PrContext {
  owner: string;
  repo: string;
  prNumber: number;
  /** Full https URL of the PR. */
  prUrl: string;
  isPrivate: boolean;
  /** True when running in CI (process.env.CI). */
  isCI: boolean;
  /** Scoped token from `gh auth token` / GITHUB_TOKEN. Never a session cookie. */
  token?: string;
}

export interface UploadResult {
  file: MediaFile;
  /** The hosted URL for the uploaded asset. */
  url: string;
  /** Ready-to-embed markdown (image or video link). */
  markdown: string;
  strategy: StrategyName;
}

export interface UploadStrategy {
  name: StrategyName;
  /** Cheap check: can this strategy run in the current environment? */
  isAvailable(ctx: PrContext): Promise<boolean>;
  /** Upload all files; throws StrategyError on failure (enables fallback). */
  upload(files: MediaFile[], ctx: PrContext): Promise<UploadResult[]>;
}

export class StrategyError extends Error {
  constructor(
    public strategy: StrategyName,
    message: string,
    public cause?: unknown,
  ) {
    super(`[${strategy}] ${message}`);
    this.name = 'StrategyError';
  }
}
