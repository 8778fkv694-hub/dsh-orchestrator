#!/usr/bin/env node
/**
 * Local dashboard for DSH Orchestrator.
 *
 * Read-only views of `.orchestrator/*.json` plus scheduling actions
 * (next/pause/resume/cancel) that only persist a work order. It never executes
 * a task, never starts external commands and never calls a model: human
 * confirmation, gates, reconciliation and delivery proof stay in the Harness
 * session. Binds loopback only; every request needs a per-process token.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Orchestrator, validate } from './core.js';

const RUN_ID = /^[a-f0-9-]{36}$/;
const MAX_READ = 4 * 1024 * 1024;
const ACTIONS = new Set(['next', 'pause', 'resume', 'cancel']);
const STATUS_META = {
  ready: { zh: '准备就绪', en: 'Ready', tone: 'ready' },
  'waiting-action': { zh: '等待执行结果', en: 'Awaiting result', tone: 'working' },
  'waiting-human': { zh: '待您决定', en: 'Your decision needed', tone: 'attention' },
  paused: { zh: '已暂停', en: 'Paused', tone: 'paused' },
  'cancel-requested': { zh: '正在核对取消', en: 'Cancellation unconfirmed', tone: 'attention' },
  cancelled: { zh: '已取消', en: 'Cancelled', tone: 'cancelled' },
  done: { zh: '交付已核验', en: 'Delivery verified', tone: 'done' }
};
const GUIDANCE = {
  'waiting-action': '等待执行结果：请在被控宿主（Harness 会话或 CLI）完成步骤并提交文件证据。',
  'waiting-human': '待您决定：人工门确认需要在 Harness 会话内由人完成。',
  'cancel-requested': '正在核对取消：外部动作状态未知，请在 Harness 会话内核对并选择 stopped/verified。',
  ready: '准备就绪：可发出下一步工作单。',
  paused: '已暂停：继续后调度恢复。',
  cancelled: '已取消：终态，不可再推进。',
  done: '交付已核验：终态。'
};

class ViewerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeJson = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
const labelOf = status => STATUS_META[status] ?? { zh: status, en: status, tone: 'unknown' };

function assertWorkspace(workspace) {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new ViewerError(400, '需要绝对值工作区路径');
  const root = path.resolve(workspace);
  let st;
  try {
    st = fs.statSync(root);
  } catch (error) {
    throw new ViewerError(400, `工作区不可访问：${error.message}`);
  }
  if (!st.isDirectory()) throw new ViewerError(400, '工作区不是目录');
  return root;
}

function validateState(state, id) {
  const bad = message => {
    throw new ViewerError(409, `运行快照不合法：${message}`);
  };
  if (!state || typeof state !== 'object' || Array.isArray(state)) bad('不是对象');
  if (state.version !== 1) bad('version');
  if (state.id !== id) bad('id 不匹配');
  if (typeof state.owner !== 'string' || !state.owner) bad('owner');
  if (!state.definition || typeof state.definition !== 'object') bad('definition');
  if (!Array.isArray(state.definition.nodes) || !Array.isArray(state.definition.deliveries)) bad('definition 结构');
  if (!Number.isSafeInteger(state.index) || state.index < 0) bad('index');
  if (!Array.isArray(state.events) || !Array.isArray(state.receipts)) bad('events/receipts');
  if (!STATUS_META[state.status]) bad('status');
  if (!state.definition.nodes.length || state.definition.nodes.length > 50) bad('definition.nodes 数量');
  if (!state.definition.deliveries.length) bad('definition.deliveries 为空');
  for (const node of state.definition.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) bad('node');
    if (typeof node.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(node.id)) bad('node.id');
    if (!['task', 'gate', 'check'].includes(node.type)) bad('node.type');
    if (node.proofs !== undefined) {
      if (!Array.isArray(node.proofs)) bad('node.proofs');
      for (const proof of node.proofs) {
        if (!proof || typeof proof !== 'object' || Array.isArray(proof) || typeof proof.path !== 'string') bad('node.proofs item');
      }
    }
  }
  for (const delivery of state.definition.deliveries) {
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery) || typeof delivery.path !== 'string') bad('delivery');
    if (delivery.sha256 !== undefined && (typeof delivery.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(delivery.sha256))) bad('delivery.sha256');
  }
  for (const event of state.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') bad('event');
  }
  for (const receipt of state.receipts) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) bad('receipt');
    if (receipt.evidence !== undefined && !Array.isArray(receipt.evidence)) bad('receipt.evidence');
    for (const evidence of receipt.evidence ?? []) {
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || typeof evidence.path !== 'string') bad('receipt.evidence item');
      if (evidence.sha256 !== undefined && typeof evidence.sha256 !== 'string') bad('receipt.evidence.sha256');
      if (evidence.bytes !== undefined && !Number.isSafeInteger(evidence.bytes)) bad('receipt.evidence.bytes');
    }
  }
  if (state.active !== null && state.active !== undefined) {
    if (typeof state.active !== 'object' || Array.isArray(state.active) || typeof state.active.operation !== 'string') bad('active');
  }
  return state;
}

function stateDir(workspace) {
  const dir = path.join(workspace, '.orchestrator');
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ViewerError(404, '没有运行目录');
    throw new ViewerError(409, `无法读取运行目录：${error.message}`);
  }
  if (st.isSymbolicLink()) throw new ViewerError(409, '拒绝符号链接形式的 .orchestrator 目录');
  if (!st.isDirectory()) throw new ViewerError(409, '.orchestrator 不是目录');
  return dir;
}

function readStateFile(workspace, id) {
  if (!RUN_ID.test(id)) throw new ViewerError(400, '运行 ID 不合法');
  const dir = stateDir(workspace);
  const file = path.join(dir, `${id}.json`);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new ViewerError(404, '没有这个运行');
    throw new ViewerError(409, `无法读取运行快照：${error.message}`);
  }
  if (st.isSymbolicLink()) throw new ViewerError(409, '拒绝符号链接形式的运行快照');
  if (!st.isFile()) throw new ViewerError(409, '运行快照不是普通文件');
  if (st.size > MAX_READ) throw new ViewerError(413, '运行快照超过 4MB 上限');
  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ViewerError(409, `运行快照不是合法 JSON：${error.message}`);
  }
  return validateState(state, id);
}

function lastEventMs(state) {
  const last = state.events[state.events.length - 1];
  const time = last && typeof last.at === 'string' ? Date.parse(last.at) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/** Read every valid run snapshot. Invalid files are reported, never trusted. */
export function loadRuns(workspace) {
  const root = assertWorkspace(workspace);
  const dir = path.join(root, '.orchestrator');
  let names;
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { runs: [], warnings: ['.orchestrator 不是安全的普通目录，已忽略'] };
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { runs: [], warnings: [] };
    return { runs: [], warnings: [`无法读取 .orchestrator：${error.message}`] };
  }
  const runs = [];
  const warnings = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!RUN_ID.test(id)) {
      warnings.push(`忽略非运行文件：${name}`);
      continue;
    }
    try {
      runs.push(readStateFile(root, id));
    } catch (error) {
      warnings.push(`忽略 ${name}：${error.message}`);
    }
  }
  runs.sort((a, b) => lastEventMs(b) - lastEventMs(a));
  return { runs, warnings };
}

/**
 * Read runnable pipeline definitions registered in the workspace.
 * Conventional locations: `pipelines/*.json` and `.orchestrator/pipelines/*.json`.
 * The dashboard only displays them; creating a run still goes through the Harness
 * session so the intent confirmation stays a real human decision.
 */
export function loadPipelines(workspace) {
  const root = assertWorkspace(workspace);
  const dirs = [path.join(root, 'pipelines'), path.join(root, '.orchestrator', 'pipelines')];
  const pipelines = [];
  const warnings = [];
  for (const dir of dirs) {
    let names;
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        warnings.push(`${path.relative(root, dir)} 不是安全的普通目录，已忽略`);
        continue;
      }
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      warnings.push(`无法读取 ${path.relative(root, dir)}：${error.message}`);
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const rel = path.relative(root, file);
      try {
        const st = fs.lstatSync(file);
        if (st.isSymbolicLink() || !st.isFile()) throw new Error('拒绝符号链接或非普通文件');
        if (st.size > MAX_READ) throw new Error('定义超过 4MB 上限');
        const definition = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
        pipelines.push({
          slug: name.slice(0, -'.json'.length),
          file: rel,
          name: definition.name,
          intent: definition.intent,
          nodes: definition.nodes.length,
          deliveries: definition.deliveries.length,
          references: Object.keys(definition.references ?? {}),
          updatedAt: new Date(st.mtimeMs).toISOString(),
          definition
        });
      } catch (error) {
        warnings.push(`忽略 ${rel}：${error.message}`);
      }
    }
  }
  pipelines.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { pipelines, warnings };
}

/**
 * Read-only listing of delivered outputs under <workspace>/output (recursive, bounded).
 * The dashboard only links to these files; it never writes or executes them.
 */
export function listOutputs(workspace) {
  const root = assertWorkspace(workspace);
  const base = path.join(root, 'output');
  const files = [];
  const warnings = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let names;
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        warnings.push(`${path.relative(root, dir)} 不是安全的普通目录，已忽略`);
        return;
      }
      names = fs.readdirSync(dir).sort();
    } catch (error) {
      if (error.code !== 'ENOENT') warnings.push(`无法读取 ${path.relative(root, dir)}：${error.message}`);
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const rel = path.relative(root, file);
      try {
        const st = fs.lstatSync(file);
        if (st.isSymbolicLink()) { warnings.push(`忽略符号链接 ${rel}`); continue; }
        if (st.isDirectory()) { walk(file, depth + 1); continue; }
        if (!st.isFile()) continue;
        if (st.size > MAX_READ) { warnings.push(`忽略超过 4MB 的输出 ${rel}`); continue; }
        files.push({ path: rel, name, bytes: st.size, updatedAt: new Date(st.mtimeMs).toISOString(), kind: outputKind(name) });
      } catch (error) {
        warnings.push(`忽略 ${rel}：${error.message}`);
      }
    }
  };
  walk(base, 0);
  files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { files, warnings };
}

function outputKind(name) {
  const ext = path.extname(name).toLowerCase();
  if (['.html', '.htm'].includes(ext)) return 'html';
  if (['.md', '.markdown'].includes(ext)) return 'markdown';
  if (['.json'].includes(ext)) return 'json';
  if (['.txt', '.log'].includes(ext)) return 'text';
  if (['.csv'].includes(ext)) return 'csv';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) return 'image';
  return 'file';
}

const CONTENT_TYPES = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  image: 'application/octet-stream',
  file: 'application/octet-stream'
};

/** Read one delivered output. Refuses anything outside <workspace>/output. */
export function readOutputFile(workspace, relativePath) {
  const root = assertWorkspace(workspace);
  if (typeof relativePath !== 'string' || !relativePath) throw new ViewerError(400, '缺少输出物路径');
  if (path.isAbsolute(relativePath) || relativePath.includes('\\')) throw new ViewerError(400, '输出物路径必须相对');
  const parts = relativePath.split('/');
  if (parts[0] !== 'output' || parts.some(part => part === '' || part === '.' || part === '..')) throw new ViewerError(400, '只允许 output/ 下的相对路径');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new ViewerError(409, '拒绝符号链接输出物');
  }
  const st = fs.statSync(cursor);
  if (!st.isFile()) throw new ViewerError(409, '输出物不是普通文件');
  if (st.size > MAX_READ) throw new ViewerError(413, '输出物超过 4MB 上限');
  const kind = outputKind(cursor);
  return { body: fs.readFileSync(cursor), kind, type: CONTENT_TYPES[kind] ?? 'application/octet-stream', name: path.basename(cursor), bytes: st.size };
}

function summarize(state) {
  const total = state.definition.nodes.length;
  const current = state.definition.nodes[state.index];
  const meta = labelOf(state.status);
  const receipts = state.receipts ?? [];
  return {
    id: state.id,
    name: state.definition.name,
    intent: state.definition.intent,
    status: state.status,
    statusZh: meta.zh,
    statusEn: meta.en,
    tone: meta.tone,
    index: state.index,
    total,
    revision: state.revision,
    owner: state.owner,
    currentStep: current ? { id: current.id, type: current.type } : null,
    activeOperation: state.active?.operation ?? null,
    updatedAt: state.events[state.events.length - 1]?.at ?? null,
    receiptCount: receipts.length,
    recoveredCount: receipts.filter(r => r.recovered).length,
    startedAt: state.events[0]?.at ?? null,
    deliveries: state.definition.deliveries.map(d => d.path),
    needsAttention: state.status === 'waiting-human' || state.status === 'cancel-requested'
  };
}

function artifactStatus(workspace, relativePath, recordedSha256) {
  const base = { path: relativePath, recordedSha256: recordedSha256 ?? null };
  try {
    if (typeof relativePath !== 'string' || !relativePath) return { ...base, status: 'invalid' };
    if (path.isAbsolute(relativePath) || relativePath.includes('\\')) return { ...base, status: 'unsafe' };
    const parts = relativePath.split('/');
    if (parts.some(part => part === '' || part === '.' || part === '..')) return { ...base, status: 'unsafe' };
    if (parts[0] === '.orchestrator') return { ...base, status: 'unsafe' };
    let cursor = workspace;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      if (fs.lstatSync(cursor).isSymbolicLink()) return { ...base, status: 'unsafe' };
    }
    const target = path.join(workspace, relativePath);
    const st = fs.statSync(target);
    if (!st.isFile() || st.size > MAX_READ) return { ...base, status: 'invalid' };
    const currentSha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return {
      ...base,
      status: recordedSha256 ? (currentSha256 === recordedSha256 ? 'match' : 'changed') : 'unrecorded',
      currentSha256,
      currentBytes: st.size
    };
  } catch (error) {
    return { ...base, status: error.code === 'ENOENT' ? 'missing' : 'error', detail: error.message };
  }
}

function collectArtifacts(workspace, state) {
  const seen = new Set();
  const out = [];
  for (const receipt of state.receipts ?? []) {
    for (const evidence of receipt.evidence ?? []) {
      if (!evidence || typeof evidence.path !== 'string') continue;
      const key = `${evidence.path}\u0000${evidence.sha256 ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...artifactStatus(workspace, evidence.path, evidence.sha256),
        recordedBytes: Number.isSafeInteger(evidence.bytes) ? evidence.bytes : null,
        node: receipt.node ?? null,
        delivery: receipt.delivery === true,
        recovered: receipt.recovered === true
      });
    }
  }
  return out;
}

function runSnapshot(workspace, readOnly) {
  const { runs, warnings } = loadRuns(workspace);
  const registry = loadPipelines(workspace);
  const outputs = listOutputs(workspace);
  return {
    generatedAt: new Date().toISOString(),
    workspace,
    readOnly,
    runs: runs.map(summarize),
    pipelines: registry.pipelines,
    outputs: outputs.files,
    warnings,
    pipelineWarnings: registry.warnings,
    outputWarnings: outputs.warnings
  };
}

function runDetail(workspace, id) {
  const state = readStateFile(workspace, id);
  return { run: state, artifacts: collectArtifacts(workspace, state) };
}

function applyAction(workspace, id, action) {
  if (!ACTIONS.has(action)) throw new ViewerError(404, `不支持的动作：${action}`);
  const state = readStateFile(workspace, id);
  if (typeof state.owner !== 'string' || !state.owner) throw new ViewerError(409, '运行缺少 owner，无法调度');
  let engine;
  try {
    engine = new Orchestrator(workspace);
  } catch (error) {
    throw new ViewerError(409, error.message);
  }
  let next;
  try {
    if (action === 'next') next = engine.next(id, state.owner);
    else if (action === 'pause') next = engine.pause(id, state.owner);
    else if (action === 'resume') next = engine.resume(id, state.owner);
    else next = engine.cancel(id, state.owner);
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    if (error?.code === 'EEXIST' || /\.lock\b/.test(message)) {
      throw new ViewerError(409, `运行正在被其他写入者占用（或存在遗留锁）。请确认没有其他进程写入后，手动处理 <workspace>/.orchestrator/${id}.json.lock 再重试。`);
    }
    throw new ViewerError(409, message.split(workspace).join('<workspace>'));
  }
  return {
    action,
    status: next.status,
    statusZh: labelOf(next.status).zh,
    operation: next.active?.operation ?? null,
    pausedFrom: next.pausedFrom ?? null,
    guidance: GUIDANCE[next.status] ?? ''
  };
}

// ---------------------------------------------------------------------------
// Local HTTP surface
// ---------------------------------------------------------------------------

const APP_JS = String.raw`(function () {
  'use strict';
  var boot = JSON.parse(document.getElementById('boot').textContent);
  var token = boot.token;
  var snapshot = boot.snapshot;
  var selectedRunId = null;
  var selectedPipelineFile = null;
  var runDetail = null;
  var view = 'board';
  var filter = 'all';
  var searchTerm = '';
  var live = false;
  var pollTimer = null;
  var evtSource = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function shortId(id) { return id ? String(id).slice(0, 8) : '—'; }
  function fmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function ago(iso) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    var sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (sec < 60) return '刚刚';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    return Math.floor(sec / 86400) + ' 天前';
  }
  var ICON = {
    play: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M5 3.5v9l8-4.5-8-4.5z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor"/></svg>',
    stop: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4h8v8H4z" fill="currentColor"/></svg>',
    resume: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 3.5v9l8-4.5-8-4.5z" fill="currentColor"/><path d="M3 3h1.4v10H3z" fill="currentColor" opacity=".55"/></svg>',
    close: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" stroke="currentColor" stroke-width="1.4"/></svg>',
    copy: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1.2" stroke="currentColor" fill="none"/><path d="M10.5 4V3.2A1.2 1.2 0 009.3 2H4.2A1.2 1.2 0 003 3.2v6.1c0 .66.54 1.2 1.2 1.2H5" stroke="currentColor" fill="none"/></svg>',
    search: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4" stroke="currentColor" fill="none"/><path d="M10 10l3.5 3.5" stroke="currentColor"/></svg>',
    refresh: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 019.2-4.1L13 2.5v4h-4l1.4-1.4A4 4 0 104 8" stroke="currentColor" fill="none"/></svg>',
    pipeline: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3" cy="8" r="1.6" fill="currentColor"/><circle cx="8" cy="4" r="1.6" fill="currentColor"/><circle cx="8" cy="12" r="1.6" fill="currentColor"/><circle cx="13" cy="8" r="1.6" fill="currentColor"/><path d="M4.4 7.3L6.6 4.9M4.4 8.7l2.2 2.4M9.4 4.9l2.2 2.4M9.4 11.1l2.2-2.4" stroke="currentColor" fill="none"/></svg>',
    alert: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 2.2l6 11.2H2L8 2.2z" stroke="currentColor" fill="none"/><path d="M8 6v3.2M8 11.4v.8" stroke="currentColor"/></svg>',
    check: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" fill="none" stroke-width="1.6"/></svg>'
  };
  function icon(name) { return ICON[name] || ''; }

  var STATUS = {
    ready: { zh: '准备就绪', en: 'Ready', tone: 'ready', icon: 'play' },
    'waiting-action': { zh: '等待执行结果', en: 'Awaiting result', tone: 'working', icon: 'clock' },
    'waiting-human': { zh: '待你决定', en: 'Your decision needed', tone: 'attention', icon: 'alert' },
    paused: { zh: '已暂停', en: 'Paused', tone: 'paused', icon: 'pause' },
    'cancel-requested': { zh: '正在核对取消', en: 'Cancellation unconfirmed', tone: 'attention', icon: 'alert' },
    cancelled: { zh: '已取消', en: 'Cancelled', tone: 'cancelled', icon: 'stop' },
    done: { zh: '交付已核验', en: 'Delivery verified', tone: 'done', icon: 'check' }
  };
  function statusOf(status) { return STATUS[status] || { zh: status, en: status, tone: 'unknown', icon: 'pipeline' }; }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ 'x-orch-viewer-token': token }, opts.headers || {});
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : ('HTTP ' + res.status));
        return body;
      });
    });
  }
  var toastTimer = null;
  function toast(message, isError) {
    var el = $('#toast');
    el.textContent = message;
    el.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 4800);
  }
  function copyText(text, label) {
    var done = function () { toast(label + '已复制'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
      return;
    }
    fallbackCopy(text);
    done();
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }
  function statusChip(status, compact) {
    var meta = statusOf(status);
    return '<span class="statusChip ' + meta.tone + (compact ? ' compact' : '') + '"><span class="dot"></span>' + esc(meta.zh) + '</span>';
  }
  function setLive(on, label) {
    live = on;
    var el = $('#live');
    el.className = 'live ' + (on ? 'on' : 'off');
    el.innerHTML = '<span class="dot"></span>' + esc(label || (on ? '实时' : '轮询兜底'));
  }
  function matches(text) {
    if (!searchTerm) return true;
    return String(text || '').toLowerCase().indexOf(searchTerm) >= 0;
  }
  function filteredRuns() {
    return (snapshot.runs || []).filter(function (run) {
      if (!matches(run.name + ' ' + run.intent + ' ' + run.id)) return false;
      if (filter === 'needs') return run.status === 'waiting-human';
      if (filter === 'active') return ['ready', 'waiting-action', 'paused', 'cancel-requested'].indexOf(run.status) >= 0;
      if (filter === 'done') return run.status === 'done';
      if (filter === 'cancelled') return run.status === 'cancelled';
      return true;
    });
  }
  function filteredPipelines() {
    return (snapshot.pipelines || []).filter(function (pipe) { return matches(pipe.name + ' ' + pipe.intent + ' ' + pipe.file); });
  }

  function renderHeader() {
    $('#workspace').textContent = snapshot.workspace;
    var mode = $('#mode');
    if (snapshot.readOnly) { mode.textContent = '只读模式'; mode.className = 'badge readonly'; }
    else { mode.textContent = '调度入口'; mode.className = 'badge actions'; }
    setLive(live);
  }
  function renderOverview() {
    var runs = snapshot.runs || [];
    var count = function (statuses) { return runs.filter(function (r) { return statuses.indexOf(r.status) >= 0; }).length; };
    var metrics = [
      { id: 'needs', label: '待你决定', value: count(['waiting-human']), tone: 'attention', hint: '需去 Harness 回答' },
      { id: 'active', label: '进行中', value: count(['ready', 'waiting-action', 'paused', 'cancel-requested']), tone: 'working', hint: '执行/等待/暂停' },
      { id: 'done', label: '已完成', value: count(['done']), tone: 'done', hint: '交付已核验' },
      { id: 'cancelled', label: '已取消', value: count(['cancelled']), tone: 'cancelled', hint: '终态' },
      { id: 'pipelines', label: '已登记管线', value: (snapshot.pipelines || []).length, tone: 'ready', hint: '可查看步骤流' }
    ];
    var html = '<div class="metrics">';
    metrics.forEach(function (m) {
      var active = (filter === m.id) || (m.id === 'pipelines' && filter === 'all' && selectedPipelineFile && !selectedRunId);
      html += '<button type="button" class="metric ' + m.tone + (active ? ' active' : '') + '" data-filter="' + m.id + '">';
      html += '<span class="metricValue">' + m.value + '</span><span class="metricLabel">' + esc(m.label) + '</span><span class="metricHint">' + esc(m.hint) + '</span></button>';
    });
    html += '</div>';
    var host = $('#overview');
    host.innerHTML = html;
    $$('.metric').forEach(function (el) {
      el.onclick = function () { filter = el.getAttribute('data-filter') === 'pipelines' ? 'all' : el.getAttribute('data-filter'); render(); };
    });
  }
  function pipelineCard(pipe) {
    var selected = selectedPipelineFile === pipe.file;
    return '<button type="button" class="pipelineCard' + (selected ? ' selected' : '') + '" data-pipeline="' + esc(pipe.file) + '">' +
      '<span class="pipeIcon">' + icon('pipeline') + '</span>' +
      '<span class="pipeBody"><span class="pipeName">' + esc(pipe.name) + '</span>' +
      '<span class="pipeIntent">' + esc(pipe.intent) + '</span>' +
      '<span class="pipeMeta">' + pipe.nodes + ' 节点 · ' + pipe.deliveries + ' 交付项 · ' + esc(pipe.file) + '</span></span></button>';
  }
  function renderLibrary() {
    var host = $('#library');
    var pipelines = filteredPipelines();
    var html = '<div class="panelTitle">' + icon('pipeline') + '<span>管线库</span><span class="count">' + pipelines.length + '</span></div>';
    if (!pipelines.length) {
      html += '<div class="emptySmall">' + (searchTerm ? '没有匹配的登记管线。' : '还没有登记管线。把可运行的管线定义 JSON 放到工作区 <code>pipelines/</code> 即可。') + '</div>';
    } else {
      html += '<div class="pipelineList">';
      pipelines.forEach(function (pipe) { html += pipelineCard(pipe); });
      html += '</div>';
    }
    if (snapshot.pipelineWarnings && snapshot.pipelineWarnings.length) {
      html += '<details class="warnBox"><summary>' + snapshot.pipelineWarnings.length + ' 条定义已跳过</summary><ul>' + snapshot.pipelineWarnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></details>';
    }
    host.innerHTML = html;
    $$('[data-pipeline]').forEach(function (el) {
      el.onclick = function () { selectPipeline(el.getAttribute('data-pipeline')); };
    });
  }
  function progressPct(run) { return run.total ? Math.round(100 * run.index / run.total) : 0; }
  function runCard(run) {
    var meta = statusOf(run.status);
    var selected = selectedRunId === run.id;
    var pct = progressPct(run);
    var hint = '';
    if (run.status === 'waiting-human') hint = '<span class="cardHint attention">需要你决定 · 去 Harness 回答</span>';
    else if (run.status === 'waiting-action') hint = '<span class="cardHint">等待执行者提交</span>';
    else if (run.status === 'cancel-requested') hint = '<span class="cardHint">外部动作状态未知</span>';
    return '<button type="button" class="runCard ' + meta.tone + (selected ? ' selected' : '') + '" data-run="' + esc(run.id) + '">' +
      '<span class="runStripe"></span>' +
      '<span class="runTop"><span class="statusChip ' + meta.tone + '"><span class="dot"></span>' + esc(meta.zh) + '</span>' +
      (run.recoveredCount ? '<span class="miniTag">恢复×' + run.recoveredCount + '</span>' : '') +
      '<span class="runTime">' + esc(ago(run.updatedAt)) + '</span></span>' +
      '<span class="runName">' + esc(run.name) + '</span>' +
      '<span class="runSub">' + esc(run.currentStep ? run.currentStep.id : '—') + ' · ' + run.index + '/' + run.total + ' · ' + shortId(run.id) + '</span>' +
      '<span class="runProgress"><span style="width:' + pct + '%"></span></span>' +
      hint +
      '</button>';
  }
  function group(html, title, runs, emptyText) {
    if (!runs.length) return html;
    html += '<div class="groupTitle">' + esc(title) + '<span class="count">' + runs.length + '</span></div>';
    runs.forEach(function (run) { html += runCard(run); });
    return html;
  }
  function renderBoard() {
    var host = $('#board');
    var runs = filteredRuns();
    var html = '<div class="boardHead"><div class="panelTitle">' + icon('pipeline') + '<span>运行</span><span class="count">' + runs.length + '</span></div>' +
      '<div class="boardHint">点击卡片查看步骤、证据与操作</div></div>';
    if (!runs.length) {
      html += '<div class="empty"><div class="emptyTitle">' + (searchTerm ? '没有匹配的运行' : '还没有运行记录') + '</div>' +
        '<div class="emptyHint">' + (searchTerm ? '清空搜索或切换筛选。' : '在 Harness 会话里用 <code>orch_create</code> 创建并确认，运行会实时出现在这里。') + '</div></div>';
    } else if (filter === 'all') {
      var needs = runs.filter(function (r) { return r.status === 'waiting-human'; });
      var active = runs.filter(function (r) { return ['ready', 'waiting-action', 'paused', 'cancel-requested'].indexOf(r.status) >= 0; });
      var finished = runs.filter(function (r) { return ['done', 'cancelled'].indexOf(r.status) >= 0; });
      html = group(html, '待你决定', needs);
      html = group(html, '进行中', active);
      html = group(html, '已完成 / 已取消', finished);
    } else {
      runs.forEach(function (run) { html += runCard(run); });
    }
    if (snapshot.warnings && snapshot.warnings.length) {
      html += '<details class="warnBox"><summary>' + snapshot.warnings.length + ' 条运行文件已跳过</summary><ul>' + snapshot.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></details>';
    }
    host.innerHTML = html;
    $$('[data-run]').forEach(function (el) {
      el.onclick = function () { selectRun(el.getAttribute('data-run')); };
    });
  }
  function actionButton(action, label, iconName, kind) {
    return '<button type="button" class="btn ' + (kind || '') + '" data-act="' + action + '">' + icon(iconName) + '<span>' + esc(label) + '</span></button>';
  }
  function actionsHtml(run) {
    if (snapshot.readOnly) return '<div class="note quiet">' + icon('alert') + '只读模式：调度按钮已关闭</div>';
    var status = run.status;
    var html = '<div class="actions">';
    if (status === 'ready') html += actionButton('next', '启动', 'play', 'primary');
    if (status === 'paused') html += actionButton('resume', '继续', 'resume', 'primary');
    if (['ready', 'waiting-action', 'waiting-human'].indexOf(status) >= 0) html += actionButton('pause', '暂停', 'pause');
    if (['ready', 'waiting-action', 'waiting-human', 'paused'].indexOf(status) >= 0) html += actionButton('cancel', '取消', 'stop', 'danger');
    html += '</div>';
    if (!html.replace('<div class="actions"></div>', '')) return '<div class="note quiet">当前状态没有可用的调度动作</div>';
    return html;
  }
  function stepFlow(run, currentIndex, definition) {
    var nodes = definition.nodes;
    var html = '<div class="flow">';
    nodes.forEach(function (node, i) {
      var state = 'pending';
      if (i < currentIndex) state = 'done';
      else if (i === currentIndex) state = 'current';
      if (run && run.status === 'waiting-human' && i === currentIndex) state = 'attention';
      html += '<div class="flowNode ' + state + '" title="' + esc(node.id + ' · ' + node.type) + '">' +
        '<span class="flowDot">' + (state === 'done' ? icon('check') : (node.type === 'gate' ? '◆' : String(i + 1))) + '</span>' +
        '<span class="flowLabel">' + esc(node.id) + '</span></div>';
      if (i < nodes.length - 1) html += '<span class="flowLink"></span>';
    });
    html += '</div>';
    return html;
  }
  function nodeDetails(definition, currentIndex) {
    return '<div class="nodeList">' + definition.nodes.map(function (node, i) {
      var state = i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'pending';
      var body = '';
      if (node.type === 'gate') body = '<div class="nodeQuestion">' + esc(node.question) + '</div>' +
        (Array.isArray(node.options) ? '<div class="nodeOptions">' + node.options.map(function (o) { return '<span class="optionPill">' + esc(o) + '</span>'; }).join('') + '</div>' : '<div class="nodeOptions"><span class="optionPill">confirm</span><span class="optionPill">reject</span></div>');
      else if (node.type === 'task') body = '<div class="nodeQuestion">' + esc(node.instruction) + '</div>';
      if (node.proofs && node.proofs.length) body += '<div class="nodeProofs">证据：' + esc(node.proofs.map(function (p) { return p.path; }).join(' · ')) + '</div>';
      return '<details class="nodeItem ' + state + '"' + (i === currentIndex ? ' open' : '') + '><summary><span class="nodeState">' + (state === 'done' ? icon('check') : (state === 'current' ? '●' : '○')) + '</span><span class="nodeId">' + esc(node.id) + '</span><span class="nodeType">' + esc(node.type) + '</span></summary>' + body + '</details>';
    }).join('') + '</div>';
  }
  function artifactsTable(artifacts) {
    if (!artifacts || !artifacts.length) return '<div class="emptySmall">还没有收据中的产物证据。</div>';
    var verdict = { match: '一致', changed: '已变化', missing: '缺失', unsafe: '路径不安全', invalid: '不是普通文件', unrecorded: '未记录哈希', error: '读取错误' };
    var html = '<div class="tableWrap"><table class="artifacts"><thead><tr><th>产物</th><th>收据 sha256</th><th>当前文件</th><th>判定</th></tr></thead><tbody>';
    artifacts.forEach(function (a) {
      html += '<tr><td class="mono">' + esc(a.path) + (a.recovered ? ' <span class="miniTag">恢复</span>' : '') + '</td>' +
        '<td class="mono dim">' + (a.recordedSha256 ? esc(a.recordedSha256.slice(0, 12)) + '…' : '—') + '</td>' +
        '<td class="mono dim">' + (a.currentSha256 ? esc(a.currentSha256.slice(0, 12)) + '… · ' + a.currentBytes + 'B' : '—') + '</td>' +
        '<td><span class="verdict ' + esc(a.status) + '">' + esc(verdict[a.status] || a.status) + '</span>' +
        (a.path.indexOf('output/') === 0 && (snapshot.outputs || []).some(function (o) { return o.path === a.path; }) ? ' <a class="miniLink" href="' + outputUrl(a.path) + '" target="_blank" rel="noopener">打开</a>' : '') +
        '</td></tr>';
    });
    return html + '</tbody></table></div>';
  }
  function deliveriesChecklist(definition, artifacts) {
    var byPath = {};
    (artifacts || []).forEach(function (a) { byPath[a.path] = a; });
    return '<ul class="checklist">' + definition.deliveries.map(function (d) {
      var a = byPath[d.path];
      var ok = a && a.status === 'match';
      return '<li>' + (ok ? icon('check') : '○') + '<span class="mono">' + esc(d.path) + '</span></li>';
    }).join('') + '</ul>';
  }
  function eventsTimeline(events) {
    if (!events || !events.length) return '<div class="emptySmall">还没有事件。</div>';
    return '<details class="timelineBox"><summary>' + events.length + ' 条事件</summary><ul class="timeline">' + events.slice().reverse().map(function (e) {
      var extra = [];
      if (e.node) extra.push(e.node);
      if (e.operation) extra.push(shortId(e.operation));
      if (e.decision) extra.push('decision=' + e.decision);
      if (e.answer) extra.push('answer=' + e.answer);
      if (e.effect) extra.push('external=unknown');
      return '<li><span class="evTime">' + esc(fmt(e.at)) + '</span><span class="evType">' + esc(e.type) + '</span><span class="evExtra">' + esc(extra.join(' · ')) + '</span></li>';
    }).join('') + '</ul></details>';
  }
  function waitingGuidance(run) {
    if (run.status !== 'waiting-human') return '';
    var id = run.id;
    return '<div class="needBox"><div class="needTitle">' + icon('alert') + '需要你决定</div>' +
      '<div class="needText">这个运行在 Harness 会话里等你选择（人工门）。请回到对应会话回答提问卡；看板不代替你确认。</div>' +
      '<div class="needActions"><button type="button" class="btn small" data-copy-run="' + esc(id) + '">' + icon('copy') + '<span>复制 runId</span></button>' +
      '<button type="button" class="btn small" data-copy-prompt="' + esc('继续处理 run ' + id) + '">' + icon('copy') + '<span>复制继续提示</span></button></div></div>';
  }
  function renderRunDrawer() {
    var run = runDetail && runDetail.run ? runDetail.run : null;
    if (!run) return '<div class="drawerLoading"><span class="spinner"></span>读取运行详情…</div>';
    var meta = statusOf(run.status);
    var html = '<div class="drawerHead"><div><div class="drawerKicker">运行</div><h2>' + esc(run.definition.name) + '</h2>' +
      '<div class="drawerMeta mono">' + esc(run.id) + '</div></div>' +
      '<button type="button" class="iconBtn" data-close-drawer aria-label="关闭详情">' + icon('close') + '</button></div>';
    html += '<div class="drawerStatus">' + statusChip(run.status) + '<span class="dim">owner ' + esc(shortId(run.owner)) + ' · revision ' + run.revision + ' · 更新 ' + esc(ago(run.events.length ? run.events[run.events.length - 1].at : null)) + '</span></div>';
    html += '<div class="drawerIntent">' + esc(run.definition.intent) + '</div>';
    html += actionsHtml(run);
    html += waitingGuidance(run);
    html += '<div class="drawerSection"><div class="sectionHead">进度 <span class="dim">' + run.index + '/' + run.definition.nodes.length + '</span></div>' + stepFlow(run, run.index, run.definition) + '</div>';
    html += '<div class="drawerSection"><div class="sectionHead">步骤详情</div>' + nodeDetails(run.definition, run.index) + '</div>';
    var op = run.active && run.active.operation;
    if (op) {
      html += '<div class="opBox"><div><div class="opLabel">当前工作单 / operation</div><div class="opValue mono">' + esc(op) + '</div></div>' +
        '<button type="button" class="btn small" data-copy-op="' + esc(op) + '">' + icon('copy') + '<span>复制</span></button></div>';
    }
    html += '<div class="drawerSection"><div class="sectionHead">产物核验</div>' + artifactsTable(runDetail.artifacts) + '</div>';
    html += '<div class="drawerSection"><div class="sectionHead">交付项</div>' + deliveriesChecklist(run.definition, runDetail.artifacts) + '</div>';
    html += '<div class="drawerSection">' + eventsTimeline(run.events) + '</div>';
    html += '<details class="rawBox"><summary>原始快照（JSON）</summary><pre class="mono">' + esc(JSON.stringify(run, null, 2)) + '</pre></details>';
    return html;
  }
  function renderPipelineDrawer() {
    var pipe = (snapshot.pipelines || []).filter(function (p) { return p.file === selectedPipelineFile; })[0];
    if (!pipe) return '';
    var definition = pipe.definition;
    var html = '<div class="drawerHead"><div><div class="drawerKicker">已登记管线</div><h2>' + esc(definition.name) + '</h2>' +
      '<div class="drawerMeta mono">' + esc(pipe.file) + '</div></div>' +
      '<button type="button" class="iconBtn" data-close-drawer aria-label="关闭详情">' + icon('close') + '</button></div>';
    html += '<div class="drawerStatus"><span class="statusChip ready"><span class="dot"></span>已登记</span><span class="dim">' + definition.nodes.length + ' 节点 · ' + definition.deliveries.length + ' 交付项 · 更新 ' + esc(ago(pipe.updatedAt)) + '</span></div>';
    html += '<div class="drawerIntent">' + esc(definition.intent) + '</div>';
    html += '<div class="note quiet">' + icon('alert') + '看板只读展示登记定义；创建运行请在 Harness 会话中让 Agent 读取该文件并调用 <code>orch_create</code>，由你本人确认意图卡。</div>';
    html += '<div class="drawerSection"><div class="sectionHead">步骤流</div>' + stepFlow(null, -1, definition) + '</div>';
    html += '<div class="drawerSection"><div class="sectionHead">步骤详情</div>' + nodeDetails(definition, -1) + '</div>';
    html += '<div class="drawerSection"><div class="sectionHead">交付文件</div><ul class="checklist">' + definition.deliveries.map(function (d) { return '<li>○<span class="mono">' + esc(d.path) + (d.minBytes ? ' · ≥' + d.minBytes + 'B' : '') + (d.contains ? ' · 含 ' + esc(d.contains) : '') + '</span></li>'; }).join('') + '</ul></div>';
    if (definition.references && Object.keys(definition.references).length) {
      html += '<div class="drawerSection"><div class="sectionHead">关联项目文档（创建时固定哈希）</div><ul class="checklist">' + Object.keys(definition.references).map(function (k) { return '<li>○<span class="mono">' + esc(k) + ' → ' + esc(definition.references[k]) + '</span></li>'; }).join('') + '</ul></div>';
    }
    html += '<div class="needActions"><button type="button" class="btn small" data-copy-file="' + esc(pipe.file) + '">' + icon('copy') + '<span>复制登记路径</span></button></div>';
    html += '<details class="rawBox"><summary>原始定义（JSON）</summary><pre class="mono">' + esc(JSON.stringify(definition, null, 2)) + '</pre></details>';
    return html;
  }
  function renderDrawer() {
    var drawer = $('#drawer');
    var content = '';
    if (selectedPipelineFile) content = renderPipelineDrawer();
    else if (selectedRunId) content = renderRunDrawer();
    var layout = document.getElementById('layout');
    if (!content) {
      drawer.hidden = true;
      drawer.className = 'drawer';
      if (layout) layout.className = 'layout';
      return;
    }
    drawer.hidden = false;
    drawer.className = 'drawer open';
    if (layout) layout.className = 'layout drawerOpen';
    drawer.innerHTML = content;
    wireDrawer();
  }
  function wireDrawer() {
    var drawer = $('#drawer');
    $$('[data-close-drawer]').forEach(function (el) { el.onclick = closeDrawer; });
    $$('[data-copy-op]').forEach(function (el) { el.onclick = function () { copyText(el.getAttribute('data-copy-op'), 'operation ID '); }; });
    $$('[data-copy-run]').forEach(function (el) { el.onclick = function () { copyText(el.getAttribute('data-copy-run'), 'runId '); }; });
    $$('[data-copy-prompt]').forEach(function (el) { el.onclick = function () { copyText(el.getAttribute('data-copy-prompt'), '继续提示 '); }; });
    $$('[data-copy-file]').forEach(function (el) { el.onclick = function () { copyText(el.getAttribute('data-copy-file'), '登记路径 '); }; });
    $$('[data-act]').forEach(function (el) { el.onclick = function () { runAction(el.getAttribute('data-act')); }; });
  }
  function closeDrawer() { selectedRunId = null; selectedPipelineFile = null; runDetail = null; renderBoard(); renderLibrary(); renderDrawer(); }
  function selectRun(id) {
    if (selectedRunId === id) return;
    selectedRunId = id;
    selectedPipelineFile = null;
    runDetail = null;
    renderBoard(); renderLibrary(); renderDrawer();
    loadRunDetail();
  }
  function selectPipeline(file) {
    if (selectedPipelineFile === file) return;
    selectedPipelineFile = file;
    selectedRunId = null;
    runDetail = null;
    renderBoard(); renderLibrary(); renderDrawer();
  }
  function loadRunDetail() {
    if (!selectedRunId) return;
    var id = selectedRunId;
    api('/api/runs/' + encodeURIComponent(id)).then(function (body) {
      if (body.run.id !== selectedRunId) return;
      runDetail = body;
      renderDrawer();
    }).catch(function (error) { toast('读取运行详情失败：' + error.message, true); renderDrawer(); });
  }
  function actionLabel(action) { return { next: '启动', pause: '暂停', resume: '继续', cancel: '取消' }[action] || action; }
  function runAction(action) {
    if (!selectedRunId) return;
    var id = selectedRunId;
    if (action === 'next' && !window.confirm('启动只会在内核里发出下一步工作单，不执行外部动作。继续？')) return;
    if (action === 'cancel' && !window.confirm('取消是终态动作；若外部动作在途，只记录取消请求，不证明外部已停止。继续？')) return;
    $$('#drawer [data-act]').forEach(function (b) { b.disabled = true; });
    api('/api/runs/' + encodeURIComponent(id) + '/' + action, { method: 'POST' }).then(function (body) {
      toast(actionLabel(action) + '成功：' + (body.statusZh || body.status) + (body.operation ? ' · 工作单 ' + shortId(body.operation) : ''));
      loadRunDetail();
      refresh();
    }).catch(function (error) {
      toast(actionLabel(action) + '失败：' + error.message, true);
      $$('#drawer [data-act]').forEach(function (b) { b.disabled = false; });
    });
  }
  function refresh() {
    return api('/api/runs').then(function (body) {
      snapshot = body;
      render();
      if (selectedRunId) loadRunDetail();
    }).catch(function () {});
  }
  function durationText(run) {
    if (!run.startedAt || !run.updatedAt) return '—';
    var ms = new Date(run.updatedAt).getTime() - new Date(run.startedAt).getTime();
    if (!isFinite(ms) || ms < 0) return '—';
    var sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
    return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  }
  function formatBytes(n) {
    if (!isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + 'B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
    return (n / 1024 / 1024).toFixed(1) + 'MB';
  }
  function outputUrl(path) {
    return '/api/outputs/content?token=' + encodeURIComponent(token) + '&path=' + encodeURIComponent(path);
  }
  function exportRuns() {
    var payload = { exportedAt: new Date().toISOString(), workspace: snapshot.workspace, filter: filter, runs: filteredRuns() };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'orch-runs-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    toast('已导出 ' + payload.runs.length + ' 条运行记录');
  }
  function renderRecords() {
    var host = $('#board');
    var runs = filteredRuns().slice().sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
    var html = '<div class="boardHead"><div class="panelTitle">' + icon('pipeline') + '<span>运行记录</span><span class="count">' + runs.length + '</span></div>' +
      '<div class="toolbar"><button type="button" class="btn small" id="exportRuns">导出 JSON</button><span class="boardHint">记录只读；调度仍按状态矩阵</span></div></div>';
    if (!runs.length) {
      html += '<div class="empty"><div class="emptyTitle">没有匹配的运行记录</div><div class="emptyHint">清空搜索、切换筛选，或先在 Harness 会话里创建运行。</div></div>';
    } else {
      html += '<div class="recordsWrap"><table class="records"><thead><tr><th>状态</th><th>运行</th><th>进度</th><th>收据</th><th>开始</th><th>耗时</th><th>更新</th><th></th></tr></thead><tbody>';
      runs.forEach(function (run) {
        var meta = statusOf(run.status);
        html += '<tr class="recordRow" data-record="' + esc(run.id) + '"><td>' + statusChip(run.status) + '</td>' +
          '<td><div class="recordName">' + esc(run.name) + '</div><div class="recordId mono">' + esc(run.id) + '</div></td>' +
          '<td class="mono dim">' + run.index + '/' + run.total + '</td>' +
          '<td class="mono dim">' + run.receiptCount + (run.recoveredCount ? ' · 恢复' + run.recoveredCount : '') + '</td>' +
          '<td class="mono dim">' + esc(fmt(run.startedAt)) + '</td>' +
          '<td class="mono dim">' + esc(durationText(run)) + '</td>' +
          '<td class="dim">' + esc(ago(run.updatedAt)) + '</td>' +
          '<td class="recordActions"><button type="button" class="miniLink" data-open-run="' + esc(run.id) + '">详情</button></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    host.innerHTML = html;
    var btn = $('#exportRuns'); if (btn) btn.onclick = exportRuns;
    $$('[data-open-run]').forEach(function (el) { el.onclick = function (event) { event.stopPropagation(); selectRun(el.getAttribute('data-open-run')); }; });
    $$('.recordRow').forEach(function (el) { el.onclick = function () { selectRun(el.getAttribute('data-record')); }; });
  }
  function renderOutputs() {
    var host = $('#board');
    var files = (snapshot.outputs || []).filter(function (file) { return matches(file.path + ' ' + file.name); });
    var html = '<div class="boardHead"><div class="panelTitle">' + icon('pipeline') + '<span>输出物</span><span class="count">' + files.length + '</span></div>' +
      '<div class="toolbar"><button type="button" class="btn small" id="refreshOutputs">刷新</button><span class="boardHint">只读打开；不执行文件内容</span></div></div>';
    if (!files.length) {
      html += '<div class="empty"><div class="emptyTitle">还没有输出物</div><div class="emptyHint">运行产生交付文件后会出现在工作区 <code>output/</code>；这里只做只读查看与打开。</div></div>';
    } else {
      html += '<div class="outputGrid">';
      files.forEach(function (file) {
        var kind = file.kind || 'file';
        html += '<div class="outputCard ' + esc(kind) + '"><div class="outputTop"><span class="outputKind">' + esc(outputKindLabel(kind)) + '</span><span class="dim mono">' + esc(formatBytes(file.bytes)) + '</span></div>' +
          '<div class="outputName" title="' + esc(file.path) + '">' + esc(file.name) + '</div>' +
          '<div class="outputPath mono">' + esc(file.path) + '</div>' +
          '<div class="outputFoot"><span class="dim">' + esc(ago(file.updatedAt)) + '</span>' +
          '<span class="outputActions"><button type="button" class="miniLink" data-open-file="' + esc(file.path) + '">打开</button>' +
          '<button type="button" class="miniLink" data-copy-filepath="' + esc(file.path) + '">复制路径</button></span></div></div>';
      });
      html += '</div>';
    }
    if (snapshot.outputWarnings && snapshot.outputWarnings.length) {
      html += '<details class="warnBox"><summary>' + snapshot.outputWarnings.length + ' 个输出物已跳过</summary><ul>' + snapshot.outputWarnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></details>';
    }
    host.innerHTML = html;
    var refresh = $('#refreshOutputs'); if (refresh) refresh.onclick = function () { refresh().then(function () { toast('已刷新'); }); };
    $$('[data-open-file]').forEach(function (el) { el.onclick = function () { window.open(outputUrl(el.getAttribute('data-open-file')), '_blank', 'noopener'); }; });
    $$('[data-copy-filepath]').forEach(function (el) { el.onclick = function () { copyText(el.getAttribute('data-copy-filepath'), '输出物路径 '); }; });
  }
  function outputKindLabel(kind) {
    return { html: 'HTML', markdown: 'Markdown', json: 'JSON', text: 'Text', csv: 'CSV', image: '图片', file: '文件' }[kind] || '文件';
  }
  function setView(next) {
    view = next;
    $$('#viewTabs [data-view]').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-view') === view); });
    render();
  }
  function render() {
    renderHeader(); renderOverview(); renderLibrary();
    if (view === 'records') renderRecords();
    else if (view === 'outputs') renderOutputs();
    else renderBoard();
    renderDrawer();
  }
  function connect() {
    if (!window.EventSource) { setLive(false); startPolling(); return; }
    try {
      evtSource = new EventSource('/api/events?token=' + encodeURIComponent(token));
      evtSource.addEventListener('snapshot', function (event) {
        snapshot = JSON.parse(event.data);
        setLive(true);
        render();
        if (selectedRunId) loadRunDetail();
      });
      evtSource.onerror = function () { setLive(false); startPolling(); };
      evtSource.onopen = function () { setLive(true); };
    } catch (error) {
      setLive(false);
      startPolling();
    }
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      refresh().then(function () { if (selectedRunId) loadRunDetail(); });
    }, 3000);
  }
  $$('#viewTabs [data-view]').forEach(function (el) {
    el.onclick = function () { setView(el.getAttribute('data-view')); };
  });
  $('#search').addEventListener('input', function (event) {
    searchTerm = event.target.value.trim().toLowerCase();
    renderLibrary(); renderBoard();
  });
  $('#refresh').addEventListener('click', function () { refresh().then(function () { toast('已刷新'); }); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeDrawer();
    if (event.key === '/' && document.activeElement !== $('#search')) { event.preventDefault(); $('#search').focus(); }
  });
  render();
  setLive(false, '连接中');
  connect();
})();`;

const CSS = `
:root{color-scheme:dark;--bg:#0f1216;--panel:#161a20;--panel2:#1b2028;--card:#181d24;--line:#262d37;--line2:#323b48;--text:#e8eaed;--muted:#9aa3ad;--dim:#6b7480;--accent:#6ea8fe;--green:#41c486;--amber:#e0a742;--red:#e06c75;--blue:#6ea8fe;--radius:12px}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
button{font:inherit}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#2a323d;border-radius:4px}
header.top{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#151a21,#11151a)}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.logo{width:30px;height:30px;border-radius:9px;background:linear-gradient(135deg,#264a7a,#1b2a44);display:grid;place-items:center;color:#cfe3ff}
.title{font-size:15px;font-weight:600;letter-spacing:.01em;white-space:nowrap}
.subtitle{font-size:11px;color:var(--muted);margin-top:1px}
.headMeta{display:flex;align-items:center;gap:12px;min-width:0;margin-left:4px}
#workspace{color:var(--dim);font-size:11px;max-width:34vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.headTools{margin-left:auto;display:flex;align-items:center;gap:8px}
.search{display:flex;align-items:center;gap:6px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:5px 10px;color:var(--dim)}
.search input{background:0 0;border:0;outline:0;color:var(--text);width:min(26vw,240px);font:inherit}
.search input::placeholder{color:var(--dim)}
.iconBtn{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--muted);display:inline-grid;place-items:center;cursor:pointer}
.iconBtn:hover{color:var(--text);border-color:var(--line2)}
.badge{border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:11px;white-space:nowrap}
.badge.actions{color:var(--green);border-color:#2b5a42}.badge.readonly{color:var(--amber);border-color:#5a4a25}
.live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);white-space:nowrap}
.live .dot{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.live.on{color:var(--green)}.live.on .dot{background:var(--green);box-shadow:0 0 6px var(--green)}
.live.off{color:var(--amber)}.live.off .dot{background:var(--amber)}
.overview{padding:12px 20px 4px}
.viewBar{display:flex;align-items:center;gap:12px;padding:2px 20px 0}
.viewTabs{display:inline-flex;gap:2px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:2px}
.viewTabs button{background:0 0;border:0;color:var(--muted);font-size:12px;padding:5px 12px;border-radius:7px;cursor:pointer}
.viewTabs button:hover{color:var(--text)}
.viewTabs button.active{background:#232a34;color:var(--text);box-shadow:inset 0 0 0 1px var(--line2)}
.viewHint{color:var(--dim);font-size:11px;margin-left:auto}
.toolbar{display:flex;align-items:center;gap:8px;margin-left:auto}
.recordsWrap{overflow:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)}
table.records{width:100%;border-collapse:collapse;font-size:11.5px}
table.records th{text-align:left;color:var(--dim);font-weight:500;background:#141920;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
table.records td{padding:8px 10px;border-bottom:1px solid #1c222b;vertical-align:middle}
table.records tr:last-child td{border-bottom:0}
.recordRow{cursor:pointer}.recordRow:hover td{background:var(--panel2)}
.recordName{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px}
.recordId{color:var(--dim);font-size:10px}
.recordActions{text-align:right;white-space:nowrap}
.miniLink{background:0 0;border:0;color:var(--accent);font-size:11px;cursor:pointer;padding:1px 3px;text-decoration:none;white-space:nowrap}
.miniLink:hover{text-decoration:underline}
.outputGrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.outputCard{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:11px 12px;display:flex;flex-direction:column;gap:4px;min-width:0}
.outputTop{display:flex;align-items:center;justify-content:space-between;gap:6px}
.outputKind{font-size:9.5px;letter-spacing:.05em;color:var(--muted);border:1px solid var(--line);border-radius:5px;padding:0 5px}
.outputCard.html .outputKind{color:var(--green);border-color:#2b5a42}
.outputCard.markdown .outputKind{color:var(--accent);border-color:#2c4a78}
.outputName{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.outputPath{color:var(--dim);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.outputFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px}
.outputActions{display:flex;gap:4px}
.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.metric{display:flex;flex-direction:column;align-items:flex-start;gap:1px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:10px 13px;cursor:pointer;text-align:left;color:var(--text);position:relative;overflow:hidden;transition:border-color .12s,transform .12s}
.metric:before{content:"";position:absolute;inset:0 auto 0 0;width:3px;background:var(--line2)}
.metric:hover{border-color:var(--line2);transform:translateY(-1px)}
.metric.active{border-color:var(--accent)}
.metric.attention:before{background:var(--amber)}.metric.working:before{background:var(--blue)}.metric.done:before{background:var(--green)}.metric.cancelled:before{background:var(--red)}.metric.ready:before{background:var(--green)}
.metricValue{font-size:21px;font-weight:600;line-height:1.1}
.metricLabel{font-size:12px;color:var(--muted)}
.metricHint{font-size:10px;color:var(--dim)}
main.layout{display:grid;grid-template-columns:250px minmax(0,1fr) 0;gap:0;height:calc(100vh - 156px);padding:8px 20px 18px;transition:grid-template-columns .18s ease}
main.layout.drawerOpen{grid-template-columns:250px minmax(0,1fr) min(400px,36vw)}
.library{min-width:0;overflow:auto;padding:4px 12px 4px 0;border-right:1px solid var(--line)}
.board{min-width:0;overflow:auto;padding:4px 16px}
.drawer{min-width:0;overflow:auto;margin-left:4px;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px;display:none}
.drawer.open{display:block}
.panelTitle{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;letter-spacing:.03em;margin:6px 2px 10px}
.panelTitle .count{margin-left:auto;color:var(--dim);font-size:11px}
.pipelineList{display:flex;flex-direction:column;gap:8px}
.pipelineCard{display:flex;gap:9px;align-items:flex-start;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;cursor:pointer;color:var(--text)}
.pipelineCard:hover{border-color:var(--line2)}.pipelineCard.selected{border-color:var(--green)}
.pipeIcon{color:var(--green);margin-top:2px;flex:0 0 auto}
.pipeBody{min-width:0;display:flex;flex-direction:column;gap:2px}
.pipeName{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pipeIntent{font-size:11px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden}
.pipeMeta{font-size:10px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.emptySmall{color:var(--dim);font-size:11.5px;background:var(--panel);border:1px dashed var(--line);border-radius:10px;padding:10px 12px;line-height:1.6}
.boardHead{display:flex;align-items:baseline;gap:10px}
.boardHint{color:var(--dim);font-size:11px;margin-left:auto}
.groupTitle{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11.5px;letter-spacing:.04em;margin:16px 2px 8px}
.groupTitle .count{color:var(--dim);background:var(--panel);border:1px solid var(--line);border-radius:999px;padding:0 7px;font-size:10px}
.runCard{position:relative;display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:11px 14px 11px 17px;margin-bottom:8px;cursor:pointer;color:var(--text);transition:border-color .12s,background .12s}
.runCard:hover{border-color:var(--line2);background:var(--panel2)}.runCard.selected{border-color:var(--accent)}
.runStripe{position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;background:var(--line2)}
.runCard.attention .runStripe{background:var(--amber)}.runCard.working .runStripe{background:var(--blue)}.runCard.ready .runStripe{background:var(--green)}.runCard.done .runStripe{background:var(--green)}.runCard.cancelled .runStripe{background:var(--red)}.runCard.paused .runStripe{background:var(--dim)}
.runTop{display:flex;align-items:center;gap:8px}
.runTime{margin-left:auto;color:var(--dim);font-size:10.5px}
.runName{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.runSub{font-size:10.5px;color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.runProgress{height:3px;border-radius:2px;background:#242b35;overflow:hidden;margin-top:2px}
.runProgress span{display:block;height:100%;background:var(--accent);border-radius:2px}
.cardHint{font-size:10.5px;color:var(--muted)}.cardHint.attention{color:var(--amber)}
.statusChip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:11px;white-space:nowrap;color:var(--muted)}
.statusChip .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.statusChip.attention{color:var(--amber);border-color:#5a4a25;background:#1f1a10}
.statusChip.working{color:var(--blue);border-color:#2c4a78}
.statusChip.ready{color:var(--green);border-color:#2b5a42}
.statusChip.done{color:var(--green);border-color:#2b5a42}
.statusChip.cancelled{color:var(--red);border-color:#5f3038}
.statusChip.paused{color:var(--muted)}
.miniTag{font-size:9.5px;color:var(--green);border:1px solid #2b5a42;border-radius:4px;padding:0 4px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:64px 20px;color:var(--muted);text-align:center}
.emptyTitle{font-size:14px;color:var(--text)}.emptyHint{font-size:12px;color:var(--dim);max-width:420px;line-height:1.7}
.warnBox{margin:14px 0;color:var(--amber);font-size:11px;background:#1f1a10;border:1px solid #5a4a25;border-radius:10px;padding:8px 12px}
.warnBox summary{cursor:pointer}.warnBox ul{margin:6px 0 0;padding-left:18px;color:var(--muted)}
.drawerHead{display:flex;align-items:flex-start;gap:12px}
.drawerHead h2{margin:1px 0 3px;font-size:16px;line-height:1.3}
.drawerKicker{font-size:10px;letter-spacing:.08em;color:var(--dim);text-transform:uppercase}
.drawerHead .iconBtn{margin-left:auto;flex:0 0 auto}
.drawerMeta{font-size:10px;color:var(--dim);word-break:break-all}
.drawerStatus{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0 8px}
.drawerIntent{font-size:12px;color:var(--muted);background:#12161b;border-left:2px solid var(--accent);border-radius:0 6px 6px 0;padding:8px 10px;margin-bottom:12px}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}
.btn{display:inline-flex;align-items:center;gap:6px;background:#232a34;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}
.btn:hover{border-color:var(--line2)}.btn.primary{background:#1c3557;border-color:#2c5b95;color:#d7e6ff}.btn.danger{color:#f0a3a9;border-color:#5f3038}
.btn.small{padding:4px 9px;font-size:11px}.btn:disabled{opacity:.5;cursor:progress}
.note{border-radius:8px;padding:8px 10px;font-size:11.5px;line-height:1.65;margin:8px 0;display:flex;gap:7px;align-items:flex-start}
.note.quiet{background:#151a20;border:1px solid var(--line);color:var(--muted)}
.needBox{background:linear-gradient(180deg,#221c11,#1b1710);border:1px solid #5a4a25;border-radius:10px;padding:10px 12px;margin:10px 0}
.needTitle{display:flex;align-items:center;gap:6px;color:var(--amber);font-size:12px;font-weight:600}
.needText{color:var(--muted);font-size:11px;line-height:1.65;margin:5px 0 8px}
.needActions{display:flex;flex-wrap:wrap;gap:6px}
.drawerSection{margin-top:16px}
.sectionHead{display:flex;align-items:baseline;gap:8px;color:var(--muted);font-size:11.5px;letter-spacing:.03em;margin-bottom:8px}
.sectionHead .dim{color:var(--dim);font-size:10.5px}
.flow{display:flex;align-items:flex-start;flex-wrap:wrap;gap:0;padding:6px 0 2px}
.flowNode{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:52px;max-width:78px}
.flowDot{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:11px;border:1px solid var(--line2);background:var(--panel);color:var(--muted)}
.flowNode.done .flowDot{border-color:#2b5a42;background:#16241d;color:var(--green)}
.flowNode.current .flowDot{border-color:var(--accent);background:#16233a;color:#cfe3ff;box-shadow:0 0 0 3px #6ea8fe22}
.flowNode.attention .flowDot{border-color:var(--amber);background:#241f14;color:var(--amber)}
.flowLabel{font-size:9.5px;color:var(--dim);max-width:78px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.flowLink{width:14px;height:1px;background:var(--line2);margin-top:12px}
.nodeList{display:flex;flex-direction:column;gap:4px}
.nodeItem{background:#141920;border:1px solid var(--line);border-radius:8px;padding:7px 10px}
.nodeItem.current{border-color:var(--accent)}.nodeItem.done{opacity:.85}
.nodeItem summary{cursor:pointer;display:flex;align-items:center;gap:7px;list-style:none}
.nodeItem summary::-webkit-details-marker{display:none}
.nodeState{color:var(--dim);display:inline-flex}.nodeItem.done .nodeState{color:var(--green)}.nodeItem.current .nodeState{color:var(--accent)}
.nodeId{font-family:ui-monospace,Menlo,monospace;font-size:11px}.nodeType{font-size:9.5px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.nodeQuestion{margin:6px 0 2px;color:var(--muted);font-size:11px;line-height:1.65}
.nodeOptions{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.optionPill{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:0 7px}
.nodeProofs{margin-top:4px;color:var(--dim);font-size:10px}
.tableWrap{overflow:auto;border:1px solid var(--line);border-radius:8px}
table.artifacts{width:100%;border-collapse:collapse;font-size:11px}
table.artifacts th{text-align:left;color:var(--dim);font-weight:500;background:#141920;padding:6px 8px;border-bottom:1px solid var(--line)}
table.artifacts td{padding:6px 8px;border-bottom:1px solid #1c222b;vertical-align:top}
table.artifacts tr:last-child td{border-bottom:0}
.verdict.match{color:var(--green)}.verdict.changed,.verdict.missing,.verdict.unsafe,.verdict.invalid,.verdict.error{color:var(--red)}.verdict.unrecorded{color:var(--amber)}
.checklist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--muted)}
.checklist li{display:flex;gap:7px;align-items:flex-start;line-height:1.6}
.checklist svg{color:var(--green);flex:0 0 auto;margin-top:2px}
.timelineBox,.rawBox{border:1px solid var(--line);border-radius:8px;background:#141920;padding:8px 10px}
.timelineBox summary,.rawBox summary{cursor:pointer;color:var(--muted);font-size:11px}
.rawBox pre{margin:8px 0 0;max-height:320px;overflow:auto;font-size:10px;color:#c8d0d9}
ul.timeline{list-style:none;margin:8px 0 0;padding:0;font-size:10.5px}
ul.timeline li{display:grid;grid-template-columns:108px 108px 1fr;gap:6px;padding:3px 0;border-bottom:1px solid #1b222a}
.evTime{color:var(--dim);font-family:ui-monospace,Menlo,monospace}.evType{color:var(--accent)}.evExtra{color:var(--dim);font-family:ui-monospace,Menlo,monospace}
.opBox{display:flex;align-items:center;gap:10px;background:#141920;border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:10px 0}
.opBox>div{min-width:0;flex:1}.opLabel{font-size:10px;color:var(--dim)}.opValue{font-size:11px;color:var(--text);word-break:break-all}
.drawerLoading{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12px;padding:20px 2px}
.spinner{width:13px;height:13px;border-radius:50%;border:2px solid #2a323d;border-top-color:var(--accent);animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;right:22px;bottom:20px;max-width:min(560px,80vw);background:#1c232c;border:1px solid var(--line2);border-radius:10px;padding:9px 13px;color:var(--text);font-size:12px;opacity:0;transform:translateY(8px);transition:.16s;pointer-events:none;z-index:40}
.toast.show{opacity:1;transform:none}.toast.error{border-color:#5f3038;color:#f0a3a9}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dim{color:var(--dim)}
code{font-family:ui-monospace,Menlo,monospace;background:#1b2028;border:1px solid var(--line);border-radius:4px;padding:0 4px}
@media (max-width:1100px){main.layout{grid-template-columns:220px minmax(0,1fr) 0}main.layout.drawerOpen{grid-template-columns:220px minmax(0,1fr) min(360px,40vw)}}
@media (max-width:900px){
  body{overflow:auto}
  header.top{flex-wrap:wrap;gap:8px;padding:10px 14px}
  #workspace{max-width:46vw}
  .overview{padding:10px 14px 2px}
  .metrics{grid-template-columns:repeat(3,minmax(0,1fr))}
  main.layout,main.layout.drawerOpen{grid-template-columns:1fr;height:auto;padding:6px 14px 20px}
  .library{border-right:0;border-bottom:1px solid var(--line);padding:2px 0 10px;max-height:220px}
  .board{padding:6px 0}
  .drawer,.drawer.open{position:fixed;inset:0;z-index:30;border-radius:0;margin:0;display:none}
  .drawer.open{display:block;padding:16px;background:var(--bg)}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function pageHtml(boot) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Orchestrator · 管线管理看板</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand">
    <span class="logo"><svg viewBox="0 0 16 16" width="17" height="17" aria-hidden="true"><circle cx="3" cy="8" r="1.7" fill="currentColor"/><circle cx="8" cy="4" r="1.7" fill="currentColor"/><circle cx="8" cy="12" r="1.7" fill="currentColor"/><circle cx="13" cy="8" r="1.7" fill="currentColor"/><path d="M4.4 7.3L6.6 4.9M4.4 8.7l2.2 2.4M9.4 4.9l2.2 2.4M9.4 11.1l2.2-2.4" stroke="currentColor" fill="none"/></svg></span>
    <div><div class="title">DSH Orchestrator</div><div class="subtitle">管线管理看板</div></div>
  </div>
  <div class="headMeta"><span id="workspace" class="mono"></span><span id="live" class="live"><span class="dot"></span>连接中</span><span id="mode" class="badge"></span></div>
  <div class="headTools">
    <label class="search"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4" stroke="currentColor" fill="none"/><path d="M10 10l3.5 3.5" stroke="currentColor"/></svg><input id="search" type="text" placeholder="搜索运行或管线" aria-label="搜索运行或管线"></label>
    <button id="refresh" type="button" class="iconBtn" aria-label="刷新"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2.5 8a5.5 5.5 0 019.2-4.1L13 2.5v4h-4l1.4-1.4A4 4 0 104 8" stroke="currentColor" fill="none"/></svg></button>
  </div>
</header>
<div id="overview" class="overview"></div>
<div class="viewBar">
  <nav class="viewTabs" id="viewTabs" aria-label="看板视图">
    <button type="button" data-view="board" class="active">看板</button>
    <button type="button" data-view="records">运行记录</button>
    <button type="button" data-view="outputs">输出物</button>
  </nav>
  <span class="viewHint">默认只读；调度操作按状态矩阵</span>
</div>
<main class="layout" id="layout">
  <aside id="library" class="library"></aside>
  <section id="board" class="board"></section>
  <aside id="drawer" class="drawer" hidden></aside>
</main>
<div id="toast" class="toast"></div>
<noscript>本页面需要 JavaScript 才能实时显示状态。</noscript>
<script id="boot" type="application/json">${safeJson(boot)}</script>
<script src="/app.js?token=${encodeURIComponent(boot.token)}"></script>
</body>
</html>`;
}

const APP_PATH = '/app.js';

function tokenMatches(given, secret) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function dirSignature(workspace) {
  try {
    const dir = path.join(workspace, '.orchestrator');
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return 'invalid';
    return fs.readdirSync(dir).sort().map(name => {
      try {
        const file = fs.statSync(path.join(dir, name));
        return `${name}:${file.size}:${file.mtimeMs}`;
      } catch {
        return `${name}:?`;
      }
    }).join('|');
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : `error:${error.code}`;
  }
}

/**
 * Start a loopback-only dashboard.
 * @param {{ workspace: string, port?: number, host?: string, readOnly?: boolean, token?: string }} options
 * @returns {Promise<{ server: import('node:http').Server, url: string, token: string, port: number, readOnly: boolean, close: () => Promise<void> }>}
 */
export async function startViewer(options = {}) {
  const workspace = assertWorkspace(options.workspace);
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new ViewerError(400, '只允许绑定本机回环地址（127.0.0.1 / ::1 / localhost）');
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new ViewerError(400, '端口不合法');
  const readOnly = options.readOnly === true;
  if (options.token !== undefined && (typeof options.token !== 'string' || options.token.length < 16)) {
    throw new ViewerError(400, '显式令牌至少需要 16 个字符');
  }
  const secret = typeof options.token === 'string' ? options.token : randomBytes(24).toString('base64url');

  const clients = new Set();
  let closed = false;
  let watcher = null;
  let signature = dirSignature(workspace);

  const snapshotData = () => runSnapshot(workspace, readOnly);
  const broadcast = () => {
    const payload = JSON.stringify(snapshotData());
    for (const res of clients) {
      try {
        res.write(`event: snapshot\ndata: ${payload}\n\n`);
      } catch {
        clients.delete(res);
      }
    }
  };
  let debounce = null;
  const scheduleBroadcast = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      signature = dirSignature(workspace);
      broadcast();
    }, 120);
  };

  let server;
  const allowedHosts = () => {
    const actual = server.address();
    const actualPort = actual && typeof actual === 'object' ? actual.port : port;
    return new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
  };

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(text);
  };

  const hostAllowed = req => {
    const hostHeader = req.headers.host;
    return typeof hostHeader === 'string' && allowedHosts().has(hostHeader);
  };

  const originAllowed = req => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    const actual = server.address();
    const actualPort = actual && typeof actual === 'object' ? actual.port : port;
    return [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, `http://[::1]:${actualPort}`].includes(origin);
  };

  const sse = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshotData())}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
  };

  const handler = async (req, res) => {
    try {
      if (!hostAllowed(req)) throw new ViewerError(403, 'Host 不允许（只接受本机回环）');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      const headerToken = req.headers['x-orch-viewer-token'];
      const queryToken = url.searchParams.get('token') ?? '';
      if (pathname === '/' && req.method === 'GET') {
        if (!tokenMatches(queryToken, secret)) throw new ViewerError(403, '缺少或错误的访问令牌');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        });
        res.end(pageHtml({ token: secret, snapshot: snapshotData() }));
        return;
      }
      if (pathname === APP_PATH && req.method === 'GET') {
        if (!tokenMatches(queryToken, secret)) throw new ViewerError(403, '缺少或错误的访问令牌');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(APP_JS);
        return;
      }
      const tokenOk = tokenMatches(typeof headerToken === 'string' ? headerToken : '', secret) || tokenMatches(queryToken, secret);
      if (!tokenOk) throw new ViewerError(403, '缺少或错误的访问令牌');
      if (pathname === '/api/health' && req.method === 'GET') {
        json(res, 200, { ok: true, readOnly, actions: !readOnly, workspace });
        return;
      }
      if (pathname === '/api/events' && req.method === 'GET') {
        sse(req, res);
        return;
      }
      if (pathname === '/api/runs' && req.method === 'GET') {
        json(res, 200, snapshotData());
        return;
      }
      const detailMatch = /^\/api\/runs\/([a-f0-9-]{36})$/.exec(pathname);
      if (detailMatch && req.method === 'GET') {
        json(res, 200, runDetail(workspace, detailMatch[1]));
        return;
      }
      const actionMatch = /^\/api\/runs\/([a-f0-9-]{36})\/(next|pause|resume|cancel)$/.exec(pathname);
      if (actionMatch) {
        if (req.method !== 'POST') throw new ViewerError(405, '动作只接受 POST');
        if (readOnly) throw new ViewerError(403, '只读模式不允许调度动作');
        if (!tokenMatches(typeof headerToken === 'string' ? headerToken : '', secret)) throw new ViewerError(403, 'POST 需要自定义头令牌');
        if (!originAllowed(req)) throw new ViewerError(403, 'Origin 不允许');
        const result = applyAction(workspace, actionMatch[1], actionMatch[2]);
        scheduleBroadcast();
        json(res, 200, { ok: true, ...result });
        return;
      }
      if (pathname === '/api/outputs/content' && req.method === 'GET') {
        const rel = url.searchParams.get('path') ?? '';
        const file = readOutputFile(workspace, rel);
        res.writeHead(200, {
          'Content-Type': file.type,
          'Content-Length': file.body.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:",
          'Content-Disposition': 'inline; filename="' + encodeURIComponent(file.name) + '"'
        });
        res.end(file.body);
        return;
      }
      throw new ViewerError(404, '没有这个路由');
    } catch (error) {
      const status = error instanceof ViewerError ? error.status : 500;
      if (res.headersSent) {
        try {
          res.end();
        } catch {}
        return;
      }
      json(res, status, { ok: false, error: status === 500 ? '内部错误' : error.message });
    }
  };

  server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = server.address().port;

  try {
    const dir = path.join(workspace, '.orchestrator');
    if (fs.existsSync(dir)) {
      watcher = fs.watch(dir, { persistent: false }, () => scheduleBroadcast());
      watcher.on('error', () => {});
    }
  } catch {
    watcher = null;
  }
  const poll = setInterval(() => {
    const next = dirSignature(workspace);
    if (next !== signature) {
      signature = next;
      broadcast();
    }
  }, 1000);

  const urlHost = host === '::1' ? '[::1]' : host;
  const url = `http://${urlHost}:${actualPort}/?token=${encodeURIComponent(secret)}`;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearTimeout(debounce);
    if (watcher) {
      try {
        watcher.close();
      } catch {}
    }
    for (const res of clients) {
      try {
        res.end();
      } catch {}
    }
    clients.clear();
    await new Promise(resolve => server.close(() => resolve()));
  };
  return { server, url, token: secret, port: actualPort, readOnly, close };
}

function parseArgs(argv) {
  const options = { workspace: '', port: 0, host: '127.0.0.1', readOnly: false, token: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--read-only') {
      options.readOnly = true;
    } else if (arg === '--port') {
      options.port = Number(argv[++i]);
    } else if (arg === '--host') {
      options.host = argv[++i];
    } else if (arg === '--token') {
      options.token = argv[++i];
    } else if (arg === '--workspace' || arg === '-w') {
      options.workspace = argv[++i] ?? '';
    } else if (!arg.startsWith('-') && !options.workspace) {
      options.workspace = arg;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log('用法：orch view <工作区绝对路径> [--port 8787] [--host 127.0.0.1] [--read-only] [--token <令牌>]');
    console.log('只读展示运行状态，并提供 next/pause/resume/cancel 调度动作（不执行外部动作）。默认只绑定本机回环地址。');
    return;
  }
  if (!options.workspace) {
    console.error('缺少工作区路径。用法：orch view <工作区绝对路径> [--port 8787] [--read-only]');
    process.exitCode = 1;
    return;
  }
  const viewer = await startViewer(options);
  console.log(`orch 看板：${viewer.url}`);
  console.log(`模式：${viewer.readOnly ? '只读（调度按钮关闭）' : '只读 + 调度（启动/暂停/取消只发工作单，不执行外部动作）'}`);
  console.log('按 Ctrl+C 停止。');
  const stop = async () => {
    await viewer.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

const invokedDirectly = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch(error => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

export const __test__ = { STATUS_META, GUIDANCE, validateState };
