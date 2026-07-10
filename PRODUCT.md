# Product

## Register

brand

## Users

Developers (and AI coding agents) who hit a specific wall: they need to attach images/GIFs/videos to a GitHub PR from a script, CI job, or agent, and discover GitHub has no public API for it. They arrive from a search or a GitHub README, technically fluent, skeptical of tools that ask for their session cookie. Context: terminal-heavy workflow, dark-mode editors, fast evaluation ("does this solve my problem securely? show me the command").

## Product Purpose

pr-media is an open source CLI (npm `pr-media`, repo `MatteoSchifano/gh-pr-media`) that uploads media into GitHub PRs via three cookie-free strategies (browser agent, hidden Git ref, release assets) with automatic fallback. The landing page exists to convert a searching developer into an install (`npm install -g pr-media`) in under a minute, and to make the security model — the differentiator — impossible to miss. Success: the visitor copies the install command or stars the repo.

## Brand Personality

Terminal-native, sober, credible. The interface should feel like a well-crafted developer tool, not a marketing site: monospace where it matters, real command output, precise claims, zero hype. References: cli.github.com, Warp, ghostty.org.

## Anti-references

- Anything that departs from the project's established palette: the dark navy / soft azure of the README hero image (`.github/assets/hero.png`) is the brand; stay inside it.
- Generic SaaS slop: gradient text, hero-metric blocks, identical icon+title+text card grids, decorative glassmorphism.
- Crypto/neon aesthetics; corporate brochure tone; stock photography; fake "Trusted by" walls.

## Design Principles

1. **Show the tool, not adjectives.** Real CLI output, real URLs shapes, real commands that work when copied.
2. **Security is the headline, not a footnote.** The cookie-free model is why this exists; it gets prime real estate and firm copy.
3. **Practice what you preach.** A page for a lightweight, dependency-free CLI must itself be lightweight: no external resources, no frameworks, fast first paint.
4. **Honest limits build trust.** Public-URL caveats and one-time browser login stated plainly, like the README does.

## Accessibility & Inclusion

WCAG AA: text contrast ≥ 4.5:1 on the dark palette, full keyboard navigation (tabs, copy buttons, focus visible), `prefers-reduced-motion` fully honored (typing animation and reveals collapse to final static states).
