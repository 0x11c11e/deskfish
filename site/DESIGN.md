# A little world, through the glass

Deskfish gives an agent a sandboxed Linux desktop of its own. The website makes that computer visible, explains the handoff between agent and person, and shows the thread that persists between tasks. Its desktop app, browser page, and VS Code extension are three windows onto the same agent.

## Keep the identity; update the story

The deep green default and warm light palette, DM Sans and italic Instrument Serif, original fish mascot, background bubbles, illustrated desktop replay, and three real recordings remain. Fonts and artwork are served locally. Product previews keep the product's neutral dark surfaces and blue chat bubbles inside the website's green frame.

The September 19 refresh adds a chapter near the beginning: **Three windows. One little world.** The app is first, followed by the browser and VS Code. Selecting a tab changes the shell and explanation while preserving the same example task, file, and memory note. This makes the shared agent understandable without requiring the reader to learn the gateway protocol. It is labeled as an illustration and never connects to a real Deskfish.

A compact passage below it introduces MCP: another agent can delegate an errand, inspect the result, and give feedback in chat. Technical registration belongs in the guide. A second passage explains where Deskfish lives: a laptop, a computer at home, or the user's server.

The narrative now moves through the idea, ways to connect, practical tasks, the tank and handoff, useful tools, memory and reflection, background schedules, model choice, real recordings, questions, and installation. The numbered chapters match that order.

## Product details that shape the design

- The app is the first download, with the extension and server setup close by. Mobile visitors see a desktop-app chooser; the site does not offer an Android or iOS installer.
- Downloads use stable GitHub release URLs. A published release number is never assumed from the source package version.
- Schedules continue without VS Code. The copy says that Deskfish must keep running and its machine must remain awake, explains the guided mode and model budget defaults, and links to details.
- The model selector includes Claude, compatible APIs, Grok sign-in, and local models. Grok eligibility is xAI's decision; the site does not promise it for every subscriber.
- Memory persists independently of a window or model. Chat continuation uses saved text as context, while browser logins and files live separately in the tank.
- The existing VS Code replay and recordings are identified as such. They remain useful evidence of the desktop workflow; the new illustration explains the additional windows.
- The app's unsigned status and untested macOS/Windows device paths are explained near installation and in the field guide.

## Boundaries

There are no invented customer logos, testimonials, performance claims, or new bitmap assets. All examples are labeled. Multiple independent tanks, automatic memory synchronization across machines, invisible credential injection, and automatic restart of interrupted work are not presented as shipped.

The tank's files are isolated from host folders, but its clipboard and reachable network services are described honestly. The landing page links to the detailed security guide. The website never receives model keys or gateway tokens.

## Accessibility and behavior

The new window tabs use the same accessible Base UI tabs as the rest of the site. Layouts stack at small widths and support keyboard navigation. Product illustrations have text equivalents; the original replay retains Pause/Replay and manual scene controls for reduced motion. The three silent recordings have descriptive tracks and dialog descriptions. Theme choices persist on documentation routes too.

The production export was checked in headless Chrome at 320, 390, 768, 1024, and 1440 pixels and visually inspected in both palettes. Source mapping and verification details are in [REVIEW.md](REVIEW.md).
