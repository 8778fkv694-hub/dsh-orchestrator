/** Trusted deterministic driver. Executors are application-owned functions, never model-supplied code. */
export async function driveScripts(engine, run, owner, executors, { signal = new AbortController().signal } = {}) {
  let state = engine.read(run, owner);
  if (state.status === 'waiting-action') throw new Error('unknown action cannot be replayed; reconcile it first');
  while (true) {
    signal.throwIfAborted();
    if (state.status === 'ready') state = engine.next(run, owner);
    if (state.status !== 'waiting-action') return state;
    const node = state.definition.nodes[state.index];
    if (node.mode !== 'script') return state;
    // A previously issued action is unknown. Only this driver's newly-issued action may run.
    const execute = Object.hasOwn(executors, node.id) ? executors[node.id] : undefined;
    if (typeof execute !== 'function') throw new Error(`No trusted script executor for ${node.id}`);
    await execute({ node, operation: state.active.operation, signal });
    signal.throwIfAborted();
    state = engine.complete(run, owner, state.active.operation);
  }
}
