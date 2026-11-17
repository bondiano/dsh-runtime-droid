import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { DroidRpc } from '../lib/rpc.js'
import { createDroidRuntime } from '../lib/adapter.js'

function processFixture() {
  const child = new EventEmitter()
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} })
  return child
}
test('RPC correlates interleaved replies and split UTF8 lines; rejects failures', async () => {
  const child = processFixture()
  const rpc = new DroidRpc({ spawnProcess: () => child, timeoutMs: 500 })
  const sent = []
  child.stdin.on('data', chunk => sent.push(JSON.parse(chunk)))
  const notifications = []
  rpc.subscribe(frame => notifications.push(frame))
  const first = rpc.request('first'), second = rpc.request('second')
  const reply = JSON.stringify({ id: sent[1].id, result: 'ok' }) + '\n'
  child.stdout.write(reply.slice(0, 8)); child.stdout.write(reply.slice(8))
  child.stdout.write(JSON.stringify({ method: 'droid.session_notification', params: {} }) + '\n')
  child.stdout.write(JSON.stringify({ id: sent[0].id, error: { message: 'denied' } }) + '\n')
  assert.equal(await second, 'ok')
  await assert.rejects(first, /denied/)
  assert.equal(notifications.length, 1)
  assert.equal(sent[0].factoryApiVersion, '1.0.0')
  rpc.close()
})
test('protocol corruption rejects pending requests and bounded stderr', async () => {
  const child = processFixture(), rpc = new DroidRpc({ spawnProcess: () => child })
  const request = rpc.request('test')
  child.stderr.write('x'.repeat(12_000))
  child.stdout.write('invalid\n')
  await assert.rejects(request, /Invalid Droid protocol/)
  assert.equal(rpc.stderr.length, 8192)
})
function fakeRpc() {
  const listeners = new Set(), requests = [], replies = []
  return {
    requests, replies, close() {},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    emit(frame) { for (const fn of listeners) fn(frame) },
    reply(id, result) { replies.push({ id, result }) },
    write() {},
    async request(method, params) {
      requests.push({ method, params })
      if (method.endsWith('initialize_session')) return { sessionId: 's1' }
      if (method.endsWith('load_session')) return { sessionId: params.sessionId }
      if (method.endsWith('list_tools')) return { tools: [{ id: 'read-file', llmId: 'Read' }, { id: 'edit-file', llmId: 'Edit' }] }
      if (method.endsWith('add_user_message')) queueMicrotask(() => {
        this.emit({ method: 'droid.session_notification', params: { notification: { type: 'assistant_text_delta', textDelta: 'hello' } } })
        this.emit({ method: 'droid.session_notification', params: { notification: { type: 'agent_turn_completed' } } })
      })
      return {}
    },
  }
}
test('initialize sends settings via RPC and read-only tool allowlist survives load', async () => {
  const rpc = fakeRpc(), adapter = createDroidRuntime({ rpcFactory: () => rpc })
  await adapter.create({ cwd: '/tmp', mode: 'review', model: 'account-model', onlyTools: ['Read'] })
  assert.equal(rpc.requests[0].params.modelId, 'account-model')
  assert.equal(rpc.requests[0].params.autonomyLevel, 'off')
  assert.deepEqual(rpc.requests.at(-1).params.disabledToolIds, ['edit-file'])
  const result = []
  for await (const event of adapter.send('s1', 'review', { runId: 'r1' })) result.push(event)
  assert.equal(result[0].text, 'hello')
  assert.equal(result[1].type, 'completed')
  await adapter.dispose()
})
test('mission cannot start without runtime-service confirmation', async () => {
  let spawns = 0
  const adapter = createDroidRuntime({ rpcFactory() { spawns++; return fakeRpc() } })
  await assert.rejects(adapter.create({ mode: 'mission' }), /confirmation/)
  assert.equal(spawns, 0)
})
test('spec boundary returns plan without approving implementation', async () => {
  const rpc = fakeRpc()
  const original = rpc.request.bind(rpc)
  rpc.request = async (method, params) => {
    if (method.endsWith('add_user_message')) {
      queueMicrotask(() => rpc.emit({ id: 'approval', method: 'droid.request_permission', params: { toolUses: [{ toolUse: { name: 'ExitSpecMode' } }], options: [{ value: 'proceed_once' }, { value: 'cancel' }] } }))
      return {}
    }
    return original(method, params)
  }
  const adapter = createDroidRuntime({ rpcFactory: () => rpc })
  await adapter.create({ mode: 'spec', cwd: '/tmp' })
  const result = []
  for await (const event of adapter.send('s1', 'plan', { runId: 'r', policy: 'allow' })) result.push(event)
  assert.equal(result[0].type, 'artifact')
  assert.equal(result.at(-1).type, 'completed')
  assert.deepEqual(rpc.replies, [{ id: 'approval', result: { selectedOption: 'cancel' } }])
  await adapter.dispose()
})
test('resume is idempotent and cancellation targets the active run', async () => {
  const rpc = fakeRpc(), adapter = createDroidRuntime({ rpcFactory: () => rpc })
  await adapter.create({ cwd: '/tmp' })
  await adapter.resume('s1', { cwd: '/tmp' })
  assert.equal(rpc.requests.length, 1)
  await adapter.cancel('s1', 'other-run')
  assert.equal(rpc.requests.length, 1)
  await adapter.dispose()
})
test('model updates preserve spec read-only autonomy and reject tool policy widening', async () => {
  const rpc = fakeRpc(), adapter = createDroidRuntime({ rpcFactory: () => rpc })
  await adapter.create({ mode: 'spec', cwd: '/tmp' })
  await adapter.updateSettings('s1', { model: 'other' })
  assert.equal(rpc.requests.at(-1).params.interactionMode, 'spec')
  assert.equal(rpc.requests.at(-1).params.autonomyLevel, 'off')
  await assert.rejects(adapter.updateSettings('s1', { onlyTools: ['Edit'] }), /fixed at creation/)
  await adapter.dispose()
})
test('resume reopens a failed cached transport', async () => {
  const processes = []
  const adapter = createDroidRuntime({ rpcFactory() { const rpc = fakeRpc(); processes.push(rpc); return rpc } })
  await adapter.create({ cwd: '/tmp' })
  processes[0].error = new Error('Droid exited')
  await adapter.resume('s1', { cwd: '/tmp' })
  assert.equal(processes.length, 2)
  assert.equal(processes[1].requests[0].method, 'droid.load_session')
  await adapter.dispose()
})

test('catalog lists enabled Droid models from a temporary session and closes the transport', async () => {
  const requests = []
  let closed = 0
  const rpc = {
    close() { closed++ },
    async request(method) {
      requests.push(method)
      if (method === 'droid.initialize_session') return { sessionId: 'catalog-session' }
      if (method === 'droid.list_models') return { models: [
        { modelId: 'auto', displayName: 'Auto Model' },
        { modelId: 'claude-fable-5.2', displayName: 'Fable 5.2' },
        { modelId: 'retired', displayName: 'Retired', disabled: true },
      ] }
      return {}
    },
  }
  const adapter = createDroidRuntime({ rpcFactory: () => rpc })
  assert.deepEqual(await adapter.catalog({ cwd: '/tmp' }), { models: [
    { id: 'auto', name: 'Auto Model' },
    { id: 'claude-fable-5.2', name: 'Fable 5.2' },
  ] })
  assert.deepEqual(requests, ['droid.initialize_session', 'droid.list_models'])
  assert.equal(closed, 1)
})
