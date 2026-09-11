# Contributing

Deskfish is one person's project, built in the open, and help is welcome. The most useful things,
in order:

1. **Tell us what she did.** If the agent behaved badly on a real page, open an issue with the
   task you gave, what happened on the screen, and which model and provider you used. That is
   worth more than a guess at the cause; the loop is only as good as the cases it has seen.
2. **Fix a small thing well.** Typos in the docs, a wrong sentence in a prompt, a test that
   catches something. Small pull requests get reviewed the same day.
3. **Talk before building big.** A new tool for the agent, a new adapter, a change to how memory
   works: open an issue first and say what you have in mind, so the shape is agreed before the
   work.

Before a pull request: `npm test` (no container needed), and `npm run build` if you touched the
extension. Keep the docs in `docs/` true to what the code does; the agent reads them about
herself. Write the commit message as a sentence about what changed and why.

By contributing you agree your work is under the same Apache 2.0 license as the project
(section 5 of the license, no separate agreement needed).

Questions: hello@deskfish.sh, or an issue.
