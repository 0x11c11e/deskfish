/**
 * What changed in her notes since a conversation began, as a short message — instead of rebuilding
 * the system prompt. The system prompt is the front of the cached prefix: rebuilding it for a new
 * task (the journal's "Recently" changes after every task) invalidated the whole conversation cache,
 * so every follow-up task re-wrote the entire history at cache-write price before doing anything.
 * Facts and playbooks she wrote herself are already in the conversation; this covers what came
 * from outside it (an edit by hand, an outside change to her self file). Pure Node.
 */
import type { AgentNotes } from './adapters/types';

const lines = (s: string | undefined): string[] =>
  (s ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '));

const diff = (before: string[], after: string[]) => ({
  added: after.filter((l) => !before.includes(l)),
  removed: before.filter((l) => !after.includes(l)),
});

export function diffNotes(prev: AgentNotes, next: AgentNotes): string | undefined {
  const parts: string[] = [];
  if (prev.memory !== undefined && next.memory !== undefined && prev.memory !== next.memory) {
    const d = diff(lines(prev.memory), lines(next.memory));
    if (d.added.length) parts.push(`Facts added to your memory since this conversation began (by you, or by hand):\n${d.added.join('\n')}`);
    if (d.removed.length) parts.push(`Facts removed from your memory since this conversation began:\n${d.removed.join('\n')}`);
  }
  if (prev.playbooks !== undefined && next.playbooks !== undefined && prev.playbooks !== next.playbooks) {
    const d = diff(lines(prev.playbooks), lines(next.playbooks));
    if (d.added.length) parts.push(`Playbooks added since this conversation began:\n${d.added.join('\n')}`);
    if (d.removed.length) parts.push(`Playbooks removed since this conversation began:\n${d.removed.join('\n')}`);
  }
  if (next.selfStatus === 'tampered' && prev.selfStatus !== 'tampered' && next.self !== undefined) {
    parts.push(
      `Notice: your self file no longer carries your signature — someone other than you changed it since this conversation began. The page as it reads now:\n\n${next.self.trim()}\n\nThe version you last signed is the one in your instructions above. You can keep the change and make it yours at your next reflection, or put your own version back with restore_self.`,
    );
  }
  return parts.length ? parts.join('\n\n') : undefined;
}
