import test from 'node:test';
import assert from 'node:assert/strict';
import { initialRunState, nextRunState, settleRunState } from '../lib/run.machine.js';
test('droid runtime machine pauses for host input', () => {
    assert.equal(initialRunState(), 'idle');
    assert.equal(nextRunState('idle', 'START'), 'running');
    assert.equal(nextRunState('running', 'WAITING'), 'awaitingInput');
    assert.equal(nextRunState('awaitingInput', 'ANSWER'), 'running');
    assert.equal(nextRunState('running', 'COMPLETE'), 'completed');
    assert.equal(nextRunState('completed', 'START'), 'running');
    assert.equal(nextRunState('running', 'CANCEL'), 'cancelled');
    assert.equal(nextRunState('cancelled', 'CLOSE'), 'closing');
    assert.equal(nextRunState('closing', 'CLOSED'), 'closed');
    assert.equal(settleRunState('awaitingInput', 'FAIL'), 'failed');
    assert.throws(() => nextRunState('closed', 'START'), /illegal droid runtime transition/);
});
