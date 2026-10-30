#!/usr/bin/env node
import fs from 'node:fs';
import { Orchestrator, validate, digest } from './core.js';
import { startViewer } from './viewer.js';

const USAGE = 'Usage: orch <create|status|next|complete|pause|resume|cancel|recover|view> <workspace> [run|definition.json] [operation|--confirm]';

function parseViewArgs(rest) {
  const options = { readOnly: rest.includes('--read-only') };
  for (const flag of ['--port', '--host', '--token']) {
    const index = rest.indexOf(flag);
    if (index < 0) continue;
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺少参数值`);
    options[flag === '--port' ? 'port' : flag === '--host' ? 'host' : 'token'] = flag === '--port' ? Number(value) : value;
  }
  const known = new Set(['--read-only', '--port', '--host', '--token']);
  const values = new Set();
  for (const flag of ['--port', '--host', '--token']) {
    const index = rest.indexOf(flag);
    if (index >= 0) values.add(index + 1);
  }
  const unknown = rest.filter((item, index) => !known.has(item) && !values.has(index) && !known.has(rest[index - 1]));
  if (unknown.length) throw new Error(`未知参数：${unknown.join(' ')}`);
  return options;
}

async function main() {
  const [action, workspace, ...args] = process.argv.slice(2);
  if (action === 'view' && (workspace === '--help' || workspace === '-h' || args.includes('--help'))) {
    console.log('用法：orch view <工作区绝对路径> [--port 8787] [--host 127.0.0.1] [--read-only] [--token <令牌>]');
    console.log('本地只读看板 + 调度入口（启动/继续/暂停/取消只发工作单，不执行外部动作）。');
    return;
  }
  if (!action || !workspace) throw new Error(USAGE);
  if (action === 'view') {
    const viewer = await startViewer({ workspace, ...parseViewArgs(args) });
    console.log(`orch 看板：${viewer.url}`);
    console.log(`模式：${viewer.readOnly ? '只读（调度按钮关闭）' : '只读 + 调度（启动/继续/暂停/取消只发工作单，不执行外部动作）'}`);
    console.log('按 Ctrl+C 停止。');
    const stop = async () => {
      await viewer.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
    return;
  }
  const e = new Orchestrator(workspace), owner = 'local-cli'; let s;
  if (action === 'create') {
    const def = validate(JSON.parse(fs.readFileSync(args[0], 'utf8')));
    if (args[1] !== '--confirm') throw new Error('Read the definition and confirm it yourself, then pass --confirm. An agent must not use this flag as a substitute for human confirmation.');
    s = e.create(def, owner, { answer: 'confirm', definitionHash: digest(def), source: 'trusted-local-cli', at: new Date().toISOString() });
  } else {
    if (!['status', 'next', 'complete', 'pause', 'resume', 'cancel', 'recover'].includes(action)) throw new Error('Unsupported command; human gates and viewing are handled elsewhere');
    s = e[action === 'status' ? 'read' : action](args[0], owner, args[1]);
  }
  console.log(JSON.stringify(s, null, 2));
}

main().catch(error => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
