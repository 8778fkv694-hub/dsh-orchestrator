import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Orchestrator, digest } from '../src/core.js';
import { driveScripts } from '../src/driver.js';
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-driver-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const e = new Orchestrator(root), d = { version: 1, name: 'driver', intent: 'fixture', nodes: [{ id: 'script', type: 'task', mode: 'script', instruction: 'produce output', proofs: [{ path: 'out', contains: '42' }] }], deliveries: [{ path: 'out', contains: '42' }] }; const s = e.create(d, 'fixture', { answer: 'confirm', definitionHash: digest(d), source: 'test-fixture' }); return { e, s, root }; }
test('trusted script driver completes without a model', async t => { const { e, s, root } = fixture(t); let calls = 0; const done = await driveScripts(e, s.id, s.owner, { script: async () => { calls++; fs.writeFileSync(path.join(root, 'out'), '42'); } }); assert.equal(done.status, 'done'); assert.equal(calls, 1); });
test('driver never replays failed executor after restart', async t => { const { e, s } = fixture(t); let calls = 0; const exec = { script: async () => { calls++; throw new Error('unknown external outcome'); } }; await assert.rejects(driveScripts(e, s.id, s.owner, exec)); await assert.rejects(driveScripts(new Orchestrator(e.root), s.id, s.owner, exec), /unknown action/); assert.equal(calls, 1); });
test('driver forwards cancellation and does not certify completion', async t => { const { e, s, root } = fixture(t); const c = new AbortController(); await assert.rejects(driveScripts(e, s.id, s.owner, { script: async ({ signal }) => { assert.equal(signal, c.signal); fs.writeFileSync(path.join(root, 'out'), '42'); c.abort(); } }, { signal: c.signal })); assert.equal(e.read(s.id, s.owner).status, 'waiting-action'); });
