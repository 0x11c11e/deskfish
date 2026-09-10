/**
 * A message typed while she reflects. A reflection is her alone with her notes; a person's
 * message must not land in that conversation (it once turned a reflection into a GitHub errand
 * on a desktop that was supposed to be the person's). The message is kept here and started as
 * a task when the reflection ends. One slot: a second message joins the first.
 */
export interface Held<A> {
  text: string;
  attachments: A[];
}

export class HeldMessage<A = unknown> {
  private held?: Held<A>;

  /** Keep `text` for after the reflection: 'held' for the first message, 'joined' when one was already waiting. */
  add(text: string, attachments: A[] = []): 'held' | 'joined' {
    if (this.held) {
      this.held = { text: `${this.held.text}\n\n${text}`, attachments: [...this.held.attachments, ...attachments] };
      return 'joined';
    }
    this.held = { text, attachments };
    return 'held';
  }

  get pending(): boolean {
    return !!this.held;
  }

  /** Hand over what is waiting (and forget it); undefined when nothing is. */
  take(): Held<A> | undefined {
    const h = this.held;
    this.held = undefined;
    return h;
  }

  clear(): void {
    this.held = undefined;
  }
}
