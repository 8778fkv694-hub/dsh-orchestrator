/** Integration probe for an installed Harness runtime. Fixture answers are NOT human E2E acceptance. */
const { createRequire } = require('node:module');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
(async () => {
  if (!process.argv[2]) throw new Error('Pass the installed app.asar/dsh/package.json; run using Electron in Node mode');
  const requireHarness = createRequire(path.resolve(process.argv[2]));
  const { Context } = requireHarness('@deepseek-ai/cordis');
  const { SystemPrompt } = requireHarness('@deepseek-ai/dsh-system-prompt');
  const { ToolRuntime } = requireHarness('@deepseek-ai/dsh-tools');
  const { UserQuestionService } = requireHarness('@deepseek-ai/dsh-user-questions');
  const { AgentRegistry } = requireHarness('@deepseek-ai/dsh-agent');
  const plugin = await import('../src/plugin.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-harness-'));
  const ctx = new Context(), fibers = [];
  try {
    for (const service of [SystemPrompt, ToolRuntime, AgentRegistry, UserQuestionService]) { const fiber = ctx.plugin(service, {}); await fiber; fibers.push(fiber); }
    const agent = { id: 'orch-integration-fixture', session: { id: 'orch-integration-fixture' }, ctx };
    const detach = ctx.agents.enter(agent); // real registry, explicitly synthetic agent fixture
    const answerer = ctx.on('user-questions/request', async (request) => ({ answers: request.questions.map(q => ({ id: q.id, selected: ['confirm'] })) }));
    const fiber = ctx.plugin(plugin, { workspace: root }); await fiber; fibers.push(fiber);
    const names = ctx.tools.schemas(agent).map(t => t.name).filter(n => n.startsWith('orch_'));
    assert.equal(names.length, 10);
    let serial = 0;
    async function call(name, args) {
      const result = await ctx.tools.execute({ callId: `fixture-${++serial}`, name, arguments: args, agent, signal: new AbortController().signal });
      if (result.isError) throw new Error(JSON.stringify(result));
      return JSON.parse(result.content.filter(b => b.type === 'text').at(-1).text);
    }
    const definition = JSON.parse(fs.readFileSync(path.join(__dirname, '../examples/pipeline.json'), 'utf8'));
    let s = await call('orch_create', { definition }); s = await call('orch_next', { run: s.id });
    assert.equal(s.status, 'waiting-action'); const op = s.active.operation;
    fs.writeFileSync(path.join(root, 'note.md'), 'project-ready');
    s = await call('orch_complete', { run: s.id, operation: op }); s = await call('orch_next', { run: s.id });
    assert.equal(s.status, 'waiting-human'); s = await call('orch_gate', { run: s.id }); s = await call('orch_next', { run: s.id });
    assert.equal(s.status, 'done');
    await fiber.dispose(); fibers.pop(); assert.equal(ctx.tools.schemas(agent).filter(t => t.name.startsWith('orch_')).length, 0);
    answerer(); detach();
    console.log(JSON.stringify({ status: 'PASS', layer: 'installed-harness-runtime-with-fixture-agent-and-answers', tools: names.length, calls: serial, hostVersion: requireHarness('@deepseek-ai/dsh-tools/package.json').version, modelCalls: 0, humanE2E: 'NOT_RUN', unload: 'tools-unregistered' }));
  } finally { for (const f of fibers.reverse()) await f.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
