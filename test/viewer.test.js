import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestrator, digest } from '../src/core.js';
import { startViewer, loadRuns } from '../src/viewer.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const def = (patch = {}) => ({
  version: 1,
  name: patch.name ?? '看板测试管线',
  intent: patch.intent ?? '用于看板测试的隔离管线',
  nodes: patch.nodes ?? [{ id: 'task', type: 'task', mode: 'agent', instruction: '写入 out.txt', proofs: [{ path: 'out.txt', contains: 'ok' }] }],
  deliveries: patch.deliveries ?? [{ path: 'out.txt', contains: 'ok' }]
});

const owner = 'viewer-test-owner';

function createRun(workspace, definition) {
  const engine = new Orchestrator(workspace);
  const confirmation = { answer: 'confirm', definitionHash: digest(definition), source: 'test', at: new Date().toISOString() };
  return engine.create(definition, owner, confirmation);
}

function buildFixtures(workspace) {
  const runMap = {};
  // done run with a real artifact and receipts
  const done = createRun(workspace, def({ name: '完成的笔记管线' }));
  let state = new Orchestrator(workspace).next(done.id, owner);
  fs.writeFileSync(path.join(workspace, 'out.txt'), 'ok');
  state = new Orchestrator(workspace).complete(done.id, owner, state.active.operation);
  state = new Orchestrator(workspace).next(done.id, owner);
  assert.equal(state.status, 'done');
  runMap.done = done.id;

  // waiting-human gate run
  const gate = createRun(workspace, def({
    name: '人工门管线',
    intent: '等待人工门的管线',
    nodes: [{ id: 'gate', type: 'gate', question: '是否放行？' }],
    deliveries: [{ path: 'never.txt', contains: 'never' }]
  }));
  new Orchestrator(workspace).next(gate.id, owner);
  runMap.gate = gate.id;

  // cancel-requested run
  const cancelling = createRun(workspace, def({ name: '取消核对管线' }));
  new Orchestrator(workspace).next(cancelling.id, owner);
  new Orchestrator(workspace).cancel(cancelling.id, owner);
  runMap.cancelling = cancelling.id;

  // ready run used by scheduling-action tests
  const ready = createRun(workspace, def({ name: '待启动管线', intent: '等待看板启动按钮的管线' }));
  runMap.ready = ready.id;

  // HTML escaping fixture: model/user supplied text must not inject tags
  const tricky = createRun(workspace, def({ name: '转义测试', intent: '<script>alert(1)</script> & "quote"' }));
  runMap.tricky = tricky.id;

  // Registered pipeline definitions (read-only display; running still goes through the Harness session).
  const registry = path.join(workspace, 'pipelines');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(
    path.join(registry, 'valid-pipeline.json'),
    JSON.stringify(def({ name: '已登记演示管线', intent: '用于看板登记列表的演示定义' }), null, 2)
  );
  fs.writeFileSync(path.join(registry, 'bad-pipeline.json'), '{"version":1}');
  fs.writeFileSync(path.join(registry, 'index.json'), JSON.stringify({
    pipelines: [{ file: 'valid-pipeline.json', category: '演示分类', tags: ['示例', '置顶'], pinned: true }]
  }, null, 2));

  // Delivered outputs (read-only listing/serving) plus one symlink that must be refused.
  const outputDir = path.join(workspace, 'output');
  fs.mkdirSync(path.join(outputDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'report.md'), '# demo report\n\n<!-- NEWS_REPORT_COMPLETE:1:180 -->\n');
  fs.writeFileSync(path.join(outputDir, 'report.html'), '<html><body>demo</body></html>\n');
  fs.writeFileSync(path.join(outputDir, 'nested', 'receipt.json'), '{"quality": "full"}\n');
  fs.symlinkSync('/etc/hosts', path.join(outputDir, 'escape.txt'));
  return runMap;
}

function writeInvalidFiles(workspace) {
  const dir = path.join(workspace, '.orchestrator');
  fs.writeFileSync(path.join(dir, 'not-a-run.json'), '{}');
  fs.writeFileSync(path.join(dir, '00000000-0000-0000-0000-000000000000.json'), '{not json');
  const target = path.join(dir, '11111111-1111-1111-1111-111111111111.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(dir, '22222222-2222-2222-2222-222222222222.json'));
  // shallow-valid but structurally corrupt: receipts must be objects, nodes cannot be empty
  fs.writeFileSync(
    path.join(dir, '33333333-3333-3333-3333-333333333333.json'),
    JSON.stringify({
      version: 1,
      id: '33333333-3333-3333-3333-333333333333',
      owner: 'corrupt',
      revision: 0,
      definition: { name: '坏快照', intent: '坏', nodes: [], deliveries: [] },
      index: 0,
      status: 'ready',
      active: null,
      events: [],
      receipts: [null]
    })
  );
  fs.writeFileSync(
    path.join(dir, '55555555-5555-5555-5555-555555555555.json'),
    JSON.stringify({
      version: 1,
      id: '55555555-5555-5555-5555-555555555555',
      owner: 'corrupt',
      revision: 0,
      definition: { name: '坏证据', intent: '坏', nodes: [{ id: 'x', type: 'task', proofs: [null] }], deliveries: [{ path: 'x', sha256: 7 }] },
      index: 0,
      status: 'ready',
      active: null,
      events: [],
      receipts: [{ node: 'x', evidence: [{ path: 'x', sha256: 9 }] }]
    })
  );
}

let workspace;
let runMap;
let viewer;
let origin;

before(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-viewer-'));
  runMap = buildFixtures(workspace);
  writeInvalidFiles(workspace);
  viewer = await startViewer({ workspace, port: 0 });
  origin = new URL(viewer.url).origin;
});

after(async () => {
  if (viewer) await viewer.close();
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

const withToken = (extra = {}) => ({ 'x-orch-viewer-token': viewer.token, ...extra });

test('loadRuns skips invalid and symlink state files with warnings', () => {
  const { runs, warnings } = loadRuns(workspace);
  assert.ok(runs.length >= 5);
  assert.ok(warnings.some(w => w.includes('not-a-run.json')));
  assert.ok(warnings.some(w => w.includes('00000000-0000-0000-0000-000000000000.json')));
  assert.ok(warnings.some(w => w.includes('22222222-2222-2222-2222-222222222222.json')));
  assert.ok(warnings.some(w => w.includes('33333333-3333-3333-3333-333333333333.json')));
  assert.ok(warnings.some(w => w.includes('55555555-5555-5555-5555-555555555555.json')));
  assert.equal(runs.some(r => r.id === '22222222-2222-2222-2222-222222222222'), false);
  assert.equal(runs.some(r => r.id === '33333333-3333-3333-3333-333333333333'), false);
});

test('page requires the per-process token and escapes dynamic text', async () => {
  const denied = await fetch(`${origin}/`);
  assert.equal(denied.status, 403);
  const page = await fetch(`${origin}/?token=${encodeURIComponent(viewer.token)}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  const html = await page.text();
  assert.ok(html.includes('完成的笔记管线'));
  assert.ok(html.includes('交付已核验'));
  assert.ok(html.includes('\\u003cscript\\u003ealert(1)\\u003c/script\\u003e'), 'dynamic intent must be JSON-escaped');
  assert.equal(html.includes('<script>alert(1)</script>'), false);
});

test('api/runs returns summaries in real time shape', async () => {
  const res = await fetch(`${origin}/api/runs`, { headers: withToken() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.readOnly, false);
  assert.equal(body.workspace, workspace);
  const statuses = new Set(body.runs.map(r => r.status));
  assert.ok(statuses.has('done'));
  assert.ok(statuses.has('waiting-human'));
  assert.ok(statuses.has('cancel-requested'));
  assert.ok(statuses.has('ready'));
  for (const run of body.runs) {
    assert.ok(Array.isArray(run.deliveries));
    assert.equal(typeof run.name, 'string');
    assert.equal(typeof run.needsAttention, 'boolean');
  }
  assert.ok(body.warnings.some(w => w.includes('not-a-run.json')));
});

test('pipeline registry shows registered definitions and skips invalid ones', async () => {
  const list = await fetch(`${origin}/api/runs`, { headers: withToken() }).then(r => r.json());
  assert.equal(list.pipelines.length, 1);
  const entry = list.pipelines[0];
  assert.equal(entry.name, '已登记演示管线');
  assert.equal(entry.intent, '用于看板登记列表的演示定义');
  assert.equal(entry.nodes, 1);
  assert.equal(entry.deliveries, 1);
  assert.equal(entry.file, 'pipelines/valid-pipeline.json');
  assert.equal(entry.definition.name, '已登记演示管线');
  assert.ok(list.pipelineWarnings.some(w => w.includes('bad-pipeline.json')));

  const page = await fetch(`${origin}/?token=${encodeURIComponent(viewer.token)}`).then(r => r.text());
  assert.ok(page.includes('已登记演示管线'));
  assert.ok(page.includes('pipelines/valid-pipeline.json'));
  assert.ok(page.includes('"pipelines"'));
});

test('pipeline index supplies category, tags, pin and usage stats', async () => {
  const list = await fetch(`${origin}/api/runs`, { headers: withToken() }).then(r => r.json());
  const entry = list.pipelines.find(p => p.file === 'pipelines/valid-pipeline.json');
  assert.ok(entry);
  assert.equal(entry.category, '演示分类');
  assert.deepEqual(entry.tags, ['示例', '置顶']);
  assert.equal(entry.pinned, true);
  assert.equal(entry.runCount, 0);
  assert.equal(entry.lastRunAt, null);
});

test('outputs are listed read-only and served only from output/', async () => {
  const list = await fetch(`${origin}/api/runs`, { headers: withToken() }).then(r => r.json());
  const paths = list.outputs.map(f => f.path).sort();
  assert.deepEqual(paths, ['output/nested/receipt.json', 'output/report.html', 'output/report.md']);
  assert.ok(list.outputWarnings.some(w => w.includes('escape.txt')));

  const served = await fetch(`${origin}/api/outputs/content?path=${encodeURIComponent('output/report.md')}`, { headers: withToken() });
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /text\/plain/);
  assert.match(await served.text(), /NEWS_REPORT_COMPLETE/);

  const html = await fetch(`${origin}/api/outputs/content?path=${encodeURIComponent('output/report.html')}`, { headers: withToken() });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /sandbox/);

  for (const bad of ['output/../AGENT.md', '../AGENT.md', '/etc/hosts', 'AGENT.md', 'output/escape.txt']) {
    const response = await fetch(`${origin}/api/outputs/content?path=${encodeURIComponent(bad)}`, { headers: withToken() });
    assert.ok([400, 409, 404].includes(response.status), `${bad} -> ${response.status}`);
  }
  const noToken = await fetch(`${origin}/api/outputs/content?path=${encodeURIComponent('output/report.md')}`);
  assert.equal(noToken.status, 403);
});

test('run detail verifies current artifact bytes against the receipt', async () => {
  const before = await fetch(`${origin}/api/runs/${runMap.done}`, { headers: withToken() }).then(r => r.json());
  assert.equal(before.run.status, 'done');
  assert.equal(before.artifacts.length, 1);
  assert.equal(before.artifacts[0].path, 'out.txt');
  assert.equal(before.artifacts[0].status, 'match');
  const receiptSha = before.artifacts[0].recordedSha256;
  assert.match(receiptSha, /^[a-f0-9]{64}$/);

  fs.writeFileSync(path.join(workspace, 'out.txt'), 'ok changed');
  const afterChange = await fetch(`${origin}/api/runs/${runMap.done}`, { headers: withToken() }).then(r => r.json());
  assert.equal(afterChange.artifacts[0].status, 'changed');
  assert.notEqual(afterChange.artifacts[0].currentSha256, receiptSha);
});

test('action endpoints require POST, token header, allowed origin and read-write mode', async () => {
  const queryOnly = await fetch(`${origin}/api/runs/${runMap.ready}/next?token=${encodeURIComponent(viewer.token)}`, { method: 'POST' });
  assert.equal(queryOnly.status, 403);

  const wrongOrigin = await fetch(`${origin}/api/runs/${runMap.ready}/next`, {
    method: 'POST',
    headers: withToken({ Origin: 'https://evil.example' })
  });
  assert.equal(wrongOrigin.status, 403);

  const getAction = await fetch(`${origin}/api/runs/${runMap.ready}/next`, { headers: withToken() });
  assert.equal(getAction.status, 405);

  const bogus = await fetch(`${origin}/api/runs/${runMap.ready}/bogus`, {
    method: 'POST',
    headers: withToken()
  });
  assert.equal(bogus.status, 404);

  const badId = await fetch(`${origin}/api/runs/..%2F..%2Fetc`, { headers: withToken() });
  assert.equal(badId.status, 404);

  const multibyteToken = await fetch(`${origin}/api/runs`, { headers: { 'x-orch-viewer-token': 'é'.repeat(viewer.token.length) } });
  assert.equal(multibyteToken.status, 403);

  const host = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: viewer.port, path: '/', headers: { Host: 'evil.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(-1));
    req.end();
  });
  assert.equal(host, 403);
});

test('scheduling actions follow the core state machine and keep state persisted', async () => {
  const post = (action) =>
    fetch(`${origin}/api/runs/${runMap.ready}/${action}`, { method: 'POST', headers: withToken() }).then(async res => ({
      status: res.status,
      body: await res.json()
    }));

  const started = await post('next');
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'waiting-action');
  assert.match(started.body.operation, /^[a-f0-9-]{36}$/);
  const operation = started.body.operation;

  const again = await post('next');
  assert.equal(again.status, 409);
  assert.match(again.body.error, /cannot advance/);

  const persisted = JSON.parse(fs.readFileSync(path.join(workspace, '.orchestrator', `${runMap.ready}.json`), 'utf8'));
  assert.equal(persisted.status, 'waiting-action');
  assert.equal(persisted.active.operation, operation);

  const paused = await post('pause');
  assert.equal(paused.status, 200);
  assert.equal(paused.body.status, 'paused');

  const resumed = await post('resume');
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.status, 'waiting-action');

  const cancelled = await post('cancel');
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancel-requested');

  const terminalNext = await post('next');
  assert.equal(terminalNext.status, 409);
});

test('read-only mode hides actions and rejects them', async () => {
  const readonlyViewer = await startViewer({ workspace, port: 0, readOnly: true });
  try {
    const readonlyOrigin = new URL(readonlyViewer.url).origin;
    const list = await fetch(`${readonlyOrigin}/api/runs`, { headers: { 'x-orch-viewer-token': readonlyViewer.token } }).then(r => r.json());
    assert.equal(list.readOnly, true);
    const action = await fetch(`${readonlyOrigin}/api/runs/${runMap.cancelling}/pause`, {
      method: 'POST',
      headers: { 'x-orch-viewer-token': readonlyViewer.token }
    });
    assert.equal(action.status, 403);
    const health = await fetch(`${readonlyOrigin}/api/health`, { headers: { 'x-orch-viewer-token': readonlyViewer.token } }).then(r => r.json());
    assert.equal(health.readOnly, true);
    assert.equal(health.actions, false);
  } finally {
    await readonlyViewer.close();
  }
});

test('read-only GET traffic does not mutate state files', async () => {
  const dir = path.join(workspace, '.orchestrator');
  const before = fs.readdirSync(dir).sort().map(name => {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  });
  await fetch(`${origin}/?token=${encodeURIComponent(viewer.token)}`);
  await fetch(`${origin}/api/runs`, { headers: withToken() });
  await fetch(`${origin}/api/runs/${runMap.done}`, { headers: withToken() });
  const afterReads = fs.readdirSync(dir).sort().map(name => {
    const st = fs.statSync(path.join(dir, name));
    return `${name}:${st.size}:${st.mtimeMs}`;
  });
  assert.deepEqual(afterReads, before);
});

test('SSE pushes an initial snapshot and another snapshot after a state change', async () => {
  const controller = new AbortController();
  const res = await fetch(`${origin}/api/events?token=${encodeURIComponent(viewer.token)}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const readUntil = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (predicate(buffer)) return true;
    }
    return false;
  };
  try {
    assert.ok(await readUntil(text => text.includes('event: snapshot')), 'initial snapshot');
    assert.ok(buffer.includes('完成的笔记管线'));
    const firstLength = buffer.length;
    const newRun = createRun(workspace, def({ name: '实时推送管线', intent: '用于验证 SSE 推送' }));
    assert.ok(
      await readUntil(text => text.length > firstLength && (text.match(/event: snapshot/g) || []).length >= 2, 6000),
      'second snapshot after state change'
    );
    assert.ok(buffer.includes('实时推送管线'));
    assert.ok(newRun.id);
  } finally {
    controller.abort();
  }
});

test('symlinked .orchestrator is refused for listing and single-run reads', async () => {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-viewer-target-'));
  const linkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-viewer-link-'));
  const run = createRun(targetRoot, def({ name: '符号链接目录', intent: '校验符号链接目录被拒绝' }));
  fs.symlinkSync(path.join(targetRoot, '.orchestrator'), path.join(linkRoot, '.orchestrator'));
  const linked = await startViewer({ workspace: linkRoot, port: 0 });
  try {
    const list = await fetch(`${new URL(linked.url).origin}/api/runs`, { headers: { 'x-orch-viewer-token': linked.token } }).then(r => r.json());
    assert.equal(list.runs.length, 0);
    assert.ok(list.warnings.some(w => w.includes('不是安全的普通目录')));
    const detail = await fetch(`${new URL(linked.url).origin}/api/runs/${run.id}`, { headers: { 'x-orch-viewer-token': linked.token } });
    assert.equal(detail.status, 409);
    const unit = loadRuns(linkRoot);
    assert.equal(unit.runs.length, 0);
    assert.ok(unit.warnings.some(w => w.includes('不是安全的普通目录')));
  } finally {
    await linked.close();
    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.rmSync(linkRoot, { recursive: true, force: true });
  }
});

test('structurally corrupt state file is skipped and does not break API or live push', async () => {
  const dir = path.join(workspace, '.orchestrator');
  const corrupt = path.join(dir, '44444444-4444-4444-4444-444444444444.json');
  fs.writeFileSync(corrupt, JSON.stringify({
    version: 1,
    id: '44444444-4444-4444-4444-444444444444',
    owner: 'corrupt',
    revision: 0,
    definition: { name: '坏事件', intent: '坏', nodes: [{ id: 'x', type: 'task' }], deliveries: [{ path: 'x' }] },
    index: 0,
    status: 'ready',
    active: null,
    events: [null],
    receipts: []
  }));
  try {
    await new Promise(resolve => setTimeout(resolve, 1400)); // let watcher/poll broadcast the change
    const runs = await fetch(`${origin}/api/runs`, { headers: withToken() });
    assert.equal(runs.status, 200);
    const body = await runs.json();
    assert.ok(body.warnings.some(w => w.includes('44444444-4444-4444-4444-444444444444.json')));
    assert.equal(body.runs.some(r => r.id === '44444444-4444-4444-4444-444444444444'), false);
    const health = await fetch(`${origin}/api/health`, { headers: withToken() });
    assert.equal(health.status, 200);
  } finally {
    fs.rmSync(corrupt, { force: true });
  }
});

test('stale lock blocks actions with a friendly, path-free error and manual recovery works', async () => {
  const definition = def({ name: '锁测试管线', intent: '验证遗留锁时的错误与手动恢复' });
  const run = createRun(workspace, definition);
  const lock = path.join(workspace, '.orchestrator', `${run.id}.json.lock`);
  fs.writeFileSync(lock, '{"pid":999999}');
  try {
    const blocked = await fetch(`${origin}/api/runs/${run.id}/next`, { method: 'POST', headers: withToken() });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.match(body.error, /锁|lock/);
    assert.equal(body.error.includes(workspace), false, 'error must not leak the absolute workspace path');
  } finally {
    fs.rmSync(lock, { force: true });
  }
  const started = await fetch(`${origin}/api/runs/${run.id}/next`, { method: 'POST', headers: withToken() });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).status, 'waiting-action');
});

test('direct src/viewer.js entry works without an explicit token (regression)', async () => {
  const child = spawn(process.execPath, ['src/viewer.js', workspace, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const url = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)), 6000);
      const check = () => {
        const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+/.exec(stdout);
        if (match) {
          clearTimeout(deadline);
          resolve(match[0]);
        }
      };
      child.stdout.on('data', check);
      child.on('exit', code => {
        clearTimeout(deadline);
        reject(new Error(`exited early code=${code} stdout=${stdout} stderr=${stderr}`));
      });
    });
    const probe = await fetch(new URL(url).href);
    assert.equal(probe.status, 200);
    assert.match(stdout, /只读 \+ 调度/);
  } finally {
    child.kill('SIGINT');
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test('orch view CLI prints a loopback URL and stops on SIGINT', async () => {
  const child = spawn(process.execPath, ['src/cli.js', 'view', workspace, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  try {
    const url = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timeout; stdout=${stdout} stderr=${stderr}`)), 6000);
      const check = () => {
        const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=[A-Za-z0-9_-]+/.exec(stdout);
        if (match) {
          clearTimeout(deadline);
          resolve(match[0]);
        }
      };
      child.stdout.on('data', check);
      child.on('exit', code => {
        clearTimeout(deadline);
        reject(new Error(`exited early code=${code} stdout=${stdout} stderr=${stderr}`));
      });
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    const probe = await fetch(new URL(url).href);
    assert.equal(probe.status, 200);
    assert.match(stdout, /只读 \+ 调度/);
  } finally {
    child.kill('SIGINT');
    child.stdout.destroy();
    child.stderr.destroy();
  }
});
