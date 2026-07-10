---
name: pr-media
description: Attach or embed images, GIFs, and short videos into a GitHub pull request (comment or description) from the command line using the cookie-free pr-media CLI. Use when asked to "attach this screenshot to the PR", "put the GIF in the pull request", "upload image to PR", "embed screenshot in PR description", or otherwise get media into a GitHub PR without pasting into the web UI.
---

# pr-media

`pr-media` is a TypeScript CLI that uploads images/GIFs/short videos into a
GitHub pull request and embeds the resulting markdown in a PR comment or in
the PR description. It never touches browser session cookies. It offers three
strategies with honest tradeoffs and an `auto` fallback chain.

## When to use

- The user wants a screenshot, GIF, or short video shown **inside a GitHub PR**
  (a comment or the PR description), not committed to the branch.
- You produced a screenshot/recording (e.g. of a UI change) and want to attach
  it to the PR you are working on.
- The repo is hosted on **GitHub** and the user is authenticated with `gh`.

## When NOT to use

- The file is **not media** (`.pdf`, `.zip`, `.txt`, source files, logs). This
  tool only accepts `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.svg`, `.mp4`,
  `.mov`, `.webm`. Attach non-media some other way.
- The repository is **not on GitHub** (GitLab, Bitbucket, etc.). pr-media is
  GitHub-only (it drives `gh` and GitHub APIs).
- You need to embed media in an **issue** or a **wiki** — pr-media targets PRs
  only.
- There is no open PR yet — create/open the PR first, then attach.

## Prerequisites (verify before running)

1. **`gh` authenticated** — every strategy except the interactive `browser`
   backend relies on it:
   ```bash
   gh auth status
   ```
   If it errors, tell the user to run `gh auth login`. Do not try to supply a
   token yourself.

2. **The `pr-media` CLI is reachable.** Check, in order:
   ```bash
   pr-media --version          # installed globally, or as a gh extension: gh pr-media --version
   npx pr-media --version      # fallback if published/resolvable
   ```
   If neither resolves, the CLI is not installed — point the user at the repo
   (`MatteoSchifano/pr-media`): `npm install -g pr-media`, or
   `gh extension install MatteoSchifano/pr-media` (then invoke `gh pr-media`),
   or build from source. This SKILL file only teaches *how* to drive the CLI;
   it does not bundle the CLI itself.

3. **For the `browser` strategy only**, one of:
   - `agent-browser` on `PATH` with its own persistent, already-logged-in
     GitHub profile, **or**
   - a local Chrome/Chromium started with `--remote-debugging-port=9222`
     against a profile already logged into GitHub (override the endpoint with
     `PR_MEDIA_CDP_URL`), plus the optional `playwright-core` dependency.

   You never need this for `hidden-ref` or `release`. If the browser backend is
   unavailable, `auto` silently skips it — do not try to set one up unasked.

## Recommended agent workflow

1. **Locate the PR.** If you are inside a checked-out branch that has an open
   PR, pr-media auto-detects it — pass no `--pr`/`--pr-url`. Otherwise pass
   `--pr-url <full url>`, or `--pr <number> --repo <owner>/<repo>`.
2. **Dry-run first** to validate the files and confirm the target, without
   uploading or touching the PR:
   ```bash
   pr-media add shot.png demo.gif --dry-run --json
   ```
   Parse the JSON; confirm every file is listed with the expected `mime`/`size`
   and the resolved PR is correct.
3. **Run for real with `--json`** and parse the output — an array of
   `{ name, url, markdown, strategy }`. Do not scrape human text.
4. **Verify the returned URLs.** They are the source of truth for what got
   embedded; surface them to the user. (`browser` yields
   `user-attachments/assets/...`; `hidden-ref` yields a `...blob/<sha>/...?raw=true`
   URL; `release` yields a `releases/download/...` URL.)
5. **Suggest cleanup when the PR closes.** `hidden-ref` and `release` leave a
   ref/prerelease behind. Recommend the user run
   `pr-media cleanup --pr <n> --repo <owner>/<repo>` when done, or wire up the
   `action-cleanup` GitHub Action (`on: pull_request: types: [closed]`) so it
   happens automatically.

## Choosing a strategy

Default to `auto` (omit `--strategy`) unless the user needs a specific URL
shape or privacy guarantee. `auto`'s order adapts to the environment: locally
`browser → hidden-ref → release`; in CI `hidden-ref → release → browser`; in CI
on a public repo `release → hidden-ref → browser`.

| Situation | Use | Why |
|-----------|-----|-----|
| Private repo, want it to stay private | `hidden-ref` or `browser` | Both inherit the repo's/PR's visibility. Never `release`. |
| Need the **exact** URL the GitHub web UI produces (`user-attachments/assets/…`) | `browser` | Only backend that mints canonical attachment URLs. Requires a logged-in local browser. |
| CI, or no interactive browser | `hidden-ref` | `gh`-token only, no browser needed. Default for automation on private repos. |
| CI on a **public** repo, or you explicitly want a public cacheable URL | `release` | Robust and cheap — but asset URLs are **always public**, even in a private repo. Warn the user. |

## Safety rules for the agent

- **Never attempt a session-cookie approach.** Do not read the browser cookie
  store, replay a session cookie, or reach for any cookie-based uploader as a
  "faster" path. The whole point of pr-media is that it never does this.
- **Do not fall back to committing the images into the PR branch** as a
  workaround without asking the user first. Binary blobs in the branch are a
  different, often unwanted, side effect.
- **Do not use `release` for sensitive/private content.** Release asset URLs
  have no per-asset ACL and are public even in a private repo. Prefer
  `hidden-ref` or `browser`, and pass on pr-media's public-repo warning to the
  user.
- **Let `auto` do the fallback.** Don't hardcode `browser` in a headless/CI
  context — it will just fail there. Reserve explicit `--strategy` for when the
  user has a real requirement.

## Examples

**1. Attach a screenshot to the current branch's PR (auto-detected).**
```bash
pr-media add screenshot.png --json
```
Expected `stdout` (JSON):
```json
[
  {
    "name": "screenshot.png",
    "url": "https://github.com/acme/widgets/blob/<sha>/screenshot.png?raw=true",
    "markdown": "![screenshot.png](https://github.com/acme/widgets/blob/<sha>/screenshot.png?raw=true)",
    "strategy": "hidden-ref"
  }
]
```
(The `url`/`strategy` vary with which strategy `auto` landed on.)

**2. Dry-run two files against an explicit PR URL, before uploading.**
```bash
pr-media add before.png after.gif --pr-url https://github.com/acme/widgets/pull/42 --dry-run --json
```
Expected `stdout` includes `"dryRun": true`, the resolved PR
(`owner`/`repo`/`number`/`url`), the chosen `strategy`/`to`, and a `files`
array with each `name`/`path`/`mime`/`size`. Nothing is uploaded and the PR is
untouched.

**3. Embed a GIF in the PR description with a forced strategy.**
```bash
pr-media add demo.gif --pr 42 --repo acme/widgets --strategy hidden-ref --to description
```
Appends the image markdown to the PR body and prints the markdown (or JSON with
`--json`).

**4. CI on a public repo — force the public release URL, knowing it is public.**
```bash
pr-media add coverage.png --pr-url "$PR_URL" --strategy release --json
```
Prints a stderr warning the first time on a public repo that the asset URL is
publicly accessible to anyone with the link. Only use when a public URL is
acceptable.

**5. Clean up the hidden upload ref once the PR is closed.**
```bash
pr-media cleanup --pr 42 --repo acme/widgets
```
Deletes `refs/uploads/pr/42`. A missing ref (404) is reported as "nothing to
clean up", not an error.

## Common errors and fixes

- **`gh` not authenticated** (`You are not authenticated with the GitHub CLI`):
  run `gh auth login`. pr-media never supplies a token itself.
- **`gh` not installed** (`The GitHub CLI (gh) is not installed or not on
  PATH`): install from https://cli.github.com.
- **No PR for the current branch** (`No pull request found for the current
  branch`): pass `--pr <n>` (with `--repo`) or `--pr-url <url>`.
- **Browser backend unavailable:** with `auto`, pr-media just skips `browser`
  and falls back to `hidden-ref`/`release` — no action needed. It only hard-
  fails if you *forced* `--strategy browser` with no logged-in browser; drop
  the flag or start a logged-in Chrome with `--remote-debugging-port`.
- **File too large / wrong type:** validation runs before any upload and lists
  every bad file at once. Limits mirror GitHub's web UI — 10 MB for images,
  100 MB for videos — and content is checked against its extension (magic
  bytes) for PNG/JPEG/GIF/WebP. Fix or drop the offending file. Supported
  extensions: `.png`, `.jpg`/`.jpeg`, `.gif`, `.webp`, `.svg`, `.mp4`, `.mov`,
  `.webm`.
- **All strategies failed:** the error lists each attempt's reason. Usually
  `gh` auth or connectivity — fix that first, then retry.

## Installing this skill

See [install.md](./install.md). One-liner for Claude Code:
```bash
npx degit MatteoSchifano/pr-media/skills/pr-media ~/.claude/skills/pr-media
```
