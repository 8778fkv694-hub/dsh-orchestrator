/**
 * Optional Harness sidebar entry bundle (`entry/`): Host dashboard manager,
 * its loopback route, and the browser-side manager page.
 *
 * Nothing here launches a real viewer process or the real Harness: the Host
 * test injects a fake viewer module and a fake Cordis context, and the Client
 * test runs the plain-JS bundle against a minimal hook runtime plus stubbed
 * `fetch`/`window`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../entry/index.js';

const FAKE_VIEWER = `
export async function startViewer(options) {
  globalThis.__viewerCalls = globalThis.__viewerCalls || [];
  globalThis.__viewerCalls.push({ kind: 'start', options });
  const port = options.port || 18893;
  return {
    url: 'http://127.0.0.1:' + port + '/?token=' + options.token,
    token: options.token,
    port,
    close: async () => { globalThis.__viewerCalls.push({ kind: 'close', port }); },
  };
}
`;

function hostFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-entry-host-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const viewerEntry = path.join(root, 'fake-viewer.mjs');
  fs.writeFileSync(viewerEntry, FAKE_VIEWER, 'utf8');
  const dataFile = path.join(root, 'state', 'dashboards.json');
  const routes = [];
  const cleanups = [];
  const ctx = {
    effect(fn) {
      const dispose = fn();
      cleanups.push(dispose);
      return dispose;
    },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
      getOrigin: () => 'http://127.0.0.1:1',
    },
  };
  return { root, workspace, viewerEntry, dataFile, routes, cleanups, ctx };
}

function callRoute(route, method, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.headers = headers;
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(text) {
        resolve({ status: this.statusCode, headers: this.headers, body: text === undefined ? undefined : JSON.parse(text) });
      },
    };
    Promise.resolve(route.handler(req, res)).catch(reject);
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
}

test('entry host: seeded dashboard, route hardening, add/remove and cleanup', async (t) => {
  const fixture = hostFixture(t);
  apply(fixture.ctx, {
    dataFile: fixture.dataFile,
    viewerEntry: fixture.viewerEntry,
    dashboards: [{ id: 'seed', label: '种子看板', workspace: fixture.workspace, port: 0 }],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(fixture.routes.length, 1, 'one route handles GET and POST');
  const route = fixture.routes[0];
  assert.equal(route.path, '/orch-entry/api/dashboards');

  const first = await callRoute(route, 'GET');
  assert.equal(first.status, 200);
  assert.equal(first.body.dashboards.length, 1);
  const seeded = first.body.dashboards[0];
  assert.equal(seeded.state, 'running');
  assert.equal(seeded.port, 18893);
  assert.ok(seeded.url.includes('token='), 'resolved URL carries the token');

  assert.ok(fs.existsSync(fixture.dataFile), 'state file persisted');
  const saved = JSON.parse(fs.readFileSync(fixture.dataFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.dashboards[0].token, seeded.url.split('token=')[1], 'token persisted for stable URLs');

  const foreign = await callRoute(route, 'GET', { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403, 'foreign origin rejected');

  const foreignPost = await callRoute(route, 'POST', { 'content-type': 'application/json', origin: 'https://evil.example' }, { action: 'add', url: 'http://127.0.0.1:1/' });
  assert.equal(foreignPost.status, 403, 'foreign POST origin rejected');

  const wrongType = await callRoute(route, 'POST', { 'content-type': 'text/plain' }, { action: 'add', url: 'http://127.0.0.1:1/' });
  assert.equal(wrongType.status, 415, 'JSON content type required');

  const external = await callRoute(route, 'POST', { 'content-type': 'application/json' }, { action: 'add', label: '外链', url: 'http://127.0.0.1:9999/?token=x' });
  assert.equal(external.status, 200);
  assert.equal(external.body.dashboard.external, true);

  const badWorkspace = await callRoute(route, 'POST', { 'content-type': 'application/json' }, { action: 'add', workspace: path.join(fixture.root, 'missing') });
  assert.equal(badWorkspace.status, 400, 'missing workspace rejected');

  const badPort = await callRoute(route, 'POST', { 'content-type': 'application/json' }, { action: 'add', workspace: fixture.workspace, port: 99999 });
  assert.equal(badPort.status, 400, 'invalid port rejected');

  const managed = await callRoute(route, 'POST', { 'content-type': 'application/json' }, { action: 'add', label: '第二管线', workspace: fixture.workspace });
  assert.equal(managed.status, 200);
  assert.equal(managed.body.dashboard.state, 'running');

  const both = await callRoute(route, 'GET');
  assert.equal(both.body.dashboards.length, 3);
  assert.equal(both.body.dashboards.filter((entry) => entry.external).length, 1);

  const removed = await callRoute(route, 'POST', { 'content-type': 'application/json' }, { action: 'remove', id: external.body.dashboard.id });
  assert.equal(removed.status, 200);
  const afterRemove = await callRoute(route, 'GET');
  assert.equal(afterRemove.body.dashboards.length, 2);
  assert.equal(afterRemove.body.dashboards.filter((entry) => entry.external).length, 0);

  const unknownAction = await callRoute(route, 'POST', { 'content-type': 'application/json' }, { action: 'nope' });
  assert.equal(unknownAction.status, 400);

  for (const cleanup of fixture.cleanups) cleanup();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closes = (globalThis.__viewerCalls || []).filter((record) => record.kind === 'close');
  assert.equal(closes.length, 2, 'cleanup closes every managed viewer');
});

test('entry client: sidebar entry, manager page actions, add form and guide', async (t) => {
  const stores = new WeakMap();
  const effectQueue = [];
  let currentStore = null;
  const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const storeOf = (component) => {
    let store = stores.get(component);
    if (store === undefined) {
      store = { slots: [], deps: [], index: 0 };
      stores.set(component, store);
    }
    return store;
  };
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const store = currentStore;
      const index = store.index++;
      if (!(index in store.slots)) store.slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        store.slots[index],
        (value) => {
          store.slots[index] = typeof value === 'function' ? value(store.slots[index]) : value;
        },
      ];
    },
    useEffect(fn, deps) {
      const store = currentStore;
      const index = store.index++;
      const previous = store.deps[index];
      store.deps[index] = deps;
      if (deps === undefined || !depsEqual(previous, deps)) effectQueue.push(fn);
    },
  };

  let dashboards = [
    { id: 'd1', label: '新闻简报', workspace: '/workspace/project', port: 8893, url: 'http://127.0.0.1:8893/?token=a', external: false, state: 'running', error: null },
    { id: 'd2', label: '外链看板', workspace: null, port: null, url: 'http://127.0.0.1:8891/?token=b', external: true, state: 'external', error: null },
  ];
  const fetchCalls = [];
  const jsonResponse = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
  const opened = [];
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  t.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.window = previousWindow;
  });
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, init: { method: init.method || 'GET', body: init.body, credentials: init.credentials } });
    if (init.method !== 'POST') return jsonResponse({ ok: true, dashboards });
    const body = JSON.parse(init.body);
    if (body.action === 'add') {
      return jsonResponse({
        ok: true,
        dashboard: {
          id: 'added',
          label: body.label || '新看板',
          workspace: body.workspace === undefined ? null : body.workspace,
          port: body.port === undefined ? null : Number(body.port),
          url: body.url === undefined ? null : body.url,
          external: body.url !== undefined,
          state: body.url === undefined ? 'running' : 'external',
          error: null,
        },
      });
    }
    if (body.action === 'remove') {
      dashboards = dashboards.filter((entry) => entry.id !== body.id);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ ok: false, error: { message: 'bad' } }, 400);
  };

  let factoryResult = null;
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        factoryResult = factory((name) => {
          if (name === 'react') return React;
          throw new Error(`unexpected require ${name}`);
        });
      },
    },
    open: (url, target) => {
      opened.push({ url, target });
      return {};
    },
  };
  await import('../entry/client.js');
  assert.ok(factoryResult !== null, 'client bundle registers a factory');

  const dicts = [];
  const sessionStarts = [];
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register(ns, value) {
        dicts.push({ ns, value });
        return () => {};
      },
      bind: () => (key) => (dicts[0].value.zh[key] === undefined ? key : dicts[0].value.zh[key]),
    },
    slots: {
      inject: (name, callback) => {
        callback();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    workspaces: {
      list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', path: '/workspace/project' }] }) },
      create: async (input) => ({ workspaceId: 'ws-created', path: input.path }),
    },
    uiWorkspace: {
      startSession: (workspaceId, options) => {
        sessionStarts.push({ workspaceId, options });
      },
    },
  };
  for (const service of factoryResult.inject) assert.ok(service in ctx, `missing client service: ${service}`);
  factoryResult.apply(ctx);

  const main = registrations.find((registration) => registration.options.name === 'main');
  const icon = registrations.find((registration) => registration.options.name === 'sidebar.panellist');
  assert.ok(main !== undefined && icon !== undefined, 'main panel and sidebar entry registered');
  assert.equal(icon.options.order, 5, 'entry sits below Plugins');
  assert.equal(icon.options.id, 'orch-entry');
  assert.equal(icon.options.label(), '管线');

  function materialize(node) {
    if (node === null || node === undefined) return node;
    if (Array.isArray(node)) return node.map(materialize);
    if (typeof node === 'object' && typeof node.type === 'function') {
      const store = storeOf(node.type);
      const previous = currentStore;
      currentStore = store;
      store.index = 0;
      const rendered = node.type(node.props);
      currentStore = previous;
      return materialize(rendered);
    }
    if (typeof node === 'object' && Array.isArray(node.children)) {
      return { type: node.type, props: node.props, children: node.children.map(materialize) };
    }
    return node;
  }
  function renderPage() {
    const store = storeOf(main.component);
    currentStore = store;
    store.index = 0;
    const tree = main.component({ t: (key) => dicts[0].value.zh[key] });
    currentStore = null;
    const materialized = materialize(tree);
    while (effectQueue.length > 0) effectQueue.shift()();
    return materialized;
  }
  function textOf(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return textOf(node.children);
  }
  function elements(node, predicate, out = []) {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) {
      for (const child of node) elements(child, predicate, out);
      return out;
    }
    if (typeof node === 'object') {
      if (predicate(node)) out.push(node);
      if (Array.isArray(node.children)) for (const child of node.children) elements(child, predicate, out);
    }
    return out;
  }
  const buttons = (tree) => elements(tree, (node) => node.type === 'button');

  let tree = renderPage();
  assert.ok(textOf(tree).includes('正在读取看板列表'), 'loading state before the first read resolves');
  assert.equal(fetchCalls[0].url, '/orch-entry/api/dashboards');
  assert.equal(fetchCalls[0].init.credentials, 'same-origin');

  await new Promise((resolve) => setTimeout(resolve, 20));
  tree = renderPage();
  assert.ok(textOf(tree).includes('看板 · 2'), 'dashboard count rendered');
  assert.ok(textOf(tree).includes('新闻简报') && textOf(tree).includes('外链看板'));

  const openButtons = buttons(tree).filter((button) => textOf(button) === '打开看板');
  assert.equal(openButtons.length, 2, 'one open action per dashboard');
  openButtons[0].props.onClick();
  assert.equal(opened[0].url, 'http://127.0.0.1:8893/?token=a');
  assert.equal(opened[0].target, '_blank');

  const enterButtons = buttons(tree).filter((button) => textOf(button) === '进入会话');
  assert.equal(enterButtons.length, 1, 'external dashboards have no session action');
  enterButtons[0].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessionStarts.length, 1);
  assert.equal(sessionStarts[0].workspaceId, 'ws-1');
  assert.ok(sessionStarts[0].options.prompt.includes('新闻简报'));
  assert.ok(sessionStarts[0].options.prompt.includes('orch_status'));

  tree = renderPage();
  const inputs = elements(tree, (node) => node.type === 'input');
  assert.equal(inputs.length, 4, 'add form has four fields');
  inputs[0].props.onChange({ currentTarget: { value: '第二管线' } });
  inputs[1].props.onChange({ currentTarget: { value: '/workspace/project' } });
  inputs[2].props.onChange({ currentTarget: { value: '8895' } });
  tree = renderPage();
  const addButton = buttons(tree).find((button) => textOf(button) === '添加看板');
  assert.ok(addButton !== undefined, 'add button');
  addButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const posts = fetchCalls.filter((record) => record.init.method === 'POST');
  assert.deepEqual(JSON.parse(posts.at(-1).init.body), { action: 'add', label: '第二管线', workspace: '/workspace/project', port: '8895' });
  assert.ok(textOf(renderPage()).includes('已添加'));

  tree = renderPage();
  const removeButtons = buttons(tree).filter((button) => textOf(button) === '移除');
  assert.ok(removeButtons.length >= 2);
  removeButtons[1].props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const removePost = fetchCalls.filter((record) => record.init.method === 'POST').at(-1);
  assert.deepEqual(JSON.parse(removePost.init.body), { action: 'remove', id: 'd2' });

  tree = renderPage();
  assert.ok(textOf(tree).includes('操作说明'), 'guide section rendered');
  assert.ok(textOf(tree).includes('推荐流程'), 'suggested flow rendered');
});
