/** DeepSeek Harness Cordis adapter. No private shell/model execution channel. */
import { Orchestrator, validate, digest } from './core.js';
export const name = 'evidence-orchestrator';
export const inject = ['tools', 'userQuestions'];
const str = { type: 'string' };
const schema = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export function apply(ctx, config = {}) {
  if (config.questionTimeoutMs !== undefined && (!Number.isSafeInteger(config.questionTimeoutMs) || config.questionTimeoutMs < 1 || config.questionTimeoutMs > 300000)) throw new Error('invalid questionTimeoutMs');
  let engine, disposed = false;
  const pending = new AbortController();
  const getEngine = () => engine ??= new Orchestrator(config.workspace);
  // The host unregisters scoped tool registrations on disposal. Abort our outstanding human waits too.
  ctx.effect(() => () => { disposed = true; pending.abort(new Error('orchestrator plugin unloaded')); });
  const owner = exec => {
    const id = exec.agent?.session?.id;
    if (typeof id !== 'string' || !id) throw new Error('A live session caller is required');
    return id;
  };
  const live = exec => { if (disposed) throw new Error('plugin unloaded'); exec.signal.throwIfAborted(); owner(exec); };
  async function ask(exec, question, choices, operation) {
    live(exec);
    const signal = AbortSignal.any([exec.signal, pending.signal, AbortSignal.timeout(config.questionTimeoutMs ?? 90000)]);
    const id = `orch-${operation}`;
    const reply = await ctx.userQuestions.ask({ agent: exec.agent, signal, questions: [{ id, question, options: choices.map(label => ({ label, description: label })), multiSelect: false }] });
    live(exec); signal.throwIfAborted();
    const answer = reply.answers?.find(a => a.id === id);
    if (!answer || answer.selected?.length !== 1 || !choices.includes(answer.selected[0]) || answer.custom) throw new Error('No unambiguous human decision; state unchanged');
    return { operation, answer: answer.selected[0], at: new Date().toISOString(), source: 'harness.userQuestions', question, reply: answer };
  }
  const describe = state => {
    const n = state.definition.nodes[state.index];
    return { ...state, currentStep: n ?? null, guidance: state.status === 'waiting-action'
      ? 'Use the host-authorized tools to perform this step. Record this operation ID. Submit only after producing the declared artifacts; repeated status/recover calls do not authorize re-execution.'
      : state.status === 'cancel-requested' ? 'External action may still be running. Stop or inspect it through the host. Human reconciliation is required; this is not confirmed cancellation.'
      : state.status === 'waiting-human' ? 'Call orch_gate to ask the actual person; never invent an answer.' : 'Inspect status before advancing.' };
  };
  function tool(toolName, description, parameters, execute) {
    ctx.tools.register({ name: toolName, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, result) => {
        const labels = { ready: '准备就绪 / Ready', 'waiting-action': '等待执行结果 / Awaiting result', 'waiting-human': '待您决定 / Your decision needed', paused: '已暂停 / Paused', 'cancel-requested': '正在核对取消 / Cancellation unconfirmed', cancelled: '已取消 / Cancelled', done: '交付已核验 / Delivery verified' };
        const summary = result.accepted === false ? '候选意图未被接受 / Candidate not accepted' : `${labels[result.status] ?? result.status}\n目标 / Goal: ${result.definition.intent}\n进度 / Progress: ${result.index}/${result.definition.nodes.length}\n当前步骤 / Step: ${result.currentStep?.id ?? '—'}\n${result.currentStep?.question ?? ''}`;
        return [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(result) }];
      } },
      async execute(args, exec) { live(exec); return execute(args, exec); }
    });
  }
  tool('orch_create', 'Create a pipeline run after restating intent and asking the real person to confirm the exact definition. Does not grant execution permission.', schema({ definition: { type: 'object', additionalProperties: true } }), async (a, x) => {
    const def = validate(a.definition), hash = digest(def);
    const human = await ask(x, `候选意图 / Candidate Intent:\n${def.intent}\n\n管线步骤、验收和关联资料 / Steps, criteria and references:\n${JSON.stringify(def, null, 2)}\n\n这是否准确表达您的意思？确认只纳入本版本，不代替操作权限。`, ['confirm', 'reject'], hash);
    if (human.answer !== 'confirm') return { accepted: false, reason: 'human rejected candidate' };
    return describe(getEngine().create(def, owner(x), { ...human, definitionHash: hash }));
  });
  const runArgs = schema({ run: str });
  for (const [action, explanation] of [
    ['next', 'Advance ready run. Emits a persisted task work order or human gate; checks declared evidence before completion.'],
    ['pause', 'Pause scheduling; does not stop already dispatched external work.'],
    ['resume', 'Resume scheduling from paused state; existing unknown action is not redispatched.'],
    ['cancel', 'Request cancellation. Active external work remains unknown until independently stopped and reconciled.'],
    ['recover', 'Read persisted state and original operation ID without replaying tasks.'],
    ['status', 'Observe persisted progress, decisions and evidence for this session.']
  ]) tool(`orch_${action}`, explanation, runArgs, async (a, x) => describe(getEngine()[action === 'status' ? 'read' : action](a.run, owner(x))));
  tool('orch_complete', 'Submit current operation for independent file verification. Model claims are not evidence. Does not execute the next step.', schema({ run: str, operation: str }), async (a, x) => describe(getEngine().complete(a.run, owner(x), a.operation)));
  tool('orch_gate', 'Ask the real person to decide the pending gate. No answer or rejection never means approval.', runArgs, async (a, x) => {
    const e = getEngine(), s = e.read(a.run, owner(x));
    if (s.status !== 'waiting-human') throw new Error('No pending human gate');
    const human = await ask(x, s.definition.nodes[s.index].question, ['confirm', 'reject'], s.active.operation);
    return describe(e.decide(a.run, owner(x), s.active.operation, human.answer, human));
  });
  tool('orch_reconcile', 'After external inspection, ask the real person whether an unknown action has verified output or has actually stopped. Never auto-retry.', runArgs, async (a, x) => {
    const e = getEngine(), s = e.read(a.run, owner(x));
    if (!['waiting-action', 'cancel-requested'].includes(s.status)) throw new Error('No unknown action to reconcile');
    const human = await ask(x, `请先核对执行端和产物。原操作 ${s.active.operation}：verified表示产物已产生且执行已结束；stopped表示已确认执行停止。没有证据请关闭问题，保持未知。`, ['verified', 'stopped'], s.active.operation);
    return describe(e.reconcile(a.run, owner(x), s.active.operation, human.answer, human));
  });
}
