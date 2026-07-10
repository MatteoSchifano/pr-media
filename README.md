# pr-media

[![CI](https://github.com/OWNER/pr-media/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/pr-media/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Upload images, GIFs, and short videos into GitHub pull requests from the
command line — no browser session cookies, no scraping, no private API.

```
pr-media add screenshot.png before-after.gif --pr-url https://github.com/acme/widgets/pull/42
```

## Why

GitHub's web UI can attach an image to a PR comment and give you back a
`github.com/user-attachments/assets/<uuid>` URL — but **there is no public
GitHub API for minting that URL.** The endpoint behind it
(`github.com/upload/policies/assets`) only accepts a browser session cookie;
a personal access token gets a `422`. That's a deliberate anti-abuse
restriction, not an oversight.

Tools that work around this by extracting your browser's session cookie and
replaying it against that endpoint (the approach used by, e.g., `gh-image`
and similar cookie-based uploaders) are **insecure by construction**:

- A session cookie is a bearer credential for your *entire* GitHub account —
  not scoped to a repo, an action, or an expiry window like a PAT or `gh`
  token is. Anything that reads it can do anything you can do on github.com.
- Cookies typically end up copied out of the browser's cookie store (via
  DevTools protocol, a browser extension, or a local SQLite file) and passed
  around as plaintext, in shell history, in logs, or in a temp file — any of
  which is an exfiltration path a scoped token doesn't create.
- They're brittle: GitHub can invalidate or reshape session cookies at any
  time with no compatibility guarantee, unlike its versioned, documented
  APIs.

pr-media never touches a cookie store, never calls `context.cookies()`
equivalents, and never reads a session cookie from disk. It offers three
different strategies, each with an honest tradeoff, so you can pick the one
that matches your security posture instead of being handed one insecure
default:

| Strategy     | Auth                                        | Produced URL                                             | Privacy                                              | When to use it |
|--------------|----------------------------------------------|------------------------------------------------------------|-------------------------------------------------------|----------------|
| `browser`    | Drives **your own, already-logged-in** browser (via `agent-browser` or Chrome DevTools Protocol) — never reads its cookies | Canonical `github.com/user-attachments/assets/<uuid>` | Inherits the PR's visibility (GitHub's own attachment ACL) | Local/interactive use when you want the exact same URL the GitHub web UI would produce |
| `hidden-ref` | `gh` CLI token (scoped PAT / OAuth token), via the Git Data API | `github.com/<owner>/<repo>/blob/<sha>/<file>?raw=true` | Inherits the **repo's** visibility (private repo → URL requires repo access) | Default for most workflows, including CI, without needing an interactive browser |
| `release`    | `gh` CLI token, via a dedicated prerelease's assets | Release asset URL (`github.com/<owner>/<repo>/releases/download/...`) | **Always public**, even in a private repo — GitHub release assets have no separate ACL | CI on public repos, or anywhere you explicitly want a public, cacheable URL |

`browser` never touches a cookie jar: it opens the PR page in a real,
already-authenticated browser session you control, drops the file on the
comment composer's file input (the same drag-and-drop flow a human uses),
reads the resulting asset URL back out of the textarea, then clears the
textarea **without ever submitting the comment**. The actual PR comment is
posted separately, through `gh api`. `hidden-ref` and `release` never launch
a browser at all — they go through `gh`'s own authenticated API calls.

## Install

```bash
npm install -g pr-media
# or, without installing:
npx pr-media add ./shot.png --pr-url https://github.com/acme/widgets/pull/42
```

### Requirements

- [`gh`](https://cli.github.com), authenticated (`gh auth login`). Every
  strategy except the interactive `browser` backend relies on `gh` for
  authentication — pr-media never reads or stores a token itself beyond
  what `gh auth token` / `GITHUB_TOKEN` provide for the current process.
- For the `browser` strategy specifically, one of:
  - [`agent-browser`](https://www.npmjs.com/package/agent-browser) on
    `PATH`, with its own persistent, logged-in profile, **or**
  - a local Chrome/Chromium running with remote debugging enabled, e.g.:
    ```bash
    "Google Chrome" --remote-debugging-port=9222 \
      --user-data-dir="$HOME/Library/Application Support/Google/Chrome"
    ```
    (override the endpoint with `PR_MEDIA_CDP_URL` if it's not
    `http://localhost:9222`), plus the optional `playwright-core` dependency
    (`npm install playwright-core`).

### Install as a `gh` extension

```bash
gh extension install <owner>/pr-media
gh pr-media add ./shot.png --pr-url https://github.com/acme/widgets/pull/42
```

`gh` extensions are just a repo with an executable matching the repo name —
this repo ships [`gh-pr-media`](./gh-pr-media), which execs the built
`dist/cli.js` (falling back to `npx pr-media` if the extension checkout
hasn't been built).

## Usage

```bash
# Upload one or more files, auto-selecting a strategy, and post a new PR comment.
pr-media add screenshot.png demo.gif --pr-url https://github.com/acme/widgets/pull/42

# Target a PR by number + repo instead of a full URL.
pr-media add screenshot.png --pr 42 --repo acme/widgets

# Run from inside a checked-out branch with an open PR — no --pr needed.
pr-media add screenshot.png

# Force a specific strategy instead of the auto fallback chain.
pr-media add screenshot.png --pr-url <url> --strategy hidden-ref
pr-media add screenshot.png --pr-url <url> --strategy release
pr-media add screenshot.png --pr-url <url> --strategy browser

# Append to the PR description instead of posting a new comment.
pr-media add screenshot.png --pr-url <url> --to description

# See what would happen without uploading or touching the PR at all.
pr-media add screenshot.png demo.gif --pr-url <url> --dry-run

# Machine-readable output (uploaded URLs + generated markdown), e.g. for CI.
pr-media add screenshot.png --pr-url <url> --json --to comment

# Delete the hidden upload ref (refs/uploads/pr/<N>) for a PR once you're done with it.
pr-media cleanup --pr 42 --repo acme/widgets
```

### `auto` strategy order

With `--strategy auto` (the default), pr-media tries strategies in this
order, falling back to the next on failure:

1. Outside CI: `browser` → `hidden-ref` → `release`.
2. In CI: `browser` is moved to the end (there's no interactive, logged-in
   browser in most CI runners unless you've wired up `PR_MEDIA_CDP_URL`
   yourself) — so `hidden-ref` → `release` → `browser`.
3. In CI **and** the repo is public: `release` is tried first (cheap, robust,
   no privacy tradeoff since the repo is already public) —
   `release` → `hidden-ref` → `browser`.

### GitHub Action: automatic cleanup

[`action-cleanup/`](./action-cleanup) ships a composite GitHub Action that
deletes the `hidden-ref` upload ref and the `release` prerelease for a PR
once it's closed, so merged/closed PRs don't leave upload artifacts behind:

```yaml
# .github/workflows/pr-media-cleanup.yml
name: pr-media cleanup
on:
  pull_request:
    types: [closed]

jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: OWNER/pr-media/action-cleanup@main
```

Both deletions are best-effort: a missing ref or release (404) is not
treated as an error.

## Security model

- **Never cookies.** pr-media never reads, copies, or persists a browser
  session cookie, and never calls a cookie-store API. The `browser` strategy
  drives your real browser through its own automation surface
  (`agent-browser` or CDP) — it reads whatever is already rendered in the
  page, not the cookie jar behind it.
- **Only scoped, `gh`-managed tokens.** Every non-interactive call goes
  through the `gh` CLI (`gh api`, `gh release`, `gh pr`, `gh repo`), so
  authentication is entirely `gh`'s problem: whatever scoped PAT or OAuth
  token you've authenticated `gh` with (or `GITHUB_TOKEN` in CI) is what's
  used. pr-media itself never writes a token to disk or logs it.
- **`execFile`, never a shell.** Every external command (`gh`, `agent-browser`)
  is invoked via `execFile` with arguments passed as an argv array — never
  through a shell string — so file paths, PR URLs, and repo names can't be
  used for command injection.
- **The browser strategy never submits anything.** It only stages a file on
  the PR comment's file input to let GitHub's own upload endpoint mint the
  URL, reads that URL back out of the textarea, and clears the textarea
  again. It never clicks "Comment", never closes the user's browser window,
  and only reuses an *existing* browser context — it does not create or
  configure one.
- **What this tool does *not* do:** it does not store credentials of its
  own, does not scrape or reverse-engineer any GitHub-internal API beyond
  the documented Git Data API and Releases API, and does not silently widen
  the visibility of anything (`release` prints an explicit warning the first
  time it's used against a public repo, since release assets have no
  separate ACL from the repo's own visibility).

## Limitations

- `release` asset URLs are **always public**, regardless of the PR's or
  repo's own visibility — there's no per-asset ACL on GitHub releases. Don't
  use it for private/sensitive PRs; use `hidden-ref` or `browser` instead.
- `hidden-ref` URLs inherit the *repository's* visibility, not the PR's —
  fine for the common case (repo-private PRs), but not a substitute for a
  finer-grained ACL if you ever need one.
- `browser` requires a real, already-authenticated browser session on the
  machine running pr-media (either via `agent-browser`'s own profile or a
  Chrome instance with remote debugging enabled) — it is not meant for
  headless CI.
- File size limits mirror what GitHub's own web UI enforces: 10 MB for
  images, 100 MB for videos. Files are validated (size, extension, and — for
  PNG/JPEG/GIF/WebP — magic bytes) before anything is uploaded.
- Only these extensions are supported: `.png`, `.jpg`/`.jpeg`, `.gif`,
  `.webp`, `.svg`, `.mp4`, `.mov`, `.webm`.

## Contributing

Issues and PRs welcome. Before opening a PR:

```bash
npm ci
npm run build
npm test
```

Please keep the "never touch cookies" invariant intact — CI runs a
`security-guard` check that fails the build if cookie-related patterns show
up under `src/`.

## License

[MIT](./LICENSE) © 2026 Matteo Schifano
