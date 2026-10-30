#!/usr/bin/env node
/**
 * Zero-config quickstart for dsh-orchestrator.
 *
 * Creates a local demo workspace with synthetic runs, outputs and a registered
 * example pipeline, then starts the read-only dashboard and prints its URL.
 * No model, no credentials, no network and no user-profile changes.
 *
 * Usage: npm run quickstart [-- --port 8892] [--open] [--read-only]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Orchestrator, digest } from '../src/core.js';
import { startViewer } from '../src/viewer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoRoot = path.join(root, '.demo-workspace');

function fail(message, hint) {
  console.error(`✗ ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function checkEnv() {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isFinite(major) || major < 22) fail(`需要 Node 22+（当前 ${process.version}）`, '升级 Node 后重试：https://nodejs.org/');
  try {
    fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    fail(`仓库目录不可写：${root}`, '把它复制到可写位置，或修复权限后重试');
  }
}

function parseArgs(argv) {
  const options = { port: 0, open: false, readOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--open') options.open = true;
    else if (arg === '--read-only') options.readOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：npm run quickstart [-- --port 8892] [--open] [--read-only]');
      console.log('  零配置启动本地看板（演示工作区 .demo-workspace，合成数据，不调用模型/凭据）');
      process.exit(0);
    } else if (!arg.startsWith('-')) fail(`未知参数：${arg}`, '运行 npm run quickstart -- --help 查看用法');
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) fail(`端口不合法：${options.port}`);
  return options;
}

function seedWorkspace() {
  fs.mkdirSync(path.join(demoRoot, 'pipelines'), { recursive: true });
  fs.mkdirSync(path.join(demoRoot, 'output'), { recursive: true });
  fs.mkdirSync(path.join(demoRoot, 'demo'), { recursive: true });
  const example = JSON.parse(fs.readFileSync(path.join(root, 'examples/demo-pipeline.json'), 'utf8'));
  const pipelineFile = path.join(demoRoot, 'pipelines/demo-briefing.json');
  fs.writeFileSync(pipelineFile, JSON.stringify(example, null, 2) + '\n');

  const engine = new Orchestrator(demoRoot);
  const owner = 'demo-operator';
  const create = () => engine.create(example, owner, { answer: 'confirm', definitionHash: digest(example), source: 'quickstart-demo' });
  const writeNote = () => fs.writeFileSync(path.join(demoRoot, 'demo/note.md'), 'ready ' + Date.now() + '-' + Math.random().toString(36).slice(2) + '\n');
  const next = state => engine.next(state.id, owner);
  const complete = state => engine.complete(state.id, owner, state.active.operation);

  // done run (write -> human gate -> delivery verified)
  let done = create();
  done = next(done); writeNote(); done = complete(done); done = next(done);
  done = engine.decide(done.id, owner, done.active.operation, 'confirm', { operation: done.active.operation, answer: 'confirm', source: 'quickstart-demo' });
  done = next(done);

  // waiting-human run
  let waiting = create();
  waiting = next(waiting); writeNote(); waiting = complete(waiting); waiting = next(waiting);

  // ready run
  create();

  // cancel-requested run
  let cancelling = create();
  cancelling = next(cancelling);
  cancelling = engine.cancel(cancelling.id, owner);

  // synthetic outputs so the outputs view is not empty
  const output = path.join(demoRoot, 'output');
  const markdown = '# 演示简报\n\n这是一份零配置 quickstart 生成的合成演示输出，不是真实新闻。\n\n<!-- NEWS_REPORT_COMPLETE:1:180 -->\n';
  fs.writeFileSync(path.join(output, 'demo-briefing.md'), markdown);
  fs.writeFileSync(path.join(output, 'demo-briefing.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>演示简报</title><body style="background:#0f1216;color:#e8eaed;font-family:system-ui;padding:40px"><h1>演示简报</h1><p>这是 quickstart 生成的合成演示 HTML，不是真实新闻。</p><p><a style="color:#6ea8fe" href="https://example.com" target="_blank" rel="noopener">示例链接</a></p></body></html>\n');
  fs.writeFileSync(path.join(output, 'demo-briefing.delivery.json'), JSON.stringify({ version: 1, quality: 'full', synthetic: true }, null, 2) + '\n');

  return { done: done.id, waiting: waiting.id, cancelling: cancelling.id };
}

async function openBrowser(url) {
  if (process.platform === 'darwin') execFile('open', [url], () => {});
  else if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

async function main() {
  checkEnv();
  const options = parseArgs(process.argv.slice(2));
  // The demo workspace is disposable and is reset on every quickstart.
  fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.mkdirSync(demoRoot, { recursive: true });
  const seeded = seedWorkspace();
  let viewer;
  try {
    viewer = await startViewer({ workspace: demoRoot, port: options.port, readOnly: options.readOnly });
  } catch (error) {
    if (/EADDRINUSE/.test(String(error && error.message))) fail(`端口 ${options.port} 已被占用`, '换一个端口：npm run quickstart -- --port 0');
    fail(error && error.message ? error.message : String(error), '检查参数后重试；也可用 --read-only 仅查看');
  }
  console.log('');
  console.log('  DSH Orchestrator · 零配置演示');
  console.log('  ─────────────────────────────');
  console.log(`  看板：${viewer.url}`);
  console.log(`  模式：${viewer.readOnly ? '只读' : '只读 + 调度（演示数据）'}`);
  console.log(`  工作区：${demoRoot}（合成演示数据，不调用模型/凭据）`);
  console.log(`  演示运行：done ${seeded.done.slice(0, 8)} · waiting-human ${seeded.waiting.slice(0, 8)} · cancel-requested ${seeded.cancelling.slice(0, 8)}`);
  console.log('');
  console.log('  打开浏览器：把上面的 URL 粘贴到浏览器（或用 --open 自动打开）');
  console.log('  真实使用：orch view <你的项目工作区>');
  console.log('  按 Ctrl+C 停止。');
  if (options.open) {
    await openBrowser(viewer.url);
    console.log('  已请求系统浏览器打开（若未弹出请手动复制 URL）。');
  }
  const stop = async () => {
    await viewer.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

main().catch(error => {
  fail(error && error.message ? error.message : String(error), '运行 npm run quickstart -- --help 查看用法');
});
