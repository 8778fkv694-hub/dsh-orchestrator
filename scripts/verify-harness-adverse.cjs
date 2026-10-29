/** Actual installed Harness services, synthetic question-provider fixture; not a GUI acceptance test. */
const { createRequire } = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  if (!process.argv[2]) throw new Error('Pass app.asar/dsh/package.json');
  const req = createRequire(path.resolve(process.argv[2]));
  const { Context } = req('@deepseek-ai/cordis');
  const { SystemPrompt } = req('@deepseek-ai/dsh-system-prompt');
  const { ToolRuntime } = req('@deepseek-ai/dsh-tools');
  const { UserQuestionService } = req('@deepseek-ai/dsh-user-questions');
  const { AgentRegistry } = req('@deepseek-ai/dsh-agent');
  const plugin = await import('../src/plugin.js'); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-adverse-'));
  const ctx = new Context(), fibers = [];
  try {
    for (const service of [SystemPrompt, ToolRuntime, AgentRegistry, UserQuestionService]) { const f = ctx.plugin(service, {}); await f; fibers.push(f); }
    const agent = { id: 'adverse-fixture', session: { id: 'adverse-fixture' }, ctx }; const detach = ctx.agents.enter(agent);
    let answer = 'confirm';
    const removeAnswerer = ctx.on('user-questions/request', async request => ({ answers: request.questions.map(q => ({ id: q.id, selected: answer === 'none' ? [] : [answer] })) }));
    const f = ctx.plugin(plugin, { workspace: root }); await f; fibers.push(f); let serial = 0;
    async function call(name, args, expectedError = false) {
      const result = await ctx.tools.execute({ callId: `adverse-${++serial}`, name, arguments: args, agent, signal: new AbortController().signal });
      assert.equal(!!result.isError, expectedError, JSON.stringify(result));
      return expectedError ? result : JSON.parse(result.content.filter(x => x.type === 'text').at(-1).text);
    }
    const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/pipeline.json'), 'utf8'));
    answer = 'reject'; assert.equal((await call('orch_create', { definition })).accepted, false);
    answer = 'none'; await call('orch_create', { definition }, true);
    assert.equal(fs.existsSync(path.join(root, '.orchestrator')), false);
    answer = 'confirm'; let s = await call('orch_create', { definition }); s = await call('orch_next', { run: s.id });
    const operation = s.active.operation;
    await call('orch_complete', { run: s.id, operation }, true); // Missing artifact is not acceptance.
    s = await call('orch_cancel', { run: s.id }); assert.equal(s.status, 'cancel-requested');
    await call('orch_next', { run: s.id }, true);
    answer = 'none'; await call('orch_reconcile', { run: s.id }, true);
    s = await call('orch_status', { run: s.id }); assert.equal(s.status, 'cancel-requested'); assert.equal(s.active.operation, operation);
    answer = 'stopped'; s = await call('orch_reconcile', { run: s.id }); assert.equal(s.status, 'cancelled');
    answer = 'confirm'; s = await call('orch_create', { definition }); s = await call('orch_next', { run: s.id });
    fs.writeFileSync(path.join(root, 'note.md'), 'project-ready');
    s = await call('orch_cancel', { run: s.id }); assert.equal(s.status, 'cancel-requested');
    answer = 'verified'; s = await call('orch_reconcile', { run: s.id }); assert.equal(s.status, 'cancelled');
    await call('orch_next', { run: s.id }, true);
    await f.dispose(); fibers.pop(); assert.equal(ctx.tools.schemas(agent).filter(t => t.name.startsWith('orch_')).length, 0);
    removeAnswerer(); detach();
    console.log(JSON.stringify({ status: 'PASS', layer: 'installed-harness-runtime-with-synthetic-answers', checks: ['rejected-intent', 'no-answer', 'missing-delivery', 'cancel-request-unknown', 'no-advance', 'no-answer-reconciliation', 'confirmed-stopped', 'cancel-then-verified-stays-cancelled', 'unregister'], calls: serial, hostVersion: req('@deepseek-ai/dsh-tools/package.json').version, modelCalls: 0, actualGUIAdversePaths: 'NOT_RUN' }));
  } finally { for (const f of fibers.reverse()) await f.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
