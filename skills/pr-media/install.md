# Installing the `pr-media` skill

This installs the **skill** (the instructions that teach an AI agent when and
how to drive the CLI). It does **not** install the `pr-media` CLI itself — see
["Installing the CLI"](#installing-the-cli-separate) below.

## Claude Code (one-liner, no npm publish needed)

Fetch just the `skills/pr-media` directory of the repo into your Claude Code
skills folder using [`degit`](https://github.com/Rich-Harris/degit) (no git
history, no auth):

```bash
npx degit MatteoSchifano/gh-pr-media/skills/pr-media ~/.claude/skills/pr-media
```

Restart Claude Code (or reload skills) and the `pr-media` skill will trigger on
requests like "attach this screenshot to the PR".

To update later, re-run the same command with `--force`:

```bash
npx degit --force MatteoSchifano/gh-pr-media/skills/pr-media ~/.claude/skills/pr-media
```

## Other harnesses (Codex, custom agents, etc.)

The skill is a plain directory containing `SKILL.md` (YAML frontmatter +
markdown body). Point the same `degit` command at wherever your harness loads
skills from — only the **destination path** changes:

```bash
npx degit MatteoSchifano/gh-pr-media/skills/pr-media <your-skills-dir>/pr-media
```

Common destinations:
- Claude Code: `~/.claude/skills/pr-media`
- Project-local (any harness that scans the repo): `.claude/skills/pr-media`
  or your harness's equivalent skills directory.

If your harness reads a single file rather than a directory, copy
`SKILL.md` into place and (if needed) rename it to your harness's convention.

## Manual install (git clone + copy)

No `npx`/`degit` available? Clone and copy the directory by hand:

```bash
git clone https://github.com/MatteoSchifano/gh-pr-media.git /tmp/pr-media
mkdir -p ~/.claude/skills
cp -R /tmp/pr-media/skills/pr-media ~/.claude/skills/pr-media
rm -rf /tmp/pr-media
```

Or, with a sparse checkout if you only want the skill directory:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/MatteoSchifano/gh-pr-media.git /tmp/pr-media
git -C /tmp/pr-media sparse-checkout set skills/pr-media
cp -R /tmp/pr-media/skills/pr-media ~/.claude/skills/pr-media
```

## Installing the CLI (separate)

The skill drives the `pr-media` CLI, which must be installed independently.
Any one of:

```bash
# Global npm install
npm install -g pr-media

# As a gh extension (then invoke `gh pr-media ...`)
gh extension install MatteoSchifano/gh-pr-media

# From source
git clone https://github.com/MatteoSchifano/gh-pr-media.git
cd pr-media && npm ci && npm run build
```

The CLI also requires `gh` (authenticated via `gh auth login`). The `browser`
strategy additionally needs `agent-browser` or a Chrome instance with remote
debugging enabled — see the repo README for details.
