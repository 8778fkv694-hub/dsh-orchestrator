#!/usr/bin/env node
import fs from 'node:fs';
import { Orchestrator, validate, digest } from './core.js';
const [action, workspace, ...args] = process.argv.slice(2);
try {
  if (!action || !workspace) throw new Error('Usage: orch <create|status|next|complete|pause|resume|cancel|recover> <workspace> [run|definition.json] [operation|--confirm]');
  const e = new Orchestrator(workspace), owner = 'local-cli'; let s;
  if (action === 'create') {
    const def = validate(JSON.parse(fs.readFileSync(args[0], 'utf8')));
    if (args[1] !== '--confirm') throw new Error('Read the definition and confirm it yourself, then pass --confirm. An agent must not use this flag as a substitute for human confirmation.');
    s = e.create(def, owner, { answer: 'confirm', definitionHash: digest(def), source: 'trusted-local-cli', at: new Date().toISOString() });
  } else {
    if (!['status', 'next', 'complete', 'pause', 'resume', 'cancel', 'recover'].includes(action)) throw new Error('Unsupported command; human gates are handled by the Harness adapter');
    s = e[action === 'status' ? 'read' : action](args[0], owner, args[1]);
  }
  console.log(JSON.stringify(s, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
