# skills/

Agent skills for **pr-media** — reusable instructions that teach an AI coding
agent (Claude Code, Codex, and similar harnesses) *when* and *how* to use the
`pr-media` CLI to attach screenshots, GIFs, and short videos to GitHub pull
requests, cookie-free.

## Contents

- [`pr-media/SKILL.md`](./pr-media/SKILL.md) — the skill itself: trigger
  description plus a full playbook (when to use / when not, prerequisites,
  recommended workflow, strategy-selection table, safety rules, worked
  examples, and common-error fixes).
- [`pr-media/install.md`](./pr-media/install.md) — installation instructions
  for Claude Code and other harnesses, plus a manual `git clone` fallback.

This directory ships the *skill*, not the CLI. The `pr-media` CLI is installed
separately (`npm install -g pr-media`, `gh extension install`, or from source
— see `install.md` and the repo README).

## Install (Claude Code)

Fetch just this skill into your Claude Code skills directory — no npm publish
required:

```bash
npx degit MatteoSchifano/pr-media/skills/pr-media ~/.claude/skills/pr-media
```

For other harnesses, manual install, and how to keep the skill updated, see
[`pr-media/install.md`](./pr-media/install.md).
