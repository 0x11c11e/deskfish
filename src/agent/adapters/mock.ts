import type { ModelAdapter, ModelTurn, Observation } from './types';

/**
 * A scripted "model" for exercising the loop, the daemon client and the UI without an API key.
 * It pretends to open a browser and navigate to a URL, then declares success.
 */
export class MockAdapter implements ModelAdapter {
  readonly name = 'mock';
  private turn = 0;
  private screen = { width: 1280, height: 720 };
  private notes: string[] = [];
  private url = 'example.com';

  start(task: string, screen: { width: number; height: number }): void {
    this.turn = 0;
    this.screen = screen;
    this.notes = [];
    // navigate to whatever the task mentions, e.g. "go to wikipedia.org/wiki/Cat"
    const m = task.match(/\b((?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)/i);
    if (m) this.url = m[1];
  }

  addUserMessage(text: string): void {
    this.notes.push(text);
  }

  async step(obs: Observation): Promise<ModelTurn> {
    await new Promise((r) => setTimeout(r, 300));
    const failed = obs.results.filter((r) => !r.ok);
    const prefix = failed.length ? `(${failed.length} action(s) failed: ${failed.map((f) => f.error).join('; ')}) ` : '';
    const { width, height } = this.screen;
    this.turn++;
    switch (this.turn) {
      case 1:
        return {
          text: `${prefix}I'll open the browser from the desktop icon.`,
          actions: [{ type: 'click', x: Math.round(width * 0.04), y: Math.round(height * 0.3), button: 'left', count: 2 }, { type: 'wait', seconds: 1 }],
          done: false,
        };
      case 2:
        return {
          text: `${prefix}Browser is open; focusing the address bar and typing the URL.`,
          actions: [
            { type: 'key', keys: ['ctrl', 'l'] },
            { type: 'type', text: this.url },
            { type: 'key', keys: ['Return'] },
            { type: 'wait', seconds: 1 },
          ],
          done: false,
        };
      case 3:
        return {
          text: `${prefix}This site wants a login — handing over.`,
          actions: [{ type: 'ask_user', reason: 'Demo hand-over: please log in on the desktop (or just click Resume), then hand control back.' }],
          done: false,
        };
      case 4:
        return {
          actions: [
            { type: 'cursor_position' },
            { type: 'zoom', x: Math.round(width / 2), y: Math.round(height / 2) },
            { type: 'scroll', x: Math.round(width / 2), y: Math.round(height / 2), direction: 'down', amount: 3 },
            { type: 'read_docs', page: 'files' },
          ],
          done: false,
        };
      default: {
        const docs = obs.results.find((r) => r.ok && r.message?.startsWith('Deskfish documentation'));
        const docsNote = docs ? ` I also read my own "files" documentation page (${docs.message!.length} characters).` : '';
        return {
          text: `${prefix}Done: the page is open.${docsNote}${this.notes.length ? ` (You said: ${this.notes.join(' / ')})` : ''}`,
          actions: [],
          done: true,
        };
      }
    }
  }
}
