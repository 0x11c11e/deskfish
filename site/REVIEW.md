# Website review · September 19, 2026

Deskfish now runs independently of VS Code. Its gateway owns the agent, tank, memory, chats, settings, and schedules. The app, browser, extension, command line, and MCP server are clients of that same program. The website needed to explain that change throughout, beyond the download button added earlier.

## What changed

| Product behavior | Website treatment | Sources checked read-only |
| --- | --- | --- |
| App, browser, and VS Code share one agent | New accessible three-tab chapter and matching hero, navigation, FAQ, and metadata | `docs/introduction.md`, `the-app.md`, `running-without-vscode.md`; `src/gateway/`, `app/` |
| Gateway on a chosen machine | A home/server explanation and setup links; app remote-setting limitation preserved | `docs/advanced.md`, `settings.md`, `security-and-privacy.md` |
| MCP client of the gateway | Introductory delegation passage and links to registration and tools | `src/gateway/mcp.ts`, `docs/advanced.md` |
| Background schedules | Removed the requirement to keep VS Code open; added guided mode and $2 model-budget defaults, overrides, awake-machine condition, and login startup | `src/gateway/service.ts`, root `package.json`, `docs/schedules.md` |
| Grok subscription sign-in | Fourth model tab, setup and eligibility explanation, pool-exhaustion behavior | `src/agent/presets.ts`, `src/gateway/mcp.ts`, `docs/models-and-providers.md` |
| Page tools and interrupted tasks | Updated tool and ledger copy; detailed guides cover passive reads, `click_element`, recovery notes, and standby | `docs/how-the-bot-sees-and-acts.md`, `running-tasks.md`; current handbook decisions checked against source |
| Shared memory and history | Updated storage and history copy; guide covers current reflection and drift behavior | `docs/memory.md`, `faq.md` |
| Six release artifacts | Direct stable release URLs on every static host; sensible desktop detection and mobile fallback; existing Vercel aliases retained | `.github/workflows/release.yml`, `app/package.json`, GitHub Releases API |
| Full current field guide | All 19 public guides synchronized; obsolete broad replacements removed | `docs/*.md` |

The agent onboarding files, handbook product/architecture/user notes, roadmap and relevant decision history were used to separate shipped behavior from plans. Only public documentation enters the content sync. Nothing from private lessons, personal memory, credentials, or environment notes is published.

## Source corrections

Three small corrections are kept in `scripts/content-overrides.mjs`, without editing the parent documentation:

1. The getting-started guide implied the app could select a remote gateway. Its own guide and implementation say to use the browser or VS Code for that.
2. The Desktop tab guide still said the agent took a screenshot at every step. Passive reads now omit the extra screenshot; explicit screenshot requests still get one.
3. The model-cost introduction made the same per-step screenshot claim; it now reflects the current observation behavior.

The sync checks that each source passage still matches before applying a correction. A changed source needs review instead of retaining an obsolete override. Model identifiers and settings in the reference remain those of the current public documentation; the landing page does not pin a model version or quote token prices.

## Interaction fix

Browser checks exposed an existing documentation copy bug: updating the live announcement through React state replaced the generated article HTML, resetting button feedback and discarding its click listeners. The announcement now uses a DOM ref, preserving the article and repeat copying. All three silent recordings also have descriptive tracks.

## Verification

- TypeScript check, Oxlint, and production static build pass.
- `scripts/check-site.py` checks 21 content routes: home, field guide index, and 19 guides. It validates local links, anchors, headings and metadata, all six release URLs and legacy redirects, and the license, notice, original wallpaper, and three recordings against the project.
- The GitHub Releases API returned `v0.2.40` with all six expected downloads during this review. URLs use `latest`; this observation is not pinned into the website.
- Headless Chrome checks cover window, memory and model tabs, arrow-key tab navigation, handoff, prompt clipboard copying, FAQ, video dialog, theme persistence, documentation search and code copy, and mobile navigation.
- Responsive checks cover home, docs index, app guide and advanced guide at 320, 390, 768, 1024, and 1440 pixels. Download checks cover Windows, macOS, Linux, iPhone, iPad-style identification, and Linux ARM fallback.
- Both palettes and the revised desktop/phone sections were visually inspected. No product task, gateway, container, or model account was used for website testing. This verifies the website in Linux Chrome; it does not validate the product installers on macOS or Windows.

All edits from this website task are inside `site/`. The root README received a separate concurrent edit and was left untouched. No deployment or commit was made.
