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
import { Orchestrator } from './core.js';

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
  return {
    generatedAt: new Date().toISOString(),
    workspace,
    readOnly,
    runs: runs.map(summarize),
    warnings
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

const APP_JS = String.raw`
(function () {
  'use strict';
  var boot = JSON.parse(document.getElementById('boot').textContent);
  var token = boot.token;
  var snapshot = boot.snapshot;
  var selectedId = null;
  var detail = null;
  var pollTimer = null;
  var evtSource = null;
  var live = false;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function $(sel) { return document.querySelector(sel); }
  function short(id) { return id ? String(id).slice(0, 8) : '—'; }
  function fmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
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
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 5200);
  }
  function statusPill(run) { return '<span class="pill ' + esc(run.tone) + '">' + esc(run.statusZh) + '</span>'; }
  function renderHeader() {
    $('#workspace').textContent = snapshot.workspace;
    var active = snapshot.runs.filter(function (r) { return ['ready', 'waiting-action', 'waiting-human', 'paused', 'cancel-requested'].indexOf(r.status) >= 0; }).length;
    var attention = snapshot.runs.filter(function (r) { return r.needsAttention; }).length;
    $('#counts').textContent = snapshot.runs.length + ' 个运行 · ' + active + ' 进行中 · ' + attention + ' 待处理';
    var mode = $('#mode');
    if (snapshot.readOnly) { mode.textContent = '只读模式'; mode.className = 'badge readonly'; }
    else { mode.textContent = '调度入口已启用'; mode.className = 'badge actions'; }
  }
  function setLive(on, label) {
    live = on;
    var el = $('#live');
    el.className = 'live ' + (on ? 'on' : 'off');
    el.textContent = label || (on ? '实时' : '轮询兜底');
  }
  function renderList() {
    var host = $('#runs');
    if (!snapshot.runs.length) {
      host.innerHTML = '<div class="empty"><p>还没有运行记录。</p><p class="hint">先在 Harness 会话里用 <code>orch_create</code> 创建并确认，或把已有运行放进该工作区的 <code>.orchestrator/</code>。</p></div>';
      return;
    }
    var html = '';
    if (snapshot.warnings && snapshot.warnings.length) {
      html += '<div class="warn"><b>已跳过的文件</b><ul>' + snapshot.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>';
    }
    for (var i = 0; i < snapshot.runs.length; i++) {
      var r = snapshot.runs[i];
      var pct = r.total ? Math.round(100 * r.index / r.total) : 0;
      html += '<article class="run' + (r.id === selectedId ? ' selected' : '') + (r.needsAttention ? ' attention' : '') + '" data-run="' + esc(r.id) + '">';
      html += '<div class="runTop">' + statusPill(r) + (r.recoveredCount ? '<span class="tag">恢复</span>' : '') + '</div>';
      html += '<h3>' + esc(r.name) + '</h3>';
      html += '<p class="runIntent">' + esc(r.intent) + '</p>';
      html += '<div class="progress"><span style="width:' + pct + '%"></span></div>';
      html += '<div class="runMeta"><span>' + r.index + '/' + r.total + '</span><span>' + esc(r.currentStep ? r.currentStep.id : '—') + '</span><span>' + fmt(r.updatedAt) + '</span></div>';
      html += '</article>';
    }
    host.innerHTML = html;
    Array.prototype.forEach.call(host.querySelectorAll('[data-run]'), function (el) {
      el.onclick = function () { selectRun(el.getAttribute('data-run')); };
    });
  }
  function selectRun(id) {
    if (selectedId === id) return;
    selectedId = id;
    detail = null;
    renderList();
    loadDetail();
  }
  function ensureSelection() {
    if (!snapshot.runs.length) { selectedId = null; detail = null; return; }
    var found = snapshot.runs.some(function (r) { return r.id === selectedId; });
    if (!found) {
      var attention = snapshot.runs.filter(function (r) { return r.needsAttention; })[0];
      selectedId = (attention || snapshot.runs[0]).id;
      detail = null;
    }
  }
  function loadDetail() {
    if (!selectedId) { detail = null; renderDetail(); return; }
    var id = selectedId;
    api('/api/runs/' + encodeURIComponent(id)).then(function (body) {
      if (body.run.id !== selectedId) return;
      detail = body;
      renderDetail();
    }).catch(function (error) { toast('读取运行失败：' + error.message, true); });
  }
  function button(action, text, kind) {
    return '<button type="button" class="btn ' + (kind || '') + '" data-act="' + action + '">' + esc(text) + '</button>';
  }
  function actionBar() {
    if (snapshot.readOnly) return '<div class="note readonlyNote">只读模式（--read-only）：调度按钮已关闭。</div>';
    var s = detail.run.status;
    var html = '';
    if (s === 'ready') html += button('next', '启动（发出下一步工作单）', 'primary');
    if (s === 'paused') html += button('resume', '继续', 'primary');
    if (s === 'ready' || s === 'waiting-action' || s === 'waiting-human') html += button('pause', '暂停');
    if (['ready', 'waiting-action', 'waiting-human', 'paused'].indexOf(s) >= 0) html += button('cancel', '取消', 'danger');
    if (!html) html = '<span class="hint">当前状态没有可用的调度动作。</span>';
    return '<div class="actions">' + html + '</div>';
  }
  function nodeList() {
    var run = detail.run;
    var html = '<ol class="nodes">';
    for (var i = 0; i < run.definition.nodes.length; i++) {
      var n = run.definition.nodes[i];
      var cls = i < run.index ? 'done' : i === run.index ? 'current' : 'todo';
      html += '<li class="' + cls + '"><span class="nodeId">' + esc(n.id) + '</span><span class="nodeType">' + esc(n.type) + '</span>';
      if (n.type === 'gate') html += '<p class="nodeText">' + esc(n.question) + '</p>';
      else if (n.type === 'task') html += '<p class="nodeText">' + esc(n.instruction) + '</p>';
      if (n.proofs && n.proofs.length) html += '<p class="nodeProofs">证据：' + esc(n.proofs.map(function (p) { return p.path; }).join('、')) + '</p>';
      html += '</li>';
    }
    html += '</ol>';
    return html;
  }
  function artifactsTable() {
    if (!detail.artifacts.length) return '<p class="hint">还没有收据中的产物证据（完成提交后会出现在这里）。</p>';
    var html = '<table class="artifacts"><thead><tr><th>产物</th><th>收据 sha256</th><th>当前文件</th><th>判定</th></tr></thead><tbody>';
    for (var i = 0; i < detail.artifacts.length; i++) {
      var a = detail.artifacts[i];
      var verdict = { match: '一致', changed: '已变化', missing: '缺失', unsafe: '路径不安全', invalid: '不是普通文件', unrecorded: '未记录哈希', error: '读取错误' }[a.status] || a.status;
      html += '<tr><td>' + esc(a.path) + (a.recovered ? ' <span class="tag">恢复</span>' : '') + '</td>';
      html += '<td class="mono">' + (a.recordedSha256 ? esc(a.recordedSha256.slice(0, 12)) + '…' : '—') + '</td>';
      html += '<td class="mono">' + (a.currentSha256 ? esc(a.currentSha256.slice(0, 12)) + '… · ' + a.currentBytes + 'B' : '—') + '</td>';
      html += '<td class="verdict ' + esc(a.status) + '">' + esc(verdict) + '</td></tr>';
    }
    html += '</tbody></table>';
    return html;
  }
  function receiptsList() {
    var run = detail.run;
    if (!run.receipts || !run.receipts.length) return '<p class="hint">还没有收据。</p>';
    var html = '<ul class="receipts">';
    for (var i = 0; i < run.receipts.length; i++) {
      var r = run.receipts[i];
      var what = r.delivery ? '交付核验' : (r.node ? '节点 ' + r.node : '步骤');
      html += '<li><span class="receiptHead">' + esc(what) + (r.recovered ? ' <span class="tag">恢复</span>' : '') + '</span>';
      if (r.operation) html += '<span class="mono"> op ' + esc(short(r.operation)) + '</span>';
      for (var j = 0; j < (r.evidence || []).length; j++) {
        var e = r.evidence[j];
        html += '<div class="receiptEvidence mono">' + esc(e.path) + ' · ' + esc((e.sha256 || '').slice(0, 12)) + '… · ' + (e.bytes || 0) + 'B</div>';
      }
      html += '</li>';
    }
    html += '</ul>';
    return html;
  }
  function eventsList() {
    var events = detail.run.events || [];
    if (!events.length) return '<p class="hint">还没有事件。</p>';
    var html = '<ul class="events">';
    for (var i = events.length - 1; i >= 0; i--) {
      var e = events[i];
      var extra = [];
      if (e.node) extra.push('node=' + e.node);
      if (e.operation) extra.push('op=' + short(e.operation));
      if (e.decision) extra.push('decision=' + e.decision);
      if (e.answer) extra.push('answer=' + e.answer);
      if (e.effect) extra.push('effect=' + e.effect);
      html += '<li><span class="evTime">' + fmt(e.at) + '</span><span class="evType">' + esc(e.type) + '</span><span class="evExtra">' + esc(extra.join(' ')) + '</span></li>';
    }
    html += '</ul>';
    return html;
  }
  function guidance() {
    var s = detail.run.status;
    if (s === 'waiting-action') return '等待执行结果：请在被控宿主（Harness 会话或 CLI）完成步骤并提交文件证据；页面不会执行外部动作。';
    if (s === 'waiting-human') return '待您决定：人工门确认需要在 Harness 会话内由人完成，页面不提供门确认。';
    if (s === 'cancel-requested') return '正在核对取消：外部动作状态未知，请在 Harness 会话内核对并选择 stopped / verified。';
    return '';
  }
  function renderDetail() {
    var host = $('#detail');
    if (!detail) {
      host.innerHTML = '<div class="empty"><p>选择左侧运行查看详情。</p><p class="hint">页面只读 + 调度：不执行任务、不进行人工确认。</p></div>';
      return;
    }
    var run = detail.run;
    var meta = '运行 ' + short(run.id) + ' · owner ' + esc(run.owner) + ' · revision ' + run.revision + ' · 更新 ' + fmt(run.events.length ? run.events[run.events.length - 1].at : null);
    var html = '';
    html += '<div class="detailHead"><div><h2>' + esc(run.definition.name) + '</h2><p class="mono meta">' + meta + '</p></div>' + statusPill({ statusZh: labelOfStatus(run.status).zh, tone: labelOfStatus(run.status).tone }) + '</div>';
    html += '<p class="intent">' + esc(run.definition.intent) + '</p>';
    html += actionBar();
    var note = guidance();
    if (note) html += '<div class="note">' + esc(note) + '</div>';
    html += '<h3>步骤</h3>' + nodeList();
    html += '<h3>交付要求</h3><ul class="deliveries">' + run.definition.deliveries.map(function (d) { return '<li class="mono">' + esc(d.path) + '</li>'; }).join('') + '</ul>';
    html += '<h3>产物核验</h3>' + artifactsTable();
    html += '<h3>收据</h3>' + receiptsList();
    html += '<h3>事件</h3>' + eventsList();
    html += '<details class="raw"><summary>原始快照（只读 JSON）</summary><pre class="mono">' + esc(JSON.stringify(run, null, 2)) + '</pre></details>';
    host.innerHTML = html;
    Array.prototype.forEach.call(host.querySelectorAll('[data-act]'), function (el) {
      el.onclick = function () { runAction(el.getAttribute('data-act')); };
    });
  }
  function labelOfStatus(status) {
    var map = {
      ready: ['准备就绪', 'ready'], 'waiting-action': ['等待执行结果', 'working'], 'waiting-human': ['待您决定', 'attention'],
      paused: ['已暂停', 'paused'], 'cancel-requested': ['正在核对取消', 'attention'], cancelled: ['已取消', 'cancelled'], done: ['交付已核验', 'done']
    };
    var row = map[status] || [status, 'unknown'];
    return { zh: row[0], tone: row[1] };
  }
  function actionLabel(action) { return { next: '启动', pause: '暂停', resume: '继续', cancel: '取消' }[action] || action; }
  function runAction(action) {
    if (!detail || !detail.run) return;
    var id = detail.run.id;
    if (action === 'next' && !window.confirm('启动只会在内核里发出下一步工作单，不执行外部动作。继续？')) return;
    if (action === 'cancel' && !window.confirm('取消是终态动作；若外部动作在途，只记录取消请求，不证明外部已停止。继续？')) return;
    var buttons = document.querySelectorAll('[data-act]');
    Array.prototype.forEach.call(buttons, function (b) { b.disabled = true; });
    api('/api/runs/' + encodeURIComponent(id) + '/' + action, { method: 'POST' }).then(function (body) {
      toast(actionLabel(action) + '成功：' + body.statusZh + (body.operation ? ' · 工作单 ' + short(body.operation) : ''));
      loadDetail();
      refresh();
    }).catch(function (error) {
      toast('动作失败：' + error.message, true);
      Array.prototype.forEach.call(buttons, function (b) { b.disabled = false; });
    });
  }
  function refresh() {
    return api('/api/runs').then(function (body) {
      snapshot = body;
      renderHeader();
      renderList();
      ensureSelection();
    }).catch(function () {});
  }
  function render() {
    renderHeader();
    ensureSelection();
    renderList();
    renderDetail();
  }
  function connect() {
    if (!window.EventSource) { setLive(false); startPolling(); return; }
    try {
      evtSource = new EventSource('/api/events?token=' + encodeURIComponent(token));
      evtSource.addEventListener('snapshot', function (event) {
        snapshot = JSON.parse(event.data);
        setLive(true);
        render();
        if (selectedId) loadDetail();
      });
      evtSource.onerror = function () {
        setLive(false);
        startPolling();
      };
      evtSource.onopen = function () { setLive(true); };
    } catch (error) {
      setLive(false);
      startPolling();
    }
  }
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      refresh().then(function () { if (selectedId) loadDetail(); });
    }, 3000);
  }
  render();
  connect();
})();
`;

const CSS = `
:root{color-scheme:dark;--bg:#111418;--panel:#171b21;--panel2:#1d222a;--line:#2a303a;--text:#e8eaed;--muted:#9aa3ad;--dim:#6b7480;--accent:#6ea8fe;--green:#41c486;--amber:#e0a742;--red:#e06c75;--blue:#6ea8fe}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header.top{display:flex;flex-wrap:wrap;gap:10px 24px;align-items:baseline;padding:14px 22px;border-bottom:1px solid var(--line);background:var(--panel)}
.brand{font-size:17px;font-weight:600}.brand .sub{font-weight:400;color:var(--muted);margin-left:6px;font-size:13px}
header .meta{display:flex;flex-wrap:wrap;gap:14px;align-items:center;color:var(--muted);font-size:12px}
#workspace{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.badge{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px}
.badge.actions{color:var(--green);border-color:#2b5a42}.badge.readonly{color:var(--amber);border-color:#5a4a25}
.live{display:inline-flex;align-items:center;gap:6px;font-size:12px}.live:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--dim)}
.live.on{color:var(--green)}.live.on:before{background:var(--green);box-shadow:0 0 6px var(--green)}.live.off{color:var(--amber)}.live.off:before{background:var(--amber)}
.banner{padding:8px 22px;font-size:12px;color:var(--muted);background:var(--panel2);border-bottom:1px solid var(--line)}
.banner b{color:var(--text);font-weight:500}
main{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:0;min-height:calc(100vh - 92px)}
aside.runs{border-right:1px solid var(--line);overflow:auto;max-height:calc(100vh - 92px);padding:10px}
.run{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer;transition:border-color .12s,background .12s}
.run:hover{border-color:#3a4350}.run.selected{border-color:var(--accent);background:var(--panel2)}.run.attention{border-left:3px solid var(--amber)}
.runTop{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.run h3{margin:0 0 4px;font-size:14px;font-weight:600}
.runIntent{margin:0 0 8px;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.progress{height:4px;background:#242b35;border-radius:2px;overflow:hidden;margin-bottom:8px}.progress span{display:block;height:100%;background:var(--accent);border-radius:2px}
.runMeta{display:flex;justify-content:space-between;color:var(--dim);font-size:11px;font-family:ui-monospace,Menlo,monospace}
.pill{display:inline-block;border-radius:999px;padding:1px 9px;font-size:11px;border:1px solid var(--line);white-space:nowrap}
.pill.ready{color:var(--blue);border-color:#2c4a78}.pill.working{color:var(--amber);border-color:#5a4a25}
.pill.attention{color:#e8b34a;border-color:#6a5426;background:#241f14}.pill.paused{color:var(--muted)}
.pill.done{color:var(--green);border-color:#2b5a42}.pill.cancelled{color:var(--red);border-color:#5f3038}
.tag{font-size:10px;color:var(--green);border:1px solid #2b5a42;border-radius:4px;padding:0 4px;margin-left:6px}
section.detail{overflow:auto;max-height:calc(100vh - 92px);padding:18px 24px 40px}
.detailHead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}
.detailHead h2{margin:0 0 4px;font-size:19px}
.meta{color:var(--dim);font-size:11px;margin:0}
.intent{margin:10px 0 14px;color:var(--text);background:var(--panel);border-left:2px solid var(--accent);padding:8px 12px;border-radius:0 6px 6px 0}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px}
.btn{background:#232a34;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 13px;font-size:13px;cursor:pointer}
.btn:hover{border-color:#45505e}.btn.primary{background:#1c3557;border-color:#2c5b95;color:#d7e6ff}
.btn.danger{color:#f0a3a9;border-color:#5f3038}.btn:disabled{opacity:.5;cursor:progress}
.note{margin:8px 0 14px;padding:8px 12px;border-radius:6px;background:#1b222b;border:1px solid var(--line);color:var(--muted);font-size:12px}
.readonlyNote{color:var(--amber);border-color:#5a4a25}
h3{margin:22px 0 8px;font-size:13px;color:var(--muted);font-weight:500;letter-spacing:.03em}
ol.nodes{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
ol.nodes li{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px}
ol.nodes li.current{border-color:var(--accent);background:var(--panel2)}
ol.nodes li.done{opacity:.82}.nodeId{font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-right:8px}
.nodeType{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 5px}
.nodeText{margin:5px 0 0;color:var(--muted);font-size:12px}.nodeProofs{margin:3px 0 0;color:var(--dim);font-size:11px}
.deliveries{margin:0;padding-left:18px;color:var(--muted);font-size:12px}
table.artifacts{width:100%;border-collapse:collapse;font-size:12px}
table.artifacts th{text-align:left;color:var(--dim);font-weight:500;border-bottom:1px solid var(--line);padding:6px 8px}
table.artifacts td{border-bottom:1px solid #20262e;padding:6px 8px;vertical-align:top}
.verdict.match{color:var(--green)}.verdict.changed,.verdict.missing,.verdict.unsafe,.verdict.invalid,.verdict.error{color:var(--red)}.verdict.unrecorded{color:var(--amber)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
ul.receipts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
ul.receipts li{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:12px}
.receiptHead{font-weight:500}.receiptEvidence{color:var(--dim);font-size:11px;margin-top:3px}
ul.events{list-style:none;margin:0;padding:0;font-size:12px}
ul.events li{display:grid;grid-template-columns:150px 150px 1fr;gap:8px;padding:5px 4px;border-bottom:1px solid #1d232b}
.evTime{color:var(--dim);font-family:ui-monospace,Menlo,monospace;font-size:11px}.evType{color:var(--accent)}.evExtra{color:var(--muted);font-family:ui-monospace,Menlo,monospace;font-size:11px}
details.raw{margin:18px 0 0}details.raw summary{cursor:pointer;color:var(--muted);font-size:12px}
details.raw pre{background:#0d1014;border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;max-height:360px;font-size:11px;color:#c8d0d9}
.empty{padding:40px 10px;color:var(--muted)}.hint{color:var(--dim);font-size:12px}
.warn{background:#241f14;border:1px solid #5a4a25;border-radius:8px;padding:8px 12px;margin-bottom:10px;color:var(--amber);font-size:12px}
.warn b{font-weight:500}.warn ul{margin:4px 0 0;padding-left:18px}
.toast{position:fixed;right:24px;bottom:22px;max-width:min(560px,80vw);background:#222b36;border:1px solid var(--line);border-radius:8px;padding:9px 14px;color:var(--text);font-size:12px;opacity:0;transform:translateY(8px);transition:.16s;pointer-events:none}
.toast.show{opacity:1;transform:none}.toast.error{border-color:#5f3038;color:#f0a3a9}
@media (max-width:860px){main{grid-template-columns:1fr}aside.runs{max-height:none;border-right:0;border-bottom:1px solid var(--line)}section.detail{max-height:none}}
`;

function pageHtml(boot) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Orchestrator · 管线看板</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="brand">DSH Orchestrator<span class="sub">管线看板</span></div>
  <div class="meta"><span id="counts"></span><span id="live" class="live">连接中</span><span id="mode" class="badge"></span><span id="workspace" class="mono"></span></div>
</header>
<div class="banner"><b>只读 + 调度入口</b>：展示运行/步骤/事件/收据与产物核验；按钮只发出工作单或暂停/取消，不执行外部动作；Intent 确认、人工门、对账和交付核验仍在 Harness 会话完成。</div>
<main>
  <aside id="runs" class="runs"></aside>
  <section id="detail" class="detail"></section>
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
