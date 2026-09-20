/**
 * Headless runner: drives the agent loop from the terminal, no VS Code needed.
 *
 *   npm run mock-daemon                      # fake desktop on :9990 (or use the real Bytebot container)
 *   npm run smoke -- "open the browser"      # scripted mock model
 *   DESKFISH_PROVIDER=openai-compatible DESKFISH_BASE_URL=https://api.x.ai/v1 DESKFISH_MODEL=grok-4 \
 *   DESKFISH_API_KEY=... npm run smoke -- "open firefox and go to wikipedia.org"
 */
import * as path from 'node:path';
import { createAdapter } from './agent/adapters';
import { DocsLibrary } from './agent/docs';
import { MemoryStore } from './agent/memory';
import { SelfStore, newSelfKey } from './agent/self';
import { JournalStore } from './agent/journal';
import { PlaybookStore } from './agent/playbook';
import { DEFAULT_SELF } from './agent/seed';
import { DEFAULT_CHARTER } from './agent/charter';
import { STARTER_PLAYBOOKS } from './agent/starter';
import { Library } from './agent/library';
import { priceForConfig } from './agent/pricing';
import { AgentRunner } from './agent/loop';
import type { AdapterConfig } from './agent/adapters/types';
import { DesktopDaemonComputer } from './computer/daemon';
import { describeAction } from './computer/types';

async function main(): Promise<number> {
  const env = process.env;
  const provider = (env.DESKFISH_PROVIDER ?? 'mock') as AdapterConfig['provider'];
  // dist/smoke.js lives next to docs/ in the source tree and in the packaged extension.
  const docs = DocsLibrary.load(env.DESKFISH_DOCS_DIR ?? path.join(__dirname, '..', 'docs'));
  const memory = env.DESKFISH_MEMORY_FILE ? new MemoryStore(env.DESKFISH_MEMORY_FILE) : undefined;
  // DESKFISH_MEMORY_DIR enables the self file and the journal next to the memory (headless runs).
  const memDir = env.DESKFISH_MEMORY_DIR;
  const self = memDir ? new SelfStore(path.join(memDir, 'self.md'), env.DESKFISH_SELF_KEY ?? newSelfKey()) : undefined;
  const journal = memDir ? new JournalStore(path.join(memDir, 'journal.md')) : undefined;
  const playbook = memDir ? new PlaybookStore(path.join(memDir, 'playbook.md')) : undefined;
  if (self?.ensureSeed(DEFAULT_SELF)) {
    playbook?.ensureSeed(STARTER_PLAYBOOKS);
    journal?.appendNote('I hatched today: first start on this machine, with the seed of who I am and a few starter notes from the people who made me. Everything after this line is mine.');
  }
  const adapter = createAdapter({
    provider,
    model: env.DESKFISH_MODEL ?? 'claude-opus-5',
    baseUrl: env.DESKFISH_BASE_URL ?? (provider === 'openai-compatible' ? 'http://localhost:4000/v1' : undefined),
    apiKey: env.DESKFISH_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY ?? env.XAI_API_KEY,
    workspaceId: env.DESKFISH_WORKSPACE_ID ?? env.ANTHROPIC_WORKSPACE_ID,
    autonomy: env.DESKFISH_AUTONOMY === 'guided' ? 'guided' : 'free',
    promptCaching: (env.DESKFISH_PROMPT_CACHING as 'auto' | 'on' | 'off' | undefined) ?? 'auto',
    temperature: env.DESKFISH_TEMPERATURE ? Number(env.DESKFISH_TEMPERATURE) : undefined,
    cacheTtl: env.DESKFISH_CACHE_TTL === '5m' ? '5m' : '1h',
    effort: (env.DESKFISH_EFFORT as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined) || undefined,
    docsIndex: docs.size ? docs.index() : undefined,
    memoryNote: memory?.render(),
    notes: self && journal ? () => {
      const st = self.load();
      return { charter: DEFAULT_CHARTER, memory: memory?.render() ?? '', self: st.text, selfStatus: st.status === 'tampered' ? 'tampered' : 'ok', selfLastSigned: st.lastSigned, journal: journal.render(journal.recent()), playbooks: playbook?.index() };
    } : undefined,
  });
  const computer = new DesktopDaemonComputer(env.DESKFISH_DAEMON_URL ?? 'http://localhost:9990', { token: env.DESKFISH_DAEMON_TOKEN });
  const task = process.argv.slice(2).join(' ').trim() || 'Open the browser and go to facebook.com';

  const runner = new AgentRunner({
    computer,
    adapter,
    maxSteps: Number(env.DESKFISH_MAX_STEPS ?? 15),
    screenshotWidth: Number(env.DESKFISH_SCREENSHOT_WIDTH ?? 1280),
    settleMs: Number(env.DESKFISH_SETTLE_MS ?? 300),
    docs,
    memory,
    self,
    journal,
    playbook,
    library: Library.load(path.join(__dirname, '..', 'library')),
    reflectEvery: Number(env.DESKFISH_REFLECT_EVERY ?? 0),
    budgetUsd: Number(env.DESKFISH_MAX_COST_USD ?? 0),
    price: priceForConfig({ provider, model: env.DESKFISH_MODEL ?? (provider === 'anthropic' ? 'claude-opus-5' : ''), baseUrl: env.DESKFISH_BASE_URL }),
    onEvent: (e) => {
      switch (e.type) {
        case 'status':
          console.log(`● ${e.status}${e.message ? ` — ${e.message}` : ''}`);
          break;
        case 'assistant':
          console.log(`🤖 ${e.text}`);
          break;
        case 'action':
          console.log(`  #${e.step} ${describeAction(e.action)} → ${e.result.ok ? 'ok' : `ERROR ${e.result.error}`}${e.result.cursor ? ` cursor=(${e.result.cursor.x},${e.result.cursor.y})` : ''}`);
          break;
        case 'screenshot':
          console.log(
            e.jpegBase64
              ? `  📷 step ${e.step}: ${e.width}×${e.height}, ${Math.round((e.jpegBase64.length * 3) / 4 / 1024)} KB jpeg`
              : `  📷 step ${e.step}: no new screenshot (nothing she did could have changed the screen)`,
          );
          break;
        case 'needs_user':
          console.log(`✋ needs you: ${e.reason} (screen ${e.width}×${e.height}) — headless run: auto-resuming in 1.5s`);
          setTimeout(() => runner.resume(), 1500);
          break;
        case 'usage':
          console.log(`  tokens: in ${e.input} out ${e.output}`);
          break;
      }
    },
  });

  console.log(`provider=${adapter.name} computer=${computer.name} docs=${docs.size} pages`);
  console.log(`task: ${task}`);
  await runner.run(task);
  return runner.currentStatus === 'done' ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
