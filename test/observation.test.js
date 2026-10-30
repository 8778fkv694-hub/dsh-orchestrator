import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executionObservation, continuationPrompt } from '../src/observation.js';

test('observations distinguish unrecorded handoff from recorded claim without claiming execution', () => {
  const s = { id: 'run', owner: 'session', status: 'waiting-action', active: { operation: 'op' }, events: [{ type: 'action-issued', operation: 'op', at: '2026-10-30T00:00:00Z' }] };
  let o = executionObservation(s, Date.parse('2026-10-30T00:03:00Z'));
  assert.equal(o.handoff, 'unrecorded'); assert.equal(o.workOrderAgeSeconds, 180); assert.equal(o.executionConfirmed, false);
  s.active.claim = { actor: 'worker', at: '2026-10-30T00:02:00Z', source: 'test' };
  o = executionObservation(s); assert.equal(o.handoff, 'recorded'); assert.equal(o.executionConfirmed, false);
  s.status = 'paused'; assert.match(executionObservation(s).nextAction, /外部动作/);
  s.status = 'waiting-human'; assert.equal(executionObservation(s).nextActor, '你本人');
  const prompt = continuationPrompt('/fixture', s); assert.match(prompt, /session/); assert.match(prompt, /operation op/); assert.match(prompt, /不要重发/);
});
