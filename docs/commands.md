---
title: Commands
description: Everything Deskfish adds to the command palette.
section: Reference
order: 2
---

Open the command palette (Ctrl+Shift+P, or ⌘⇧P on macOS) and type *Deskfish* to see
these. Most of them are also reachable from the sidebar, which is the normal way to use
Deskfish; the commands exist for keyboard people and for keybindings.

| Command | What it does |
| --- | --- |
| **Deskfish: Open Desktop View** | Opens the Desktop tab with the live view of the tank. Same as the Desktop chip |
| **Deskfish: Turn Desktop On / Off** | Toggles the tank. Same as the power button |
| **Deskfish: Turn Desktop On** | Starts the tank (building the image the first time) |
| **Deskfish: Restart Desktop** | Turns the tank off and on again. A running task is stopped first. Also under the **…** menu
| **Deskfish: Turn Desktop Off** | Stops a running task if there is one, then shuts the tank down cleanly |
| **Deskfish: Set LLM API Key** | Asks for the API key and stores it in the operating system's keychain and Deskfish's data folder. Leave it empty to clear the stored key. Same as the key chip |
| **Deskfish: Stop Agent** | Ends the current task. Same as the Stop button |
| **Deskfish: Choose Model…** | Picks where the model comes from (Anthropic direct, OpenRouter, xAI, Ollama, LiteLLM, another endpoint, or the demo) and which model, then asks for a key if that provider has none. The **Change** button next to *Model* does the same
| **Deskfish: Past Chats…** | Opens the history panel in the chat: past chats by day with how each ended, a filter, one click to read one in place, **Continue this chat**, delete on the row. The clock icon in the sidebar's title bar
| **Deskfish: Delete Past Chats** | Removes every past chat's transcript after a confirmation (the chat you are in stays); journal, facts and self are untouched. Also under the **…** menu and at the bottom of the history
| **Deskfish: New Chat** | Closes the current chat's transcript and starts a fresh conversation, stopping a running task if there is one. The desktop is left as it is. Same as the **+** in the sidebar's title bar |
| **Deskfish: Her Files…** | Opens the Her files panel in the chat: tabs for her facts, the charter, who she is, the journal and the playbooks; **Edit in VS Code** opens facts or charter in an editor tab. Also under the **…** menu |
| **Deskfish: Settings…** | Opens the Settings panel in the chat: every Deskfish setting with VS Code's words, saved to Deskfish and mirrored into your user settings. Also under the **…** menu |
| **Deskfish: Edit Memories (facts)** | Opens the agent's fact file in an editor tab, one fact per line. Also under the **…** menu |
| **Deskfish: Forget All Memories (facts)** | Empties the fact file after a confirmation; the journal and the self file are untouched. Also under the **…** menu |
| **Deskfish: Who She Is** | Read-only view of the agent's self file, the page it writes about itself. Also under the **…** menu |
| **Deskfish: Open Her Journal** | Opens the journal: one line per finished task and per note the agent left itself. Also under the **…** menu |
| **Deskfish: Open Her Playbooks** | Opens the playbooks: the how-to notes the agent wrote for itself per site or task. Also under the **…** menu |
| **Deskfish: Edit Her Charter** | Opens the charter, the maker's ten commitments with reasons that sit above the agent's self page, starting from the default. Also under the **…** menu |
| **Deskfish: Scheduled Tasks…** | Opens the Scheduled tasks panel in the chat: the schedules with their next time and last outcome (run one now or remove it), and a form to add one (when, what, guided or free, a budget). A task starts itself at its time while Deskfish runs, which it keeps doing in the background when VS Code is closed. See [Schedules](schedules). Also under the **…** menu |
| **Deskfish: Schedule a Task…** | The same panel, from the command palette |
| **Deskfish: Let Her Reflect** | Runs a reflection now: the agent, alone with its notes, saves facts and may revise its self file. Also under the **…** menu |
| **Deskfish: Export Her Memory…** | Writes one JSON file with the facts, the playbooks, the self file with its history, the journal with its state, the charter if you wrote one, and the past chats. Also under the **…** menu |
| **Deskfish: Import Her Memory…** | Restores that bundle from such a file, after a confirmation, and signs the imported self file for this installation. Also under the **…** menu |
| **Deskfish: Save a File from the Desktop…** | Lists the files in the tank's Downloads folder and saves the one you pick to your computer |
| **Deskfish: Install Podman…** | Opens a terminal with the installation command for this system. Same as the Install button on the setup card |
| **Deskfish: Show Log** | Opens the Deskfish output channel: every step of every task, unfolded |
| **Deskfish: Open Documentation** | Opens this documentation in your browser |

## Keybindings

None are set by default. To add your own, open **Preferences: Open Keyboard Shortcuts** and
search for *deskfish*; the command identifiers are `deskfish.openDesktop`,
`deskfish.toggleDesktop`, `deskfish.startDesktop`, `deskfish.restartDesktop`,
`deskfish.stopDesktop`, `deskfish.setApiKey`, `deskfish.stopAgent`, `deskfish.changeModel`,
`deskfish.pastChats`, `deskfish.deletePastChats`, `deskfish.newChat`, `deskfish.herFiles`,
`deskfish.settings`, `deskfish.editMemory`,
`deskfish.clearMemory`, `deskfish.showSelf`, `deskfish.openJournal`, `deskfish.openPlaybook`,
`deskfish.editCharter`, `deskfish.scheduleTask`, `deskfish.scheduledTasks`, `deskfish.reflect`,
`deskfish.exportMemory`, `deskfish.importMemory`, `deskfish.saveFile`,
`deskfish.installRuntime`, `deskfish.showLog` and `deskfish.openDocs`.
