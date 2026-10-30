// CDP capture script for the viewer evidence screenshots.
import fs from 'node:fs';

const PORT = 9333;
const OUT = '/tmp/evidence-viewer';
const DEMO = 'http://127.0.0.1:8899/?token=<demo-token>';
const ACCEPTANCE = 'http://127.0.0.1:8898/?token=<acceptance-token>';

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const target = list.find(t => t.type === 'page');
  if (!target) throw new Error('no page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      return;
    }
    if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, []);
    listeners.get(method).push(fn);
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return { send, on, close: () => ws.close() };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evalJS(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result.result?.value;
}

async function waitFor(client, expression, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evalJS(client, expression).catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  throw new Error('timeout waiting for ' + expression);
}

async function shot(client, name) {
  const result = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = `${OUT}/${name}.png`;
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log('saved', file);
}

async function main() {
  const client = await connect();
  client.on('Page.javascriptDialogOpening', async () => {
    await client.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  try {
    await client.send('Page.navigate', { url: DEMO });
    await waitFor(client, `document.querySelectorAll('#runs [data-run]').length >= 4`);
    await sleep(600);
    await shot(client, '02-viewer-dashboard-demo');
    const text = await evalJS(client, 'document.body.innerText');
    fs.writeFileSync(`${OUT}/demo-page-text.txt`, text);

    // Select the ready run and capture its detail.
    await evalJS(client, `document.querySelector('[data-run="df498d2d-ba14-4377-be81-2a5296b6b01f"]').click()`);
    await waitFor(client, `document.querySelector('[data-act="next"]') !== null`);
    await sleep(500);
    await shot(client, '03-viewer-detail-ready');

    // Click the start button (confirm dialog auto-accepted by the handler).
    await evalJS(client, `document.querySelector('[data-act="next"]').click()`);
    await sleep(1500);
    await shot(client, '04-viewer-after-start');
    const after = await evalJS(client, 'document.body.innerText');
    fs.writeFileSync(`${OUT}/demo-after-start-page-text.txt`, after);
    const status = await fetch('http://127.0.0.1:8899/api/runs', { headers: { 'x-orch-viewer-token': '<demo-token>' } }).then(r => r.json());
    fs.writeFileSync(`${OUT}/demo-state-after-start.json`, JSON.stringify(status, null, 2));

    // Read-only acceptance workspace with real runs (no actions are clicked).
    await client.send('Page.navigate', { url: ACCEPTANCE });
    await waitFor(client, `document.querySelectorAll('#runs [data-run]').length >= 6`);
    await sleep(600);
    await shot(client, '05-viewer-acceptance-real-runs');
    const acceptanceText = await evalJS(client, 'document.body.innerText');
    fs.writeFileSync(`${OUT}/acceptance-page-text.txt`, acceptanceText);
    console.log('done');
  } finally {
    client.close();
  }
}

main().catch(error => {
  console.error('ERR', error.message);
  process.exit(1);
});
