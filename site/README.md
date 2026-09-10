# Deskfish website

A complete, self-contained website for Deskfish. Warm paper, ink, aquatic green, an animated desktop illustration, useful interactive examples, the real domain-purchase film, and the complete field guide.

The hero desktop plays a 34-second illustrated errand: a typed task, Firefox, domain search, checkout, a human handoff, confirmation, and a memory note. Pause and Replay controls are below it. Playback waits until the frame is in view and pauses in background tabs. Reduced-motion visitors get static scenes with a Next scene control.

The replay keeps the product’s own appearance inside the glass: neutral dark VS Code chrome, the original tank wallpaper, blue chat/actions, white browser pages, and orange Namecheap actions. The outer frame, chapter counter, playback controls, and progress bar follow the website theme.

The header offers Light and Dark themes. Dark is the default; Light uses a soft cream palette. Your choice is saved in browser local storage and applied before the page paints, including on documentation pages.

Everything for this website lives in this directory. Building or running it does not modify the extension, its documentation, or other project files.

## Run

Requires Node.js 22.13+ and npm. The static preview command also uses Python 3.

```bash
cd site
npm ci
npm run dev
```

Open http://127.0.0.1:5173. On the current workstation, where Node is not on the shell PATH, `./dev.sh` uses the local toolchain already prepared in `site/.tools/`.

## Build and preview

```bash
npm run typecheck
npm run lint
npm run build
npm run preview
```

Open http://127.0.0.1:4173. `dist/client/` is a complete static site. Serve it at the domain root on any static host supporting directory index files. No backend, API key, database, analytics, cookies, or external font requests are needed. Nothing has been publicly deployed.

Vinext builds the App Router pages to static HTML. `scripts/finalize-export.mjs` also creates directory-index URLs so `/docs/` and all guide URLs work on a plain static server. Native anchors intentionally avoid a dependency on server-side navigation or image optimization. The generated `.html` routes remain available too.

## Contents

- `app/page.tsx`, `components/hero.tsx`, `components/experience.tsx`: landing page and interactions.
- `components/continuity.tsx` and `continuity.css`: the interactive memory notebook, reflection, schedules, and standby chapters.
- `app/globals.css`: the complete responsive visual system and reduced-motion behavior.
- `app/docs/`, `components/docs-*`: 17 guides, searchable navigation, table of contents, code copying, and adjacent-page navigation.
- `app/content/docs.json`: checked-in, pre-rendered content. The website builds independently of the parent project.
- `public/`: local fonts and their licenses, the original mascot, tank screenshot, demo with personal details blacked out, and the extension download.
- `DESIGN.md`: design rationale, source mapping, and research references.

## Updating content

`npm run sync:docs` reads the parent project's `docs/*.md` and updates only this website's content and sitemap. Source-verified corrections live in `scripts/content-overrides.mjs`, so another sync preserves them. They cover memory and chat restoration, reflection, scheduling, costs and budgets, the ledger, model setup, and the tank’s actual boundary. The parent docs remain untouched. See [the September review](REVIEW.md) for the rationale.

When releasing an extension update, replace `public/downloads/deskfish-0.1.0.vsix` with the intended release and update the version and download links. Keep `public/LICENSE.txt` and `public/NOTICE.txt` consistent with that release. The included package and license match the project's current Apache-2.0 release.

## Verification

```bash
python3 scripts/check-site.py
```

After building, this checks all 19 content pages, local links and anchors, page metadata, and the bundled extension, license, notice, and video against the parent project's current copies. Use the typecheck, lint, and build commands above for code validation. Visual browser and interaction QA have not been performed.

The source repository currently configured in the extension is `https://github.com/0x11c11e/deskfish`. Public availability was not verified in this review; the site continues to use its documentation and bundled download links.
