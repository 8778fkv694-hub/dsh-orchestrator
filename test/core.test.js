import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator, validate, digest } from '../src/core.js';
const definition = () => ({ version: 1, name: 'Test', intent: 'Write and verify a report', nodes: [{ id: 'write', type: 'task', mode: 'agent', instruction: 'Produce report', proofs: [{ path: 'out.txt', contains: 'ok' }] }], deliveries: [{ path: 'out.txt', contains: 'ok' }] });
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-')); t.after(() => fs.rmSync(root, { force: true, recursive: true })); const e = new Orchestrator(root), d = definition(); const create = (def = d) => e.create(def, 'owner', { answer: 'confirm', definitionHash: digest(def), source: 'test-fixture' }); return { e, root, d, create, write: data => fs.writeFileSync(path.join(root, 'out.txt'), data) }; }
test('full lifecycle verifies independent artifacts', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); assert.equal(s.status, 'waiting-action'); f.write('ok'); s = f.e.complete(s.id, 'owner', s.active.operation); s = f.e.next(s.id, 'owner'); assert.equal(s.status, 'done'); assert.equal(s.receipts.at(-1).delivery, true); });
test('claim binds to a live operation and survives pause and recovery without replay', t => {
  const f = fixture(t); let s = f.create();
  assert.throws(() => f.e.claim(s.id, 'owner', 'stale', 'worker'), /unavailable/);
  s = f.e.next(s.id, 'owner'); const op = s.active.operation;
  assert.throws(() => f.e.claim(s.id, 'other', op, 'worker'), /another session/);
  assert.throws(() => f.e.claim(s.id, 'owner', 'stale', 'worker'), /unavailable/);
  s = f.e.claim(s.id, 'owner', op, 'worker', 'test-fixture');
  assert.equal(s.active.claim.actor, 'worker'); assert.equal(s.status, 'waiting-action');
  assert.throws(() => f.e.claim(s.id, 'owner', op, 'worker'), /already claimed/);
  s = f.e.pause(s.id, 'owner');
  assert.throws(() => f.e.claim(s.id, 'owner', op, 'worker'), /unavailable/);
  s = f.e.resume(s.id, 'owner');
  assert.equal(f.e.recover(s.id, 'owner').active.claim.actor, 'worker');
  assert.equal(s.active.operation, op);
  assert.throws(() => f.e.complete(s.id, 'owner', op), /ENOENT/);
});
test('raw or mismatched intent cannot create a run', t => { const f = fixture(t); assert.throws(() => f.e.create(f.d, 'owner', {})); assert.throws(() => f.e.create(f.d, 'owner', { answer: 'confirm', definitionHash: 'wrong' })); assert.equal(fs.readdirSync(f.e.dir).length, 0); });
test('definition schema rejects unknown nodes fields versions paths and numbers', () => { for (const mutate of [d => d.version = 2, d => d.nodes[0].type = 'unknown', d => d.nodes.push(d.nodes[0]), d => d.nodes[0].execute = 'rm', d => d.nodes[0].proofs[0].path = '../secret', d => d.deliveries[0].minBytes = NaN]) { const d = definition(); mutate(d); assert.throws(() => validate(d)); } });
test('definition and receipt returned to caller are detached snapshots', t => { const f = fixture(t), s = f.create(); f.d.name = 'Changed'; s.definition.name = 'Changed again'; assert.equal(f.e.read(s.id, 'owner').definition.name, 'Test'); });
test('another session cannot inspect or mutate runs', t => { const f = fixture(t), s = f.create(); assert.throws(() => f.e.read(s.id, 'other')); assert.throws(() => f.e.next(s.id, 'other')); assert.equal(f.e.read(s.id, 'owner').status, 'ready'); });
test('missing, stale operation and unchanged files cannot advance', t => { const f = fixture(t); f.write('ok'); let s = f.create(); s = f.e.next(s.id, 'owner'); assert.throws(() => f.e.complete(s.id, 'owner', s.active.operation), /unchanged/); f.write('ok new'); assert.throws(() => f.e.complete(s.id, 'owner', 'stale')); fs.unlinkSync(path.join(f.root, 'out.txt')); assert.throws(() => f.e.complete(s.id, 'owner', s.active.operation)); assert.equal(f.e.read(s.id, 'owner').status, 'waiting-action'); });
test('wrong evidence and missing final delivery refuse done', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); f.write('bad'); assert.throws(() => f.e.complete(s.id, 'owner', s.active.operation), /proof failed/); f.write('ok'); s = f.e.complete(s.id, 'owner', s.active.operation); fs.unlinkSync(path.join(f.root, 'out.txt')); assert.throws(() => f.e.next(s.id, 'owner')); assert.equal(f.e.read(s.id, 'owner').status, 'ready'); });
test('restart returns original action and cannot reissue it', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); const restored = new Orchestrator(f.root).recover(s.id, 'owner'); assert.equal(restored.active.operation, s.active.operation); assert.throws(() => f.e.next(s.id, 'owner')); assert.deepEqual(f.e.read(s.id, 'owner').events, s.events); });
test('pause and resume preserve unknown effect action', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); const op = s.active.operation; f.e.pause(s.id, 'owner'); s = f.e.resume(s.id, 'owner'); assert.equal(s.active.operation, op); assert.equal(s.status, 'waiting-action'); });
test('active cancellation remains requested until human reconciliation', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); s = f.e.cancel(s.id, 'owner'); assert.equal(s.status, 'cancel-requested'); assert.throws(() => f.e.next(s.id, 'owner')); assert.throws(() => f.e.reconcile(s.id, 'owner', s.active.operation, 'stopped', {})); s = f.e.reconcile(s.id, 'owner', s.active.operation, 'stopped', { operation: s.active.operation, answer: 'stopped' }); assert.equal(s.status, 'cancelled'); });
test('recovery with verified output advances only with evidence', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); const human = { operation: s.active.operation, answer: 'verified' }; assert.throws(() => f.e.reconcile(s.id, 'owner', s.active.operation, 'verified', human)); f.write('ok'); s = f.e.reconcile(s.id, 'owner', s.active.operation, 'verified', human); assert.equal(s.status, 'ready'); assert.equal(f.e.next(s.id, 'owner').status, 'done'); });
test('gate rejects forged or stale decisions; human rejection cancels', t => { const f = fixture(t); f.d.nodes.unshift({ id: 'approve', type: 'gate', question: 'Proceed?' }); let s = f.create(); s = f.e.next(s.id, 'owner'); assert.equal(s.status, 'waiting-human'); assert.throws(() => f.e.decide(s.id, 'owner', 'stale', 'confirm', {})); const human = { operation: s.active.operation, answer: 'reject' }; s = f.e.decide(s.id, 'owner', s.active.operation, 'reject', human); assert.equal(s.status, 'cancelled'); });
test('accepted gate continues without repeating confirmation', t => { const f = fixture(t); f.d.nodes.unshift({ id: 'approve', type: 'gate', question: 'Proceed?' }); let s = f.create(); s = f.e.next(s.id, 'owner'); s = f.e.decide(s.id, 'owner', s.active.operation, 'confirm', { operation: s.active.operation, answer: 'confirm' }); s = f.e.next(s.id, 'owner'); assert.equal(s.definition.nodes[s.index].id, 'write'); });
test('symlink evidence, state directory, and state files refused', t => { const f = fixture(t); fs.symlinkSync(path.join(f.root, 'other'), path.join(f.root, 'out.txt')); assert.throws(() => f.create(), /symlink/); fs.unlinkSync(path.join(f.root, 'out.txt')); const s = f.create(); fs.renameSync(f.e.id(s.id), `${f.e.id(s.id)}.real`); fs.symlinkSync(`${f.e.id(s.id)}.real`, f.e.id(s.id)); assert.throws(() => f.e.read(s.id, 'owner'), /unsafe/); });
test('write failure cannot emit an unsaved work order', t => { const f = fixture(t), s = f.create(); f.e.save = () => { throw new Error('injected disk failure'); }; assert.throws(() => f.e.next(s.id, 'owner'), /disk failure/); assert.equal(f.e.read(s.id, 'owner').status, 'ready'); });
test('concurrent writer lock fails without changing snapshot', t => { const f = fixture(t), s = f.create(), lock = `${f.e.id(s.id)}.lock`; fs.writeFileSync(lock, 'held'); assert.throws(() => f.e.next(s.id, 'owner'), /EEXIST/); assert.equal(f.e.read(s.id, 'owner').revision, 0); });
test('preflight references pin exact file contents', t => { const f = fixture(t); fs.writeFileSync(path.join(f.root, 'AGENT.md'), 'rules v1'); f.d.references = { agent: 'AGENT.md' }; const s = f.create(); fs.writeFileSync(path.join(f.root, 'AGENT.md'), 'rules v2'); assert.notEqual(s.references.agent, f.e.file('AGENT.md').sha256); assert.throws(() => f.e.next(s.id, 'owner'), /document changed/); });
test('replacing the state directory with a symlink after construction is refused', t => { const f = fixture(t), s = f.create(); const moved = path.join(f.root, 'old-state'); fs.renameSync(f.e.dir, moved); fs.symlinkSync(moved, f.e.dir); assert.throws(() => f.e.read(s.id, 'owner'), /unsafe state/); });
test('verified reconciliation after cancellation cannot resume the cancelled workflow', t => { const f = fixture(t); let s = f.create(); s = f.e.next(s.id, 'owner'); const op = s.active.operation; f.write('ok'); s = f.e.cancel(s.id, 'owner'); assert.equal(s.status, 'cancel-requested'); s = f.e.reconcile(s.id, 'owner', op, 'verified', { operation: op, answer: 'verified', source: 'test-fixture' }); assert.equal(s.status, 'cancelled'); assert.equal(s.receipts.at(-1).recovered, true); assert.throws(() => f.e.next(s.id, 'owner')); });


test('option gate validates declared values and records the selected option', t => {
  const f = fixture(t);
  f.d.nodes.unshift({ id: 'pick', type: 'gate', question: 'Pick a topic', options: ['综合', 'AI / 大模型'] });
  let s = f.create();
  s = f.e.next(s.id, 'owner');
  assert.equal(s.status, 'waiting-human');
  assert.throws(() => f.e.decide(s.id, 'owner', s.active.operation, 'not-an-option', { operation: s.active.operation, answer: 'not-an-option' }));
  s = f.e.decide(s.id, 'owner', s.active.operation, 'AI / 大模型', { operation: s.active.operation, answer: 'AI / 大模型' });
  assert.equal(s.status, 'ready');
  assert.equal(s.events.at(-1).answer, 'AI / 大模型');
  assert.equal(s.definition.nodes[s.index].id, 'write');
});

test('invalid gate options are rejected at definition time', t => {
  const f = fixture(t);
  const bad = { ...f.d, nodes: [{ id: 'g', type: 'gate', question: 'Pick', options: ['dup', 'dup'] }, ...f.d.nodes] };
  assert.throws(() => f.e.create(bad, 'owner', { answer: 'confirm', definitionHash: digest(bad), source: 'fixture' }));
  const empty = { ...f.d, nodes: [{ id: 'g', type: 'gate', question: 'Pick', options: [] }, ...f.d.nodes] };
  assert.throws(() => f.e.create(empty, 'owner', { answer: 'confirm', definitionHash: digest(empty), source: 'fixture' }));
  const tooMany = { ...f.d, nodes: [{ id: 'g', type: 'gate', question: 'Pick', options: Array.from({ length: 31 }, (_, i) => 'o' + i) }, ...f.d.nodes] };
  assert.throws(() => f.e.create(tooMany, 'owner', { answer: 'confirm', definitionHash: digest(tooMany), source: 'fixture' }));
});
