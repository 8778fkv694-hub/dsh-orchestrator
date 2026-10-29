/** Pure script driver: known local code, no model calls or hidden shell. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Orchestrator, digest } from '../src/core.js';
import { driveScripts } from '../src/driver.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-demo-'));
try {
  const def = { version: 1, name: 'Script example', intent: 'Produce and verify a computed report in an isolated demonstration.', nodes: [{ id: 'compute', type: 'task', mode: 'script', instruction: 'Compute sum from fixed fixture', proofs: [{ path: 'sum.json', contains: '42' }] }], deliveries: [{ path: 'sum.json', contains: '42' }] };
  const e = new Orchestrator(root);
  let s = e.create(def, 'example-fixture', { answer: 'confirm', definitionHash: digest(def), source: 'synthetic-example-not-user-approval' });
  s = await driveScripts(e, s.id, s.owner, { compute: async () => {
    fs.writeFileSync(path.join(root, 'sum.json'), JSON.stringify({ sum: [10, 12, 20].reduce((a, b) => a + b, 0) }));
  } });
  if (s.status !== 'done') throw new Error('Demo did not complete');
  console.log(JSON.stringify({ status: s.status, modelCalls: 0, evidence: s.receipts.at(-1).evidence }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
