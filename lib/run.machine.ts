/** Session/run lifecycle of the Droid JSON-RPC adapter (lib/adapter.js). */
import { createMachine, initialTransition, transition } from 'xstate'

export const droidRuntimeMachine = createMachine({
  id: 'droidRuntimeSession',
  initial: 'idle',
  states: {
    idle: { on: { START: 'running', CLOSE: 'closing' } },
    running: { on: { WAITING: 'awaitingInput', COMPLETE: 'completed', CANCEL: 'cancelled', FAIL: 'failed', CLOSE: 'closing' } },
    awaitingInput: { on: { WAITING: 'awaitingInput', ANSWER: 'running', CANCEL: 'cancelled', FAIL: 'failed', CLOSE: 'closing' } },
    completed: { on: { START: 'running', CLOSE: 'closing' } },
    cancelled: { on: { START: 'running', CLOSE: 'closing' } },
    failed: { on: { START: 'running', CLOSE: 'closing' } },
    closing: { on: { CLOSED: 'closed' } },
    closed: { type: 'final' },
  },
})

export const initialRunState = () => initialTransition(droidRuntimeMachine)[0].value

export function nextRunState(state, event) {
  const eventObject = typeof event === 'string' ? { type: event } : event
  const snapshot = droidRuntimeMachine.resolveState({ value: state })
  if (!snapshot.can(eventObject)) throw new Error(`illegal droid runtime transition: ${state} --${eventObject.type}-->`)
  return transition(droidRuntimeMachine, snapshot, eventObject)[0].value
}

export function settleRunState(state, event) {
  return state === 'running' || state === 'awaitingInput' ? nextRunState(state, event) : state
}
