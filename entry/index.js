/**
 * Host half of the optional Harness sidebar entry bundle.
 *
 * Owns the dashboard list and the loopback dashboard servers behind it:
 *   - the list lives in a small JSON state file (seeded once from the bundle
 *     patch config), so the browser page can add/remove dashboards and keep
 *     them across restarts;
 *   - every non-external dashboard gets its own read-only orchestrator viewer
 *     started inside the Host process on 127.0.0.1 (port from the entry, or an
 *     OS-assigned port when omitted) with its own access token;
 *   - GET/POST /orch-entry/api/dashboards is the page's channel to this state.
 *     It is registered on the Host web server, so the Desktop shell forwards it
 *     with the page's authenticated cookie and the Web profile reaches it
 *     same-origin.
 *
 * The viewer never executes a task, never starts external commands and never
 * calls a model: its actions only persist work orders. Human gates stay in the
 * Harness session. This bundle is opt-in; it does not modify the orchestrator
 * plugin or the user's profile beyond its own installation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const name = 'orch-entry';

/** The Host HTTP carrier, and the trust fence guarding its routes. */
export const inject = ['webServer', 'connection'];

const ROUTE = '/orch-entry/api/dashboards';
const MAX_BODY = 64 * 1024;

/** Defaults for a bundle installed from this checkout: the sibling viewer and a
 * state file next to the bundle. Both can be overridden from the profile patch. */
const DEFAULT_VIEWER_ENTRY = fileURLToPath(new URL('../src/viewer.js', import.meta.url));
const DEFAULT_DATA_FILE = fileURLToPath(new URL('./data/dashboards.json', import.meta.url));

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizeEntry(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const url = typeof raw.url === 'string' && raw.url.trim() !== '' ? raw.url.trim() : undefined;
  const workspace = typeof raw.workspace === 'string' && raw.workspace.trim() !== '' ? path.resolve(raw.workspace.trim()) : undefined;
  if (url === undefined && workspace === undefined) return undefined;
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim().slice(0, 80) : `看板 ${index + 1}`;
  const port = Number.isSafeInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : undefined;
  const token = typeof raw.token === 'string' && raw.token.length >= 16 ? raw.token : undefined;
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : randomUUID();
  return { id, label, url, workspace, port, token };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function apply(ctx, config = {}) {
  const viewerEntry = typeof config.viewerEntry === 'string' && config.viewerEntry.trim() !== '' ? config.viewerEntry : DEFAULT_VIEWER_ENTRY;
  const dataFile = typeof config.dataFile === 'string' && config.dataFile.trim() !== '' ? config.dataFile : DEFAULT_DATA_FILE;
  const seedList = Array.isArray(config.dashboards) ? config.dashboards : [];
  if (!fs.existsSync(viewerEntry)) {
    console.warn(`[orch-entry] viewer entry not found at ${viewerEntry}; dashboard manager not started`);
    return;
  }

  /** Data model: [{ id, label, workspace?, url?, port?, token? }] */
  let entries = loadEntries();
  /** Runtime per id: { state, url, error, port, token, viewer } */
  const runtime = new Map();
  let disposed = false;

  function loadEntries() {
    try {
      const text = fs.readFileSync(dataFile, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.dashboards)) {
        return parsed.dashboards.map(normalizeEntry).filter((item) => item !== undefined);
      }
      console.warn('[orch-entry] dashboard state file has an unexpected shape; using seeds');
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`[orch-entry] cannot read dashboard state: ${error.message}; using seeds`);
    }
    const seeded = seedList.map(normalizeEntry).filter((item) => item !== undefined);
    persist(seeded);
    return seeded;
  }

  function persist(list) {
    try {
      fs.mkdirSync(path.dirname(dataFile), { recursive: true });
      const text = JSON.stringify({ version: 1, dashboards: list }, null, 2);
      const temporary = `${dataFile}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, dataFile);
    } catch (error) {
      console.warn(`[orch-entry] cannot save dashboard state: ${error.message}`);
    }
  }

  async function startEntry(entry) {
    const existing = runtime.get(entry.id);
    if (existing !== undefined) return existing;
    const record = { state: 'starting', url: undefined, error: undefined, port: entry.port, token: entry.token, viewer: null };
    runtime.set(entry.id, record);
    if (entry.url !== undefined) {
      record.state = 'external';
      record.url = entry.url;
      return record;
    }
    let lastError;
    for (let attempt = 0; attempt < 3 && !disposed; attempt += 1) {
      try {
        const viewer = await import(pathToFileURL(viewerEntry).href);
        if (disposed) break;
        const token = entry.token ?? randomBytes(24).toString('base64url');
        const handle = await viewer.startViewer({ workspace: entry.workspace, port: entry.port ?? 0, token });
        record.viewer = handle;
        record.state = 'running';
        record.url = handle.url;
        record.port = handle.port;
        record.token = token;
        entry.port = handle.port;
        entry.token = token;
        persist(entries);
        return record;
      } catch (error) {
        lastError = error;
        if (!(error instanceof Error) || !error.message.includes('EADDRINUSE')) break;
        await delay(250);
      }
    }
    record.state = 'failed';
    record.error = lastError instanceof Error ? lastError.message : String(lastError);
    return record;
  }

  function describe(entry) {
    const record = runtime.get(entry.id);
    return {
      id: entry.id,
      label: entry.label,
      workspace: entry.workspace ?? null,
      port: entry.port ?? record?.port ?? null,
      url: record?.url ?? entry.url ?? null,
      external: entry.url !== undefined,
      state: record?.state ?? 'starting',
      error: record?.error ?? null,
    };
  }

  function rejected(req, res) {
    try {
      const rejection = ctx.connection.requestRejection(req);
      if (rejection === undefined) return false;
      res.statusCode = rejection;
      res.end();
      return true;
    } catch {
      return false;
    }
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (origin === 'dsh-app://app') return true;
    try {
      return origin === ctx.webServer.getOrigin();
    } catch {
      return false;
    }
  }

  async function handleRoute(req, res) {
    if (rejected(req, res)) return;
    if (!originAllowed(req)) {
      sendError(res, 403, 'forbidden-origin', 'request origin is not allowed');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, dashboards: entries.map(describe), viewerEntry });
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, POST');
      res.end();
      return;
    }
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      sendError(res, 415, 'unsupported-media-type', 'content-type must be application/json');
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendError(res, 400, 'bad-request', 'request body is not valid JSON');
      return;
    }
    if (body === null || typeof body !== 'object') {
      sendError(res, 400, 'bad-request', 'request body must be a JSON object');
      return;
    }
    if (body.action === 'add') {
      const url = typeof body.url === 'string' && body.url.trim() !== '' ? body.url.trim() : undefined;
      const workspace = typeof body.workspace === 'string' && body.workspace.trim() !== '' ? path.resolve(body.workspace.trim()) : undefined;
      if (url === undefined && workspace === undefined) {
        sendError(res, 400, 'missing-target', 'workspace or url is required');
        return;
      }
      if (url !== undefined && !isHttpUrl(url)) {
        sendError(res, 400, 'bad-url', 'url must be an http(s) address');
        return;
      }
      if (workspace !== undefined) {
        try {
          if (!fs.statSync(workspace).isDirectory()) throw new Error('not a directory');
        } catch (error) {
          sendError(res, 400, 'bad-workspace', `workspace is not an existing directory: ${error.message}`);
          return;
        }
      }
      let port;
      if (body.port !== undefined && body.port !== null && body.port !== '') {
        port = Number(body.port);
        if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
          sendError(res, 400, 'bad-port', 'port must be an integer between 0 and 65535');
          return;
        }
        if (port === 0) port = undefined;
      }
      const entry = normalizeEntry({
        id: randomUUID(),
        label: body.label,
        workspace,
        url,
        port,
      }, entries.length);
      if (entry === undefined) {
        sendError(res, 400, 'bad-entry', 'dashboard entry is invalid');
        return;
      }
      entries = [...entries, entry];
      persist(entries);
      const record = await startEntry(entry);
      if (record.state === 'failed') {
        entries = entries.filter((item) => item.id !== entry.id);
        persist(entries);
        sendError(res, 502, 'dashboard-failed', record.error ?? 'dashboard could not start');
        return;
      }
      sendJson(res, 200, { ok: true, dashboard: describe(entry) });
      return;
    }
    if (body.action === 'remove') {
      const id = typeof body.id === 'string' ? body.id : '';
      const entry = entries.find((item) => item.id === id);
      if (entry === undefined) {
        sendError(res, 404, 'not-found', 'dashboard not found');
        return;
      }
      const record = runtime.get(id);
      runtime.delete(id);
      if (record?.viewer !== null && record?.viewer !== undefined) {
        void Promise.resolve(record.viewer.close()).catch(() => {});
      }
      entries = entries.filter((item) => item.id !== id);
      persist(entries);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 400, 'unknown-action', 'action must be add or remove');
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handleRoute });
    return () => {
      disposed = true;
      try {
        dispose?.();
      } catch {}
    };
  }, `orch-entry: route ${ROUTE}`);

  ctx.effect(() => {
    for (const entry of entries) void startEntry(entry);
    return () => {
      disposed = true;
      for (const record of runtime.values()) {
        if (record.viewer !== null && record.viewer !== undefined) {
          void Promise.resolve(record.viewer.close()).catch(() => {});
        }
      }
      runtime.clear();
    };
  }, 'orch-entry: local dashboards');
}
