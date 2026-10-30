import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { instantiateTemplate } from '../src/template.js';
const template = () => JSON.parse(fs.readFileSync(new URL('../examples/parameterized-template.json', import.meta.url), 'utf8'));
test('template compilation snapshots explicit values and isolates output paths for every run', () => {
  const a = instantiateTemplate(template(), { topic: '质量改善' });
  const b = instantiateTemplate(template(), { topic: '质量改善' });
  assert.notEqual(a.runKey, b.runKey); assert.equal(a.parameters.audience, '个人内部');
  assert.match(a.definition.intent, /质量改善/);
  assert.ok(a.definition.deliveries[0].path.includes(a.runKey));
  assert.ok(!a.definition.deliveries[0].path.includes('{{'));
  assert.equal(a.definition.nodes[0].proofs[0].path, a.definition.deliveries[0].path);
});
test('template rejects unknown/out-of-range parameters, shared paths and variable project references', () => {
  for (const values of [{ unknown: 'x' }, { windowHours: 0 }, { audience: '公开' }, { topic: '' }]) assert.throws(() => instantiateTemplate(template(), values));
  const shared = template(); shared.definition.deliveries[0].path = 'output/shared.md';
  assert.throws(() => instantiateTemplate(shared), /every artifact/);
  const refs = template(); refs.definition.references = { agent: '{{topic}}/AGENT.md' };
  assert.throws(() => instantiateTemplate(refs), /references/);
  const unknown = template(); unknown.definition.name = '{{absent}}';
  assert.throws(() => instantiateTemplate(unknown), /undefined/);
  const missing = template(); delete missing.definition.intent;
  assert.throws(() => instantiateTemplate(missing), /intent/);
});
