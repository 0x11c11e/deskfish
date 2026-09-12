// Memory v2 in the system prompt: the self note sits near the head (after the how-to list, the tank
// note and the charter), journal and memory notes are present, the self/journal tools are offered
// only when a self exists, and refreshNotes() swaps the notes without resetting the conversation.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicAdapter } from '../src/agent/adapters/anthropic';
import type { AgentNotes, Observation } from '../src/agent/adapters/types';

let n = 0;
const ok = (c: unknown, m: string) => { assert.ok(c, m); n++; };

// ---------- fake Anthropic API: always clicks ----------
const bodies: any[] = [];
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    bodies.push(JSON.parse(data));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_sequence: null, stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: `tu_${bodies.length}`, name: 'computer', input: { action: 'left_click', coordinate: [1, 1] } }] }));
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;

const jpeg = Buffer.from('ffd8ffd9', 'hex');
const obs = (results: Observation['results'] = []): Observation => ({ image: { jpeg, width: 640, height: 400 }, results });
const systemText = (body: any) => body.system.map((b: any) => b.text).join('\n');
const toolNames = (body: any): string[] => body.tools.map((t: any) => t.name);
const SELF_TOOLS = ['revise_self', 'restore_self', 'self_history', 'recall', 'note_to_self'];
const PLAYBOOK_TOOLS = ['save_playbook', 'read_playbook'];
const base = { provider: 'anthropic' as const, model: 'claude-test', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'dummy', refusalFallback: false };

try {
  const state: AgentNotes = {
    charter: 'CHARTER-LINE: be honest with the person you work for.',
    memory: '- MEMORY-FACT: the user likes short answers',
    self: 'SELF-V1: I am careful and I say when I am unsure.',
    selfStatus: 'ok',
    journal: 'JOURNAL-ENTRY: done · 3 steps · $0.01 — Task: check the weather — sunny',
    playbooks: 'PLAYBOOK-TITLE: How to log in to the demo shop',
  };
  const adapter = new AnthropicAdapter({ ...base, notes: () => ({ ...state }) });
  adapter.start('who am I', { width: 640, height: 400 });
  await adapter.step(obs());
  const sys = systemText(bodies[0]);
  const at = (needle: string) => sys.indexOf(needle);
  const howTo = at('How to work:');
  const charter = at('Your charter, from the person who made you');
  const self = at('Who you are, in your own words');
  ok(self >= 0 && sys.includes('SELF-V1: I am careful'), 'the self note is in the system prompt with the self text');
  ok(howTo >= 0 && self > howTo, 'the self note comes after the how-to list');
  ok(charter > howTo && self > charter && sys.includes('CHARTER-LINE'), 'the charter (with its text) sits between the how-to list and the self');
  ok(self - howTo <= 9000, `the self sits near the head: ${self - howTo} chars after "How to work"`);
  ok(at('What you have:') > howTo && at('What you have:') < self, 'the tank note precedes the self');
  ok(at('Underneath, you currently run on the model') > at('What you have:') && at('Underneath, you currently run on the model') < charter, 'the model note sits between the tank note and the charter');
  ok(sys.includes('Recently, from your journal') && sys.includes('JOURNAL-ENTRY'), 'the journal note is present with the entries');
  ok(sys.includes('Long-term memory') && sys.includes('MEMORY-FACT'), 'the memory note is present with the facts');
  ok(sys.includes('Your playbooks') && sys.includes('PLAYBOOK-TITLE') && at('Your playbooks') > at('Recently, from your journal'), 'the playbook note is present, after the journal');
  const tools = toolNames(bodies[0]);
  ok(SELF_TOOLS.every((t) => tools.includes(t)), `the five self/journal tools are offered: ${tools.join(', ')}`);
  ok(PLAYBOOK_TOOLS.every((t) => tools.includes(t)) && tools.includes('remember') && tools.includes('forget'), 'playbook and memory tools are offered too');
  ok(new Set(tools).size === tools.length, 'no tool is offered twice');

  // Without a self: no self/journal/playbook tools, no self or journal note; memory alone still works.
  const plain = new AnthropicAdapter({ ...base, notes: () => ({ memory: '- MEMORY-FACT' }) });
  plain.start('plain', { width: 640, height: 400 });
  await plain.step(obs());
  const plainTools = toolNames(bodies[1]);
  ok([...SELF_TOOLS, ...PLAYBOOK_TOOLS].every((t) => !plainTools.includes(t)) && plainTools.includes('remember'), `without a self only remember/forget are offered: ${plainTools.join(', ')}`);
  const plainSys = systemText(bodies[1]);
  ok(!plainSys.includes('Who you are, in your own words') && !plainSys.includes('Recently, from your journal') && plainSys.includes('Long-term memory'), 'without a self: no self note, no journal note, memory note present');

  // refreshNotes(): the self changed outside → new text, tamper notice, last signed version; the conversation goes on.
  state.self = 'SELF-V2: someone rewrote me.';
  state.selfStatus = 'tampered';
  state.selfLastSigned = 'SELF-V1: I am careful and I say when I am unsure.';
  adapter.refreshNotes();
  await adapter.step(obs([{ ok: true }]));
  const sys2 = systemText(bodies[2]);
  ok(sys2.includes('SELF-V2: someone rewrote me') && !/Who you are[^]*?SELF-V1[^]*?Notice/.test(sys2), 'refreshNotes swapped the self text');
  ok(sys2.includes('Notice: this file no longer carries your signature') && sys2.indexOf('SELF-V1') > sys2.indexOf('The last version you signed yourself was'), 'the tamper notice and the last signed version are added');
  ok(bodies[2].messages.length === 3 && bodies[2].messages[0].role === 'user' && bodies[2].messages[0].content[0].text.startsWith('Task: who am I') && bodies[2].messages[2].content[0].type === 'tool_result', 'the conversation was not reset (task, assistant, tool_result)');
} finally {
  server.close();
}

console.log(`self-prompt: ${n} checks passed`);
