/** Read-only setup inspection. Does not initialize a run or inspect credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { loadRuns, loadPipelines, listOutputs } from './viewer.js';

export function inspectWorkspace(workspace) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  add('node', Number(process.versions.node.split('.')[0]) >= 22 ? 'pass' : 'fail', `Node ${process.versions.node}`);
  const root = path.resolve(workspace);
  try {
    if (!fs.statSync(root).isDirectory()) throw new Error('不是目录');
    fs.accessSync(root, fs.constants.R_OK);
    add('workspace', 'pass', root);
  } catch { add('workspace', 'fail', '工作区不可读或不是目录'); return { ok: false, workspace: root, checks }; }
  const runs = loadRuns(root), pipelines = loadPipelines(root), outputs = listOutputs(root);
  add('pipelines', pipelines.warnings.length ? 'warn' : pipelines.pipelines.length ? 'pass' : 'warn', `${pipelines.pipelines.length} 条有效登记管线；${pipelines.warnings.length} 项警告`);
  add('runs', runs.warnings.length ? 'warn' : 'pass', `${runs.runs.length} 次运行；${runs.warnings.length} 项警告`);
  add('outputs', outputs.warnings.length ? 'warn' : 'pass', `${outputs.files.length} 个输出物；${outputs.warnings.length} 项警告`);
  const skill = path.join(root, '.agents/skills/dsh-orchestrator/SKILL.md');
  let hasSkill = false;
  try { const st = fs.lstatSync(skill); hasSkill = st.isFile() && !st.isSymbolicLink(); } catch {}
  add('skill', hasSkill ? 'pass' : 'warn', hasSkill ? '工作区包含 DSH skill；自动发现需在宿主确认' : '工作区未找到 DSH skill，可从仓库 skills/dsh-orchestrator 复制');
  add('harness', 'unknown', '本地文件不能证明插件已加载或会话工作区匹配；请在 Harness 核对 orch_status / orch_claim 等工具与项目路径');
  return { ok: checks.every(c => c.status !== 'fail'), workspace: root, checks };
}
