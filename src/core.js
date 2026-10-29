/** Host-independent linear workflow core. No model or command execution. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = message => { throw new Error(message); };
const text = (v, label) => typeof v === 'string' && v.trim() && v.length <= 16000 || fail(`invalid ${label}`);
const keys = (v, allowed) => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('expected object'); for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(`unknown field: ${k}`); };
function relative(file) {
  text(file, 'relative path');
  if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes('\\') || file.split('/').some(p => p === '..' || !p || p === '.')) fail('unsafe path');
  if (file.split('/')[0] === '.orchestrator') fail('state is not a delivery artifact');
}
function proofSpec(p) {
  keys(p, ['path', 'minBytes', 'contains', 'sha256']); relative(p.path);
  if (p.minBytes !== undefined && (!Number.isSafeInteger(p.minBytes) || p.minBytes < 1 || p.minBytes > 4e6)) fail('invalid minBytes');
  if (p.contains !== undefined) text(p.contains, 'content anchor');
  if (p.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(p.sha256)) fail('invalid sha256');
}
export function validate(def) {
  // JSON-only input; definitions are bounded before persisting or displaying them.
  if (JSON.stringify(def).length > 128000) fail('definition too large');
  keys(def, ['version', 'name', 'intent', 'references', 'nodes', 'deliveries']);
  if (def.version !== 1) fail('unsupported definition version'); text(def.name, 'name'); text(def.intent, 'AI restatement');
  if (!Array.isArray(def.nodes) || !def.nodes.length || def.nodes.length > 50) fail('invalid nodes');
  const ids = new Set();
  for (const n of def.nodes) {
    keys(n, ['id', 'type', 'mode', 'instruction', 'proofs', 'question']);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n.id) || ids.has(n.id)) fail('invalid/duplicate node id'); ids.add(n.id);
    if (!['task', 'gate', 'check'].includes(n.type)) fail('unsupported node');
    if (n.type === 'task') { if (!['agent', 'script'].includes(n.mode)) fail('invalid task mode'); text(n.instruction, 'instruction'); }
    else if (n.mode !== undefined || n.instruction !== undefined) fail('inapplicable task fields');
    if (n.type === 'gate') { text(n.question, 'question'); if (n.proofs !== undefined) fail('gate cannot declare proofs'); }
    else { if (n.question !== undefined) fail('inapplicable question'); if (!Array.isArray(n.proofs) || !n.proofs.length) fail('proofs required'); n.proofs.forEach(proofSpec); }
  }
  if (!Array.isArray(def.deliveries) || !def.deliveries.length) fail('deliveries required'); def.deliveries.forEach(proofSpec);
  if (def.references !== undefined) {
    keys(def.references, ['agent', 'intent', 'spec', 'plan']);
    for (const file of Object.values(def.references)) relative(file);
  }
  return clone(def);
}
/** Trusted local caller supplies confirmation attestations; the plugin creates them only from the human service. */
export class Orchestrator {
  constructor(workspace) {
    if (!path.isAbsolute(workspace || '')) fail('configure an absolute workspace');
    this.root = fs.realpathSync(workspace);
    if (!fs.statSync(this.root).isDirectory()) fail('workspace is not a directory');
    this.dir = path.join(this.root, '.orchestrator');
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { mode: 0o700 });
    if (fs.lstatSync(this.dir).isSymbolicLink() || fs.realpathSync(this.dir) !== this.dir) fail('unsafe state directory');
  }
  file(relativePath) {
    relative(relativePath);
    const target = path.join(this.root, relativePath);
    // Reject every symlink, including in intermediate components; no traversal outside workspace.
    let cursor = this.root;
    for (const part of relativePath.split('/')) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) fail('symlink artifact refused'); }
    const st = fs.statSync(target); if (!st.isFile() || st.size > 4e6) fail('artifact must be a regular file <=4MB');
    const data = fs.readFileSync(target); if (data.length > 4e6) fail('artifact grew beyond limit');
    return { path: relativePath, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, text: data.toString('utf8') };
  }
  baseline(proofs) {
    return proofs.map(p => { try { return { path: p.path, sha256: this.file(p.path).sha256 }; } catch (e) { if (e.code === 'ENOENT') return { path: p.path, sha256: null }; throw e; } });
  }
  prove(proofs, baseline) {
    return proofs.map(p => {
      const f = this.file(p.path);
      if (f.bytes < (p.minBytes ?? 1) || p.contains !== undefined && !f.text.includes(p.contains) || p.sha256 !== undefined && f.sha256 !== p.sha256) fail(`proof failed: ${p.path}`);
      if (baseline && baseline.find(b => b.path === p.path)?.sha256 === f.sha256) fail(`unchanged artifact: ${p.path}`);
      return { path: f.path, sha256: f.sha256, bytes: f.bytes };
    });
  }
  id(id) { if (fs.lstatSync(this.dir).isSymbolicLink() || fs.realpathSync(this.dir) !== this.dir) fail('unsafe state directory'); if (!/^[a-f0-9-]{36}$/.test(id)) fail('invalid run id'); return path.join(this.dir, `${id}.json`); }
  read(id, owner) {
    const f = this.id(id); if (fs.lstatSync(f).isSymbolicLink()) fail('unsafe run file');
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (s.version !== 1 || s.id !== id || s.definitionHash !== digest(s.definition)) fail('invalid run snapshot');
    if (s.owner !== owner) fail('run belongs to another session');
    return s;
  }
  save(s) {
    const target = this.id(s.id), temp = `${target}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(s, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, target);
      const dir = fs.openSync(this.dir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  transaction(id, owner, fn) {
    const lock = `${this.id(id)}.lock`; const fd = fs.openSync(lock, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid })); const s = this.read(id, owner); const result = fn(s); s.revision++; this.save(s); return result ?? clone(s); }
    finally { fs.closeSync(fd); fs.unlinkSync(lock); }
  }
  event(s, type, data = {}) { s.events.push({ at: new Date().toISOString(), type, ...data }); }
  create(definition, owner, confirmation) {
    text(owner, 'owner'); const def = validate(definition);
    if (!confirmation || confirmation.definitionHash !== digest(def) || confirmation.answer !== 'confirm') fail('human confirmation of exact definition required');
    const refs = Object.fromEntries(Object.entries(def.references ?? {}).map(([k, p]) => [k, this.file(p).sha256]));
    const s = { version: 1, id: randomUUID(), owner, revision: 0, definition: def, definitionHash: digest(def), references: refs, confirmation: clone(confirmation), status: 'ready', index: 0, active: null, receipts: [], events: [], deliveryBaseline: this.baseline(def.deliveries) };
    this.event(s, 'created'); this.save(s); return clone(s);
  }
  next(id, owner) {
    return this.transaction(id, owner, s => {
      if (s.status !== 'ready') fail(`cannot advance from ${s.status}`);
      for (const [key, file] of Object.entries(s.definition.references ?? {})) if (this.file(file).sha256 !== s.references[key]) fail(`referenced project document changed: ${key}`);
      while (s.index < s.definition.nodes.length) {
        const n = s.definition.nodes[s.index];
        if (n.type === 'check') { const evidence = this.prove(n.proofs); s.receipts.push({ node: n.id, evidence }); this.event(s, 'checked', { node: n.id }); s.index++; continue; }
        if (n.type === 'gate') { s.status = 'waiting-human'; s.active = { operation: randomUUID(), node: n.id }; this.event(s, 'gate', s.active); return; }
        s.status = 'waiting-action'; s.active = { operation: randomUUID(), node: n.id, baseline: this.baseline(n.proofs) }; this.event(s, 'action-issued', { operation: s.active.operation, node: n.id }); return;
      }
      const evidence = this.prove(s.definition.deliveries, s.deliveryBaseline); s.receipts.push({ delivery: true, evidence }); s.status = 'done'; this.event(s, 'done');
    });
  }
  complete(id, owner, operation) {
    return this.transaction(id, owner, s => {
      if (s.status !== 'waiting-action' || s.active?.operation !== operation) fail('stale or invalid operation');
      const n = s.definition.nodes[s.index], evidence = this.prove(n.proofs, s.active.baseline);
      s.receipts.push({ node: n.id, operation, evidence }); this.event(s, 'action-verified', { node: n.id, operation }); s.index++; s.active = null; s.status = 'ready';
    });
  }
  decide(id, owner, operation, answer, human) {
    return this.transaction(id, owner, s => {
      if (s.status !== 'waiting-human' || s.active?.operation !== operation || human?.operation !== operation || !['confirm', 'reject'].includes(answer) || human.answer !== answer) fail('human gate decision required');
      this.event(s, 'human-decision', { node: s.active.node, answer, human: clone(human) });
      if (answer === 'confirm') { s.index++; s.status = 'ready'; } else s.status = 'cancelled'; s.active = null;
    });
  }
  pause(id, owner) { return this.transaction(id, owner, s => { if (!['ready', 'waiting-action', 'waiting-human'].includes(s.status)) fail('cannot pause'); s.pausedFrom = s.status; s.status = 'paused'; this.event(s, 'paused'); }); }
  resume(id, owner) { return this.transaction(id, owner, s => { if (s.status !== 'paused') fail('not paused'); s.status = s.pausedFrom; delete s.pausedFrom; this.event(s, 'resumed'); }); }
  cancel(id, owner) {
    return this.transaction(id, owner, s => {
      if (['done', 'cancelled'].includes(s.status)) fail('already terminal');
      s.status = s.active && (s.status === 'waiting-action' || s.pausedFrom === 'waiting-action') ? 'cancel-requested' : 'cancelled';
      this.event(s, s.status, { effect: s.status === 'cancel-requested' ? 'unknown: external action may still be running' : 'no active external action' });
    });
  }
  recover(id, owner) {
    // Read-only recovery: show the existing action ID; never create or redispatch it.
    return this.read(id, owner);
  }
  reconcile(id, owner, operation, decision, human) {
    return this.transaction(id, owner, s => {
      if (!['waiting-action', 'cancel-requested'].includes(s.status) || s.active?.operation !== operation || human?.operation !== operation || human.answer !== decision) fail('human reconciliation required');
      if (decision === 'verified') {
        const n = s.definition.nodes[s.index]; const evidence = this.prove(n.proofs, s.active.baseline);
        s.receipts.push({ node: n.id, operation, evidence, recovered: true }); s.index++; s.status = s.status === 'cancel-requested' ? 'cancelled' : 'ready';
      } else if (decision === 'stopped') s.status = 'cancelled';
      else fail('unsupported reconciliation');
      this.event(s, 'human-reconciled', { operation, decision, human: clone(human) }); s.active = null;
    });
  }
}
