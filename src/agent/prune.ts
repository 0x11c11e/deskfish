/**
 * Long tool results (page text, command output, a documentation page, a recall) stay whole only
 * while they are recent; older ones shrink to their first line. Images were already capped at
 * three, but text was never pruned until the ledger, so a task that read the page a dozen times
 * re-read all of it at every step and re-wrote it at every cache miss. Shared by both adapters.
 */
export const LONG_RESULT_CHARS = 1_500;
/** How many long results stay whole (the newest ones). */
export const KEEP_LONG_RESULTS = 4;
/** Prune only once this many more have piled up, so the cached prefix is rewritten rarely (like the images). */
export const PRUNE_TEXT_BATCH = 4;

const MARK = '[the rest of this earlier result was dropped from the conversation to save room';

export function isLongResult(text: string): boolean {
  return text.length > LONG_RESULT_CHARS && !text.includes(MARK);
}

export function shortenResult(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').slice(0, 160);
  return `${first}\n${MARK} — ${text.length.toLocaleString('en-US')} characters; ask again if you need it]`;
}
