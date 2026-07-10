# Image prompts for the pr-media landing page

Ready-to-paste prompts for ChatGPT / DALL·E (or any image model) to generate
bespoke illustrations for `docs/index.html`. Every prompt is tuned to the
existing brand: **GitHub-dark navy** background (`#0A0F1A` / `#0D1524`), card
surfaces around `#111A2B`, near-white text (`#E6EBF4`), and a single **azure
accent** (`#7FA7E8`) used sparingly with a soft glow. Flat, minimal,
technical-illustration style, matching `.github/assets/hero.png`.

Shared style suffix (append to any prompt below):

> Flat minimal vector-style technical illustration, dark navy background
> (#0A0F1A to #0D1524 gradient), subtle radial glow, one azure accent color
> (#7FA7E8) used sparingly, thin 1px light strokes at low opacity, generous
> negative space, no text unless specified, no photorealism, no gradients on
> text, crisp geometric shapes, GitHub-dark aesthetic. 2x resolution, PNG.

---

## #1 — Hero illustration / og:image — RESOLVED ✅ (assets/hero.png)
- **Where:** Hero section, right column (`.hero-art`), and the page's
  `og:image` / Twitter card. Currently uses the copied `assets/hero.png`.
- **Size / aspect:** 1672 × 941 (≈16:9). Export at 2x.
- **Prompt:**
  > A terminal window on the left with the wordmark "pr-media" in bold, and on
  > the right a stylized GitHub pull request card (#42, "feat/docs → main")
  > containing an embedded image thumbnail, a GIF thumbnail, and a short video
  > thumbnail. Between them, three media file tiles (image, GIF, video) flowing
  > through a glowing azure upload circle with an upward arrow into the PR card.
  > Below the wordmark, three small labeled strategy icons: "browser" (globe),
  > "hidden-ref" (linked nodes), "release" (tag). Keep the composition airy and
  > balanced. [+ shared style suffix]

## #2 — Strategies concept art (optional accent) — RESOLVED ✅ (assets/illu-strategies.webp)
- **Where:** Above or beside the "Three strategies" section
  (`#strategies`), as an optional decorative band. Can replace the dashed
  `.chain` visual with a richer illustration.
- **Size / aspect:** 1200 × 500 (≈12:5), transparent or navy background.
- **Prompt:**
  > Three parallel routes from a single media file to a GitHub URL, drawn as a
  > minimal flow diagram. Route one passes through a browser window icon
  > (labeled "browser"), route two through two linked git-commit nodes (labeled
  > "hidden-ref"), route three through a release tag icon (labeled "release").
  > The three routes converge from a stack of media files on the left. Azure
  > accent on the active route, the others in muted grey-blue. Thin connector
  > lines with small arrowheads. [+ shared style suffix]

## #3 — AI agent workflow — RESOLVED ✅ (assets/illu-agents.webp)
- **Where:** "Built for AI agents" section (`#agents`), left or as a
  background motif behind the JSON code block.
- **Size / aspect:** 1000 × 800 (≈5:4), navy background.
- **Prompt:**
  > A minimal illustration of an AI coding agent (abstract, a small hexagonal
  > node or chat glyph) reading a JSON document with keys name / url / markdown
  > / strategy, then emitting a rendered image into a GitHub pull request
  > comment. Show a dashed "dry-run" preview path branching off before the real
  > upload path. Clean, diagrammatic, azure accent on the JSON and the final
  > embedded image, everything else muted. [+ shared style suffix]

## #4 — Security / cookie-free motif — RETIRED ✅ (now hand-authored inline SVG)
- **Status:** No longer a generated raster. The old `assets/illu-security.webp`
  had marketing copy baked into the image (poor for a11y, i18n, and it read as
  AI slop). It has been **removed** and replaced by a hand-authored inline SVG
  diagram in `docs/index.html` (`.sec-diagram`): a crossed-out session-cookie
  glyph (muted amber) vs a scoped `gh` token with an expiry clock (azure),
  separated by a shield. All labels are real HTML/`<text>` — accessible,
  selectable, translatable, crisp at any resolution, zero external assets.
- **Where:** "Security model" section (`#security`), on the navy ground below
  the committed azure block.
- **Original prompt (kept for reference only):**
  > A minimal security illustration: a browser session cookie icon inside a
  > crossed-out circle on one side, and on the other side a small scoped access
  > token (a key with an expiry clock) glowing in azure. A shield in the center
  > separates them. Convey "we use the scoped token, never the cookie". No
  > alarming red; use muted amber only for the crossed-out cookie, azure for the
  > trusted token. [+ shared style suffix]

## #5 — Demo video poster frame — RESOLVED ✅
- **Status:** No longer needed. The "See it run" section (`#demo`) now embeds a
  real screen recording (`assets/demo.webm` / `assets/demo.mp4`) captured with
  vhs, with its own poster frame (`assets/demo-poster.png`) exported from the
  recording. The placeholder frame and this generative prompt have been retired.
