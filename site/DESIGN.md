# A little world, through the glass

Deskfish is a desktop agent with its own sandboxed Linux computer inside VS Code. It works through screenshots, mouse movements, keyboard input, a browser, and a terminal. The distinguishing product idea is the visible boundary between the user's machine and the agent's tank, paired with the ability to hand control back and forth.

The design makes that idea tangible. A dark green default, optional warm paper palette, and spacious editorial typography make the project approachable. Deep green and pale aquatic colors connect the site to the original fish mascot. DM Sans provides the everyday voice; italic Instrument Serif adds a human, slightly curious inflection. The mascot is the project's original artwork. All fonts are served locally with their OFL notices.

The opening illustration gives the idea a shape immediately: chat on one side, the agent's computer on the other. Its 34-second replay types the task, opens Firefox, searches for the domain, prepares checkout, illustrates the human handoff, and shows the confirmation and memory note before looping. It has pause/replay controls, and reduced-motion visitors can step through still scenes. It is explicitly labeled as an illustrated preview. The real recording, with personal details blacked out, provides the evidence further down the page, with its native video controls available after deliberate playback.

The narrative moves from the idea to practical tasks, the tank, useful details, memory and reflection, schedules and standby, model choice, the real errand, questions, and installation. Seven selectable task prompts can be copied, including PDF reading and Python with a CSV. Four memory tabs reveal the different stores through readable excerpts. Three model tabs lead with the sidebar picker; settings examples remain available in a disclosure. The handoff illustration changes state so a visitor can try the concept. These are browser-side illustrations, not connected agents.

The documentation is a first-class part of the experience: a quiet reading layout, searchable guide titles and headings, stable section links, copyable code, and previous/next navigation. The download is the actual packaged extension, not a placeholder or a planned Marketplace listing.

## Product grounding

Reviewed the project's authored source, project configuration, public guides, architecture and product notes, scripts, container files, and assets. Key connections:

| Website message        | Implementation grounding                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| A computer of its own  | `docker/desktop/`, `src/desktop/manager.ts`, `engine.ts`, `runtime.ts`                                  |
| Look, think, act, look | `src/agent/loop.ts`, `actions.ts`, `src/computer/`, `src/image/`                                        |
| Your choice of model   | `src/agent/adapters/`, `src/config.ts`                                                                  |
| Knocking on the glass  | `src/agent/prompts.ts`, `loop.ts`, `src/controller.ts`, desktop/chat views                              |
| Explicit file transfer | `src/desktop/files.ts`, daemon API, `src/webview/chat.ts`                                               |
| Memory and reflection  | `src/agent/memory.ts`, `self.ts`, `journal.ts`, `playbook.ts`, `library.ts`, controller memory commands |
| Saved text chats       | `src/agent/chats.ts`, `src/controller.ts`                                                               |
| Schedules and standby  | `src/agent/schedule.ts`, `loop.ts`, controller schedule commands                                        |
| Reads its own manual   | `src/agent/docs.ts` and the 17 canonical documentation files                                            |
| Real domain errand     | `demo/deskfish-buys-its-domain.mp4`, the recording with personal details blacked out                    |
| Apache 2.0 release     | The project's current `LICENSE`, `NOTICE`, `package.json`, and packaged VSIX                            |

The copy avoids describing future work as shipped: multiple tanks, credential vaults, exact restoration of live model state, always-on scheduling, a standalone CLI, and Marketplace distribution. It distinguishes the local desktop from model inference, and explains the clipboard behavior in the security FAQ. Example outcomes are described as illustrative and model-dependent.

The website was refreshed against the current source and handbook on September 9, 2026. The product now has persistent text chats, four memory stores, reflection, playbooks, a task ledger, standby, and scheduling. See [REVIEW.md](REVIEW.md) for the implementation mapping and boundaries. All website-task edits remain inside `site/`.

## Research references

Reviewed these public project sites for their communication patterns, without copying their layouts or visual identities:

- [Ghostty](https://ghostty.org/): concise product framing and a clear path into documentation.
- [Zed](https://zed.dev/): a product-centered introduction and an accessible path to deeper technical detail.
- [Bytebot](https://www.bytebot.ai/): a nearby computer-use concept, useful when choosing how to explain a dedicated agent desktop.
- [Ollama](https://ollama.com/): a direct first action and a simple explanation of local operation.

Deskfish's identity comes from its own metaphor, mascot, real desktop, and real first errand. No stock photography or invented testimonials, metrics, integrations, or customer logos are used.

## Implementation notes

The site uses the Sites React/Vinext scaffold, with Tailwind and shadcn/Base UI primitives for buttons, tabs, accordions, and dialogs. Unused scaffold components and dependencies were removed. All application code, media, generated content, build files, and local tooling are contained in `site/`.

The site is statically exported and does not request external services at runtime. Keyboard navigation, visible focus, semantic landmarks, skip links, native video controls, a descriptive caption track for the silent recording, explicit image descriptions, mobile navigation, and reduced-motion handling are included. Automated code/build/content checks pass; no visual browser QA or browser interaction testing was performed.

The expanded desktop replay draws on the earlier alternate design supplied by the user, keeping this website’s own outer frame and playback interface. The interior uses the recorded product’s own typography and colors: neutral dark VS Code chrome, the original tank wallpaper, a blue user message and Run control, and white Namecheap pages with orange actions. It uses a deterministic React timeline, scoped styling, and cursor targets measured from the actual rendered controls so the pointer stays aligned as the layout changes. No real card digits, order identifiers, or current domain-price claims are included in the illustration.

The product wallpaper is copied byte-for-byte from `../docker/desktop/wallpaper.svg`. Product colors are scoped to `.living-body`, with a separate white browser palette under `.living-browser`; they do not change with the website theme. The external frame, captions, scene counter, Pause/Replay, and progress bar remain in the page palette.
