# AI Engineering Log

Entries for significant AI-assisted work on Deskfish, as the course requires. Each entry records the
tool, the task, the context it was given, what it produced, what was rejected or changed, how the
result was verified, the limitations found, and one lesson.

## 2026-11-13 — The heartbeat, sprint 1: the watch list and its `url` trigger

**Tool.** Claude Code.

**Task.** Build the first vertical slice of the heartbeat on the branch `heartbeat-slice`. The slice
is a watch list the gateway checks on its existing 30-second tick with no model call. Its first
trigger kind, `url`, fetches an address and trips when the SHA-256 of the body changes. A trip
starts the task the user agreed to when the item was made, as a fenced, unattended run in a new
chat. It includes a cooldown, a daily cap, an on/off setting, the panel, user docs, and tests named
after the twelve EARS acceptance criteria.

**Context given.** The team's design record, written first and committed before any code:
`docs/adr/0001-heartbeat-model-free-watch-list.md`, with the criteria H1–H12 and their SRS v2.1
requirement IDs. The sprint's task description. The existing code the slice is modelled on:
`src/agent/schedule.ts`, `src/gateway/service.ts` (`tickSchedules`, `fenceFor`, `run`),
`src/gateway/protocol.ts` (`SPEC`, `Field`), `src/webview/bridge.ts` (`VIEW_COMMANDS`), the
Scheduled tasks panel, the agent's charter (clauses 3 and 6), and the existing test harness in
`test/service.test.mts`.

**What was generated.**
- `src/agent/watch.ts`: the store, validation, `checkUrl` and `describeCheck`.
- In `src/gateway/service.ts`: `tickWatches`, `checkWatch`, `tripWatch`, `startWatchRun`, and the
  add, remove, pause and check-now methods.
- Five wire commands and a `watch` event.
- Two settings, `deskfish.heartbeat` and `deskfish.heartbeatTripsPerDay`.
- The Watch list half of the Scheduled tasks panel.
- `docs/heartbeat.md`, with touches to four other pages.
- The tests: `test/watch.test.mts`, and an H2–H12 and FR-02 block in `test/service.test.mts`, plus
  additions to the settings, panels, web page and docs suites.

**What was rejected or changed, and why.**
- *H11's wording.* The criterion said a check sends "nothing else". Node's built-in `fetch` adds
  its own standard request headers (Accept, Accept-Language, Accept-Encoding, Sec-Fetch-Mode).
  Writing an HTTP client to remove them was rejected. The criterion was reworded to what is true and
  testable: no cookies, no credentials, no header of the user's, and the Deskfish user agent.
- *A field the task description did not have, `lastOkAt`.* The run's note says "changed since the
  last successful check at …". Without this field, a failed check in between would have shown as
  that time.
- *An address with `user:password@` in it is refused.* A check sends no credentials, so such an
  address cannot be honoured.
- *The criterion text was cleaned.* An implementer's note inside H1 was removed so the criterion
  reads as a requirement.
- *The charter citation was corrected.* The task description attributed "authority from the user
  at creation" to clause 3. Clause 3 is about money and accounts being borrowed, and the ADR cites
  it as that.
- *Two behaviours are now stated in the docs and the ADR.* (a) Turning the list off and on again,
  or pausing and resuming an item, keeps the baseline, so a change made meanwhile trips at the next
  check. (b) A trip counts when the change is accepted, even if its run then waits or is dropped by
  the switch or a pause.
- *Smaller interface additions.* `watch.list` also returns `tripsToday`, for the panel's state line.
  The service takes an injectable fetch and clock, so the tests run without the network and without
  waiting minutes.

**How it was verified.**
- `npm run typecheck` is clean.
- The whole suite, `npm test`, ran on the branch. The new or changed suites: watch 9 tests and 51
  checks; service 102 checks, including the named H2–H9, H11, H12 and FR-02 tests; settings 80;
  panels 97; docs 233.
- Every criterion maps to exactly one named test. The FR-02 test runs six idle ticks with an
  unchanged page and counts zero model calls. The H4 test asserts that a held run starts on the
  first tick after the agent is free.
- The HTTP side is real: an in-process server whose body the test flips, which also records the
  request headers. Only the timeout case shortens the 15-second limit.
- `npm pack --dry-run` and `vsce ls` show that neither `docs/adr/` nor `docs/engineering/` reaches the
  package or the extension. The site build and the agent's `read_docs` tool read only the top
  level of `docs/`.
- The extension was rebuilt, packaged and installed locally.

**Limitations found.**
- A page that puts a fresh token or the time in every answer trips once per cooldown. This is
  documented, not solved.
- Pages behind a login cannot be watched until a later kind uses the agent's browser.
- A check that fails is shown in the list but never retried before its next interval.
- One existing suite, `mcp.test.mts`, has a timing-sensitive assertion that failed once under full
  suite load and passed when run alone. It was not touched by this change.

**Lesson.** Writing the acceptance criteria before the code made the review question concrete:
"which test checks this sentence?" Answering it exposed a criterion that claimed more than the code
could truthfully promise (H11). The fix was to change the sentence, not to add code.
