import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

// Execute the shipped client with a minimal DOM; no copy of client handlers.
function client(source = fs.readFileSync(new URL('../src/viewer.js', import.meta.url), 'utf8')) {
  const script = source.split('const APP_JS = String.raw`')[1].split('\n})();`;')[0];
  const elements = new Map();
  const el = selector => {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: true, textContent: '', innerHTML: '', className: '',
      setAttribute() {}, addEventListener() {}, focus() {}, querySelector() { return null; }
    });
    return elements.get(selector);
  };
  const snapshot = { workspace: '/fixture', runs: [], pipelines: [], outputs: [], warnings: [] };
  el('#boot').textContent = JSON.stringify({ token: 'fixture', snapshot });
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: id => el('#' + id), querySelector: el, querySelectorAll: () => [], addEventListener() {} },
    window: { confirm() { return false; } }, // Harness suppresses native dialogs.
    localStorage: { getItem() { return null; }, setItem() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url === '/api/runs' ? snapshot : {
        status: 'waiting-action', artifacts: [],
        run: { id: url.split('/')[3], status: 'waiting-action', revision: 1, index: 0, active: null,
          definition: { name: 'fixture', intent: 'fixture', nodes: [], deliveries: [] }, events: [], receipts: [] }
      } };
    }
  });
  vm.runInContext(script + `
    globalThis.audit = { runAction, finishConfirmation, renderOutputs, setView, closeDrawer, render, selectOutput, activityHtml, stepFlow, runCard, elapsedText,
      outputs(value) { snapshot.outputs = value; },
      select(id, revision) { selectedRunId = id; runDetail = { run: { id, revision } }; },
      readOnly(value) { snapshot.readOnly = value; } };
  })();`, context);
  return { context, el, requests, run(code) { return vm.runInContext(code, context); } };
}

// Expose closures only in the test VM, keeping the public browser bundle unchanged.
function fixture() {
  return client();
}

test('embedded client requires visible confirmation, supports dismissal and submits once', async () => {
  const f = fixture();
  f.run("audit.select('run-a', 0)");
  const dismissed = f.run("audit.runAction('next')");
  assert.equal(f.el('#actionConfirmation').hidden, false);
  assert.match(f.el('#actionConfirmationText').textContent, /Harness/);
  assert.equal(f.requests.length, 0);
  f.el('#dismissAction').onclick();
  await dismissed;
  assert.equal(f.requests.length, 0);
  const accepted = f.run("audit.runAction('next')");
  f.el('#confirmAction').onclick();
  f.el('#confirmAction').onclick();
  await accepted;
  assert.equal(f.requests.filter(r => r.options?.method === 'POST').length, 1);
  assert.equal(f.el('#actionConfirmation').hidden, true);
});

test('embedded confirmation refuses a changed selection or revision and respects read-only', async () => {
  for (const replacement of ["audit.select('run-b', 0)", "audit.select('run-a', 1)"]) {
    const f = fixture();
    f.run("audit.select('run-a', 0)");
    const pending = f.run("audit.runAction('cancel')");
    assert.match(f.el('#actionConfirmationText').textContent, /取消请求/);
    f.run(replacement);
    f.el('#confirmAction').onclick();
    await pending;
    assert.equal(f.requests.length, 0);
    assert.match(f.el('#toast').textContent, /运行已变化/);
  }
  const f = fixture();
  f.run("audit.select('run-a', 0); audit.readOnly(true)");
  await f.run("audit.runAction('pause')");
  assert.equal(f.requests.length, 0);
});

test('output toolbar refresh calls the API and displays success', async () => {
  const f = fixture();
  f.run('audit.renderOutputs()');
  await f.el('#refreshOutputs').onclick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/runs');
  assert.equal(f.el('#toast').textContent, '已刷新');
});

test('failed refresh reports its cause instead of displaying false success', async () => {
  const f = fixture();
  f.context.fetch = async () => { throw new Error('connection unavailable'); };
  f.run('audit.renderOutputs()');
  await f.el('#refreshOutputs').onclick();
  assert.match(f.el('#toast').textContent, /刷新失败：connection unavailable/);
  assert.equal(f.el('#toast').className, 'toast show error');
});

test('closing an automatically followed output stays closed across refreshes and can reopen', () => {
  const f = fixture();
  f.run(`audit.outputs([{path:'output/audit.txt', name:'audit.txt', kind:'text', bytes:50}]); audit.setView('outputs')`);
  assert.equal(f.el('#drawer').hidden, false);
  f.run('audit.closeDrawer(); audit.render()');
  assert.equal(f.el('#drawer').hidden, true);
  f.run("audit.selectOutput('output/audit.txt')");
  assert.equal(f.el('#drawer').hidden, false);
});

test('run motion follows persisted state and stops for pause, human waits and terminal states', () => {
  const f = fixture();
  for (const status of ['ready', 'waiting-action', 'paused', 'waiting-human', 'cancel-requested', 'done', 'cancelled']) {
    const activity = f.run(`audit.activityHtml(${JSON.stringify(status)}, false)`);
    assert.equal(activity.includes('is-active'), status === 'waiting-action', status);
    assert.ok(activity.includes(`data-run-status="${status}"`));
    const flow = f.run(`audit.stepFlow({status:${JSON.stringify(status)}},0,{nodes:[{id:'task',type:'task'}]})`);
    assert.ok(flow.includes(`data-run-status="${status}"`));
    if (status === 'paused') assert.match(flow, /flowDot">Ⅱ/);
    const card = f.run(`audit.runCard({id:'fixture',status:${JSON.stringify(status)},name:'fixture',index:0,total:2})`);
    assert.equal(card.includes('is-active'), status === 'waiting-action');
    assert.match(card, /width:0%/, 'activity never invents completion progress');
  }
  assert.match(f.run("audit.activityHtml('waiting-action',false)"), /等待执行结果/);
  assert.match(f.run("audit.activityHtml('paused',false)"), /已派发的动作可能仍在执行/);
});

test('elapsed time advances from real event timestamps without changing workflow progress', () => {
  const f = fixture();
  assert.equal(f.run("audit.elapsedText('2026-10-30T00:00:00Z', Date.parse('2026-10-30T00:00:30Z'))"), '30 秒');
  assert.equal(f.run("audit.elapsedText('2026-10-30T00:00:00Z', Date.parse('2026-10-30T00:02:00Z'))"), '2 分钟');
  assert.equal(f.run("audit.elapsedText('invalid', Date.now())"), '未知');
});
