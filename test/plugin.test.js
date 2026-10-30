import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/plugin.js';
import { createRequire } from 'node:module';
const { parseHarnessResult } = createRequire(import.meta.url)('../scripts/harness-result.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-plugin-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tools = new Map(), disposers = [], asked = []; let respond = 'confirm';
  const ctx = { effect(fn) { disposers.push(fn()); }, tools: { register(d) { tools.set(d.name, d); } }, userQuestions: { async ask(r) { asked.push(r); if (respond === 'error') throw new Error('no provider'); if (respond === 'wait') return new Promise((resolve, reject) => r.signal.addEventListener('abort', () => reject(r.signal.reason), { once: true })); return { answers: [{ id: r.questions[0].id, selected: respond === 'none' ? [] : [respond] }] }; } } };
  apply(ctx, { workspace: root, questionTimeoutMs: 1000 });
  const exec = { agent: { id: 'agent', session: { id: 'session' } }, signal: new AbortController().signal };
  const call = (n, a = {}, x = exec) => tools.get(n).execute(a, x);
  const def = { version: 1, name: 'fixture', intent: 'Test candidate intent', nodes: [{ id: 'write', type: 'task', mode: 'agent', instruction: 'write result', proofs: [{ path: 'out.txt', contains: 'ok' }] }, { id: 'review', type: 'gate', question: 'Accept?' }], deliveries: [{ path: 'out.txt', contains: 'ok' }] };
  return { root, call, tools, asked, exec, def, set: v => respond = v, dispose: () => disposers.forEach(d => d()) };
}
test('adapter calls host question seam with full restatement and exact definition before creation', async t => { const f = fixture(t); const s = await f.call('orch_create', { definition: f.def }); assert.equal(s.confirmation.source, 'harness.userQuestions'); assert.ok(f.asked[0].questions[0].question.includes(f.def.intent)); assert.ok(f.asked[0].questions[0].question.includes('out.txt')); assert.equal(s.status, 'ready'); });
test('host claim records the actual caller and status reads never imply a claim', async t => {
  const f = fixture(t); let s = await f.call('orch_create', { definition: f.def });
  s = await f.call('orch_next', { run: s.id }); const operation = s.active.operation;
  assert.equal((await f.call('orch_status', { run: s.id })).active.claim, undefined);
  s = await f.call('orch_claim', { run: s.id, operation });
  assert.equal(s.active.claim.actor, 'agent'); assert.equal(s.active.claim.source, 'harness-tool');
  assert.equal(s.receipts.length, 0);
  await assert.rejects(f.call('orch_claim', { run: s.id, operation }), /already claimed/);
});
test('installed runtime probes decode rendered successful and rejected results', async t => {
  const f = fixture(t);
  for (const answer of ['confirm', 'reject']) {
    f.set(answer);
    const result = await f.call('orch_create', { definition: f.def });
    const content = f.tools.get('orch_create').output.render({}, result);
    assert.deepEqual(parseHarnessResult({ content }), result);
  }
  assert.deepEqual(parseHarnessResult({ content: [{ type: 'text', text: '{"legacy":true}' }] }), { legacy: true });
  assert.throws(() => parseHarnessResult({ content: [{ type: 'text', text: 'not JSON' }] }), /no structured/);
});
test('rejection/no provider/no answer never creates an accepted run', async t => { const f = fixture(t); f.set('reject'); assert.equal((await f.call('orch_create', { definition: f.def })).accepted, false); for (const answer of ['none', 'error']) { f.set(answer); await assert.rejects(f.call('orch_create', { definition: f.def })); } assert.equal(fs.existsSync(path.join(f.root, '.orchestrator')), false); });
test('plugin full mixed lifecycle with evidence, gate and final delivery', async t => { const f = fixture(t); let s = await f.call('orch_create', { definition: f.def }); s = await f.call('orch_next', { run: s.id }); assert.ok(s.guidance.includes('host-authorized')); await assert.rejects(f.call('orch_complete', { run: s.id, operation: s.active.operation })); fs.writeFileSync(path.join(f.root, 'out.txt'), 'ok'); s = await f.call('orch_complete', { run: s.id, operation: s.active.operation }); s = await f.call('orch_next', { run: s.id }); assert.equal(s.status, 'waiting-human'); s = await f.call('orch_gate', { run: s.id }); s = await f.call('orch_next', { run: s.id }); assert.equal(s.status, 'done'); assert.equal(f.asked.length, 2); });
test('plugin refuses missing caller and cross-session status', async t => { const f = fixture(t); await assert.rejects(f.call('orch_create', { definition: f.def }, { signal: f.exec.signal })); const s = await f.call('orch_create', { definition: f.def }); await assert.rejects(f.call('orch_status', { run: s.id }, { ...f.exec, agent: { session: { id: 'other' } } })); });
test('plugin unload aborts outstanding wait without accepting candidate', async t => { const f = fixture(t); f.set('wait'); const pending = f.call('orch_create', { definition: f.def }); f.dispose(); await assert.rejects(pending); await assert.rejects(f.call('orch_create', { definition: f.def }), /unloaded/); assert.equal(fs.existsSync(path.join(f.root, '.orchestrator')), false); });
test('no answer at human gate leaves pending gate and original operation', async t => { const f = fixture(t); f.def.nodes = [{ id: 'gate', type: 'gate', question: 'Continue?' }]; let s = await f.call('orch_create', { definition: f.def }); s = await f.call('orch_next', { run: s.id }); f.set('none'); await assert.rejects(f.call('orch_gate', { run: s.id })); const after = await f.call('orch_status', { run: s.id }); assert.equal(after.status, 'waiting-human'); assert.equal(after.active.operation, s.active.operation); });


test('plugin gate asks the host with declared options and records the selected option', async t => {
  const f = fixture(t);
  f.def.nodes = [{ id: 'pick', type: 'gate', question: 'Pick a topic', options: ['综合', 'AI / 大模型'] }];
  let s = await f.call('orch_create', { definition: f.def });
  s = await f.call('orch_next', { run: s.id });
  assert.equal(s.status, 'waiting-human');
  f.set('AI / 大模型');
  s = await f.call('orch_gate', { run: s.id });
  const question = f.asked.at(-1).questions[0];
  assert.deepEqual(question.options.map(o => o.label), ['综合', 'AI / 大模型']);
  assert.equal(s.status, 'ready');
  assert.equal(s.events.at(-1).type, 'human-decision');
  assert.equal(s.events.at(-1).answer, 'AI / 大模型');
});
