# Website review · September 9, 2026

The existing design still fits Deskfish. Its visible computer, the glass, and the human handoff remain central. What needed to change was the story after a task finishes: Deskfish now keeps procedures, history, and a self-description, reflects on her work, and returns to scheduled tasks.

## What changed

| Product addition                                | Website treatment                                                                                                              | Source checked                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Facts, journal, playbooks, self-description     | A four-tab notebook chapter, using the real bundled self and playbook excerpts and clearly labeled illustrative personal notes | `src/agent/memory.ts`, `journal.ts`, `playbook.ts`, `self.ts`, `seed.ts`, `starter.ts` |
| Reflection, charter, readings, revision history | A reflection passage within the notebook, with deeper explanations in the field guide                                          | `src/agent/loop.ts`, `charter.ts`, `library.ts`, `src/controller.ts`, `docs/memory.md` |
| Saved chats and memory export                   | Links below the notebook explain continuing from transcripts and moving memory between installations                           | `src/agent/chats.ts`, `src/controller.ts`                                              |
| One-time and recurring schedules                | A new chapter with realistic report and status examples, plus the conditions needed for them to run                            | `src/agent/schedule.ts`, `src/controller.ts`, `docs/schedules.md`                      |
| Standby and the task ledger                     | A local-waiting explanation and a feature card for the default 40-step ledger                                                  | `src/agent/loop.ts`, `src/config.ts`                                                   |
| Browser page reading and richer terminal tools  | A page-reading feature card, PDF example, and Python/CSV example                                                               | `src/agent/page.ts`, `docker/desktop/`, `docs/the-tank.md`                             |
| Model picker and provider-specific keys         | Setup instructions start with the actual sidebar picker; settings JSON is still available                                      | `src/agent/presets.ts`, `src/controller.ts`, `src/config.ts`                           |
| Personal name setting                           | A short setup note and the current settings reference                                                                          | `src/agent/prompts.ts`, `src/config.ts`                                                |

The review used the current implementation, tests, public docs, and project handbook to distinguish shipped behavior from plans. The handbook remains outside the published content. The complete public guide is refreshed from all 17 source documents, with site-only corrections in `scripts/content-overrides.mjs`.

## Corrections that matter

- Past chats save text, not screenshots or the original adapter state. Continuing one supplies up to the latest 16,000 characters as context to a fresh conversation.
- The task ledger summarizes earlier text; the live model does not keep every word forever.
- Schedules need VS Code open, Deskfish loaded, and the machine awake. The default grace period for an overdue task is five minutes. Tasks due while busy wait for the current task. Scheduling through ordinary chat, scheduled attachments, and per-schedule budgets are not advertised.
- Dollar budgets need known direct Claude prices or reported OpenRouter costs. A final request can exceed the budget, so the site does not call it a strict billing ceiling.
- Reflection uses model calls. The current implementation can reuse the previous conversation and still takes screenshots; the site does not promise that reflection runs in an isolated context without web content. Signatures detect outside edits to the self-description; they do not encrypt memory or guarantee that notes are safe.
- No host folder is mounted, but the Desktop tab shares the clipboard and the tank can reach LAN services. The field guide explains the network fallback as well.
- Export carries memory and chats, not browser logins, tank files, schedules, or API keys.

These corrections change only the website's copy. They are not changes to the extension or the parent documentation.

## Preserved

The living header and its product colors, page palettes and theme control, background bubbles, pause/replay and progress controls, handoff illustration, typography, original artwork, and real recording remain. The recording is described as having personal details blacked out. The existing social image remains, with updated descriptions. No dependencies were added.

## Validation

Use the existing site typecheck, lint, production build, and `scripts/check-site.py`. The content check covers all 19 content routes, local links and anchors, metadata, and the bundled release assets. No browser visual or interaction testing was performed. All files edited by this task are inside `site/`; the parent project was reviewed read-only and received separate concurrent commits during the review.
