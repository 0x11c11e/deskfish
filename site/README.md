# Deskfish website

The public website and field guide for Deskfish. It introduces an agent with its own Linux desktop and memory, reached through the desktop app, a browser, or VS Code. The existing aquatic palette, local typography, illustrated desktop replay, theme switch, and three real recordings remain.

Everything for this website lives here. Running, building, and synchronizing documentation write only inside `site/`.

## Run

Requires Node.js 22.13+ and npm. The static preview also uses Python 3.

```bash
cd site
npm ci
npm run dev
```

Open http://127.0.0.1:5173. On the current workstation, `./dev.sh` uses the local toolchain in `site/.tools/` when Node is not on the shell PATH.

## Build and check

```bash
npm run typecheck
npm run lint
npm run build
python3 scripts/check-site.py
npm run preview
```

Open http://127.0.0.1:4173. `dist/client/` contains the static export. `scripts/finalize-export.mjs` adds directory indexes so the home page, `/docs/`, and all guide URLs work on a plain static server. No backend, API key, or database is needed. Fonts and media are served locally. Analytics are loaded only if `NEXT_PUBLIC_GA_ID` is set at build time.

The content check covers all 21 content routes, headings, metadata, local links and anchors, the six stable release downloads, legacy Vercel redirects, and the license, notice, wallpaper and three recordings against the parent project.

## Contents

- `components/hero.tsx`, `experience.tsx`: landing page, task examples, models, handoff, recordings, FAQ, and downloads.
- `components/windows.tsx`, `windows.css`: interactive app/browser/VS Code explanation and MCP introduction. Each tab shows the same illustrative conversation to explain that these are clients of one Deskfish.
- `components/continuity.tsx`, `continuity.css`: memory notebook, reflection, background schedules, and standby.
- `components/living-tank.tsx`, `living-tank.css`, `lib/tank-replay.ts`: the original illustrated errand in VS Code. Pause/Replay, visibility handling, and reduced-motion scene controls are preserved.
- `app/docs/`, `components/docs-*`: 19 guides with searchable navigation, section links, code copying, and adjacent-page navigation.
- `app/content/docs.json`: checked-in rendered documentation; building the website does not require the parent sources.
- `public/`: original artwork, fonts and licenses, recordings, descriptive tracks, and site metadata.
- `REVIEW.md`: product changes, source mapping, and verification.

## Updating the field guide

```bash
npm run sync:docs
```

This reads only the public `../docs/*.md` files, then updates `app/content/docs.json` and `public/sitemap.xml`. It never publishes the private handbook. Small source-verified corrections live in `scripts/content-overrides.mjs`. The sync fails if a corrected source paragraph changes, so it can be reviewed rather than silently becoming stale. Current corrections cover the app's lack of a remote-gateway field and the screenshot behavior after passive reads.

## Downloads

Download links go directly to the project's stable `releases/latest/download/<filename>` URLs, so they work on any static host. Vercel's `/downloads/…` redirects remain for existing inbound links, including versioned VSIX URLs. No installer is bundled in the website and no release version is hardcoded in visible copy. The primary button detects desktop systems; phones, tablets, and unknown systems get the release chooser. All six files remain explicitly available.

When changing distribution, check the asset names against the release workflow and GitHub release assets. Update `components/experience.tsx`, `vercel.json`, and `scripts/check-site.py` together.

## Browser verification

The September 19 refresh was inspected and exercised in a separate headless Chrome session on the production export, without opening the product or using the user's desktop. Coverage includes desktop and phone layouts, both themes, tab keyboard navigation, handoff, prompt copying, FAQ, video dialog and playback, documentation search and code copying, mobile menus, and download selection. See `REVIEW.md` for the exact checks and limits. This work does not deploy the website.
