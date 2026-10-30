import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorkspace } from '../src/doctor.js';

test('doctor is read-only and does not invent plugin installation evidence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = inspectWorkspace(root);
  assert.equal(report.ok, true); assert.equal(fs.existsSync(path.join(root, '.orchestrator')), false);
  assert.equal(report.checks.find(c => c.id === 'harness').status, 'unknown');
  assert.equal(report.checks.find(c => c.id === 'pipelines').status, 'warn');
  assert.equal(inspectWorkspace(path.join(root, 'missing')).ok, false);
  fs.mkdirSync(path.join(root, 'pipelines'));
  fs.writeFileSync(path.join(root, 'pipelines/bad.json'), '{}');
  assert.equal(inspectWorkspace(root).checks.find(c => c.id === 'pipelines').status, 'warn');
});
