/** Read-only interpretation of persisted events. Never infers execution from a claim. */
export function executionObservation(state, now = Date.now()) {
  const events = state.events ?? [];
  const last = events.at(-1);
  const issued = events.findLast(e => ['action-issued', 'gate'].includes(e.type) && e.operation === state.active?.operation);
  const age = date => { const ms = Date.parse(date); return Number.isFinite(ms) ? Math.max(0, Math.floor((now - ms) / 1000)) : null; };
  const next = {
    ready: ['宿主会话', '发出下一步工作单'],
    'waiting-action': [state.active?.claim ? '已记录的接手方' : '所属宿主会话', state.active?.claim ? '核对执行端并提交本操作的证据；中断后先对账' : '回到所属会话核对是否已有执行，再接手工作单'],
    'waiting-human': ['你本人', '在 Harness 回答当前人工门'],
    paused: ['你或所属宿主会话', '确认后继续调度；外部动作是否停止需另行核对'],
    'cancel-requested': ['你与执行端', '核对外部动作并由人在 Harness 对账'],
    done: ['无需继续', '查看已核验交付'],
    cancelled: ['无需继续', '本运行已结束']
  }[state.status] ?? ['待核对', '读取原始状态'];
  return { ownerSession: state.owner, claim: state.active?.claim ?? null,
    handoff: state.active?.claim ? 'recorded' : state.status === 'waiting-action' ? 'unrecorded' : 'not-applicable',
    issuedAt: issued?.at ?? null, workOrderAgeSeconds: age(issued?.at),
    lastEventAt: last?.at ?? null, lastEventType: last?.type ?? null, secondsSinceEvent: age(last?.at),
    nextActor: next[0], nextAction: next[1], executionConfirmed: false };
}

export function continuationPrompt(workspace, state) {
  const operation = state.active?.operation;
  return `在工作区 ${workspace} 的所属 Harness 会话 ${state.owner} 处理 run ${state.id}${operation ? `，operation ${operation}` : ''}。先用 orch_status 读取最新状态。已有接手记录或任何未知外部效果时，先核对执行端；不要重发、不要换操作 ID。只有确认从未执行的当前工作单才 orch_claim 后执行；工具不可用则报告插件版本差异。人工门由本人回答；暂停需明确继续；终态不再推进。按当前步骤产生证据后再提交。`;
}
