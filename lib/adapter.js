import { DroidRpc } from './rpc.js'

const events = { assistant_text_delta: 'text', tool_call: 'tool-call', tool_result: 'tool-result', tool_progress_update: 'tool-progress', session_token_usage_changed: 'usage', agent_turn_completed: 'completed', error: 'error' }
const textOf = message => typeof message === 'string' ? message : message.text
const settings = options => Object.fromEntries(Object.entries({
  modelId: options.model, reasoningEffort: options.reasoningEffort,
  specModeModelId: options.specModel,
  interactionMode: options.mode === 'spec' ? 'spec' : options.mode === 'mission' ? 'mission' : 'auto',
  autonomyLevel: ['review', 'spec'].includes(options.mode) ? 'off' : options.autonomy ?? 'high',
  missionModelSettings: options.missionModelSettings ?? ((options.workerModel || options.validatorModel) ? { workerModel: options.workerModel, validationWorkerModel: options.validatorModel } : undefined),
}).filter(([, value]) => value !== undefined))

export function createDroidRuntime({ rpcFactory = options => new DroidRpc(options), command = 'droid' } = {}) {
  const sessions = new Map()
  const get = id => { const session = sessions.get(id); if (!session) throw new Error('Unknown Droid session'); return session }
  async function open(options, id) {
    if (id && sessions.has(id)) {
      const existing = sessions.get(id)
      if (!existing.rpc.error) return { id, cwd: existing.options.cwd }
      if (existing.active) throw new Error('Droid session is busy')
      existing.rpc.close(); sessions.delete(id)
    }
    if (options.mode === 'mission' && options.missionConfirmed !== true) throw new Error('Mission requires confirmation from the runtime service')
    const rpc = rpcFactory({ command, cwd: options.cwd })
    try {
      const init = { machineId: 'default', cwd: options.cwd, disableBuiltinSkills: options.disableBuiltinSkills ?? false, ...settings(options), ...(options.disabledToolIds ? { disabledToolIds: options.disabledToolIds } : {}) }
      const result = await rpc.request(id ? 'droid.load_session' : 'droid.initialize_session', id ? { sessionId: id, disableBuiltinSkills: init.disableBuiltinSkills } : init)
      const sessionId = result.sessionId ?? id
      if (sessions.has(sessionId)) throw new Error('Droid session is already connected')
      if (!sessionId) throw new Error('Droid did not return a session ID')
      const state = { rpc, options, id: sessionId, requests: new Map(), usage: null, active: null }
      sessions.set(sessionId, state)
      if (id || options.missionModelSettings || options.workerModel || options.validatorModel) await rpc.request('droid.update_session_settings', settings(options))
      if (options.onlyTools) {
        const listed = await rpc.request('droid.list_tools', {})
        const tools = listed.tools ?? []
        const allowed = new Set(options.onlyTools)
        if (tools.length === 0) throw new Error('Cannot enforce Droid tool allowlist: empty tool catalog')
        const selected = new Set()
        for (const name of allowed) {
          const matches = tools.filter(tool => [tool.id, tool.llmId, tool.name].includes(name))
          if (matches.length !== 1 || !matches[0].id) throw new Error(`Unknown or ambiguous Droid allowlisted tool: ${name}`)
          selected.add(matches[0].id)
        }
        if (tools.some(tool => typeof tool.id !== 'string')) throw new Error('Droid tool catalog is missing stable tool IDs')
        // Tool overrides are a load/initialize contract, not session settings.
        await rpc.request('droid.load_session', { sessionId, disableBuiltinSkills: init.disableBuiltinSkills, disabledToolIds: tools.filter(tool => !selected.has(tool.id)).map(tool => tool.id) })
      }
      return { id: sessionId, cwd: result.cwd ?? options.cwd }
    } catch (error) { for (const [key, state] of sessions) if (state.rpc === rpc) sessions.delete(key); rpc.close(); throw error }
  }
  return {
    id: 'droid',
    capabilities: async () => ({ resume: true, streaming: true, usage: true, permissions: true, fork: true, settings: true, spec: true, missions: true }),
    create: options => open(options),
    resume: (id, options = {}) => open(options, id),
    async *send(id, message, { runId, signal, policy } = {}) {
      const state = get(id)
      if (state.active) throw new Error('Droid session is busy')
      if (state.rpc.error) throw state.rpc.error
      if (signal?.aborted) throw new Error('Run aborted')
      state.active = runId ?? Symbol('run')
      const queue = []
      let wake, done = false, failure
      const enqueue = event => {
        if (queue.length >= 4096) { failure = new Error('Droid event buffer exceeded'); done = true }
        else queue.push(event)
        wake?.(); wake = undefined
      }
      const stop = state.rpc.subscribe(frame => {
        if (frame.transportError) { failure = frame.transportError; done = true; enqueue({ type: 'error', message: failure.message }); return }
        if (frame.method === 'droid.session_notification') {
          const notification = frame.params?.notification
          if (!notification || (frame.params.sessionId && frame.params.sessionId !== id)) return
          const type = events[notification.type] ?? (notification.type.startsWith('mission_') ? 'task' : 'provider')
          if (type === 'usage') state.usage = notification
          if (type === 'task' && notification.workerSessionId) {
            enqueue({ type, task: { id: notification.workerSessionId, state: notification.type.endsWith('_started') ? 'running' : notification.exitCode === 0 ? 'completed' : 'failed' }, raw: notification })
          } else if (type === 'task' && notification.features) {
            for (const feature of notification.features) enqueue({ type, task: { ...feature, state: feature.status }, raw: notification })
          } else enqueue({ type: type === 'task' ? 'provider' : type, text: notification.textDelta, raw: notification })
          if (type === 'error') failure = new Error(notification.message ?? notification.error?.message ?? 'Droid session error')
          if (type === 'completed' || type === 'error') done = true
        } else if (frame.id && frame.method) {
          if (!['droid.request_permission', 'droid.ask_user'].includes(frame.method)) {
            state.rpc.write({ type: 'response', id: frame.id, error: { code: -32601, message: 'Unsupported client request' } }); return
          }
          const specDetails = frame.params?.toolUses?.find(item => item.confirmationType === 'exit_spec_mode' || item.details?.type === 'exit_spec_mode' || item.toolUse?.name === 'ExitSpecMode')?.details
          const specExit = specDetails !== undefined || frame.params?.toolUses?.some(item => item.toolUse?.name === 'ExitSpecMode')
          const options = frame.params?.options ?? []
          if (specExit && state.options.mode === 'spec') {
            const cancel = options.find(option => option.value === 'cancel')
            if (cancel) state.rpc.reply(frame.id, { selectedOption: cancel.value })
            else state.rpc.close()
            enqueue({ type: 'artifact', kind: 'spec', text: specDetails?.plan ?? '', raw: frame.params })
            if (specDetails?.plan) enqueue({ type: 'text', text: specDetails.plan })
            enqueue({ type: 'completed' }); done = true
            return
          }
          const once = options.find(option => option.value === 'proceed_once' || option === 'proceed_once')
          if (frame.method === 'droid.request_permission' && policy === 'allow' && state.options.mode === 'agent' && once) {
            state.rpc.reply(frame.id, { selectedOption: 'proceed_once' }); return
          }
          state.requests.set(frame.id, frame)
          enqueue({ type: frame.method === 'droid.ask_user' ? 'ask-user' : 'permission', requestId: frame.id, options, questions: frame.params?.questions, raw: frame.params })
        }
      })
      const abort = () => { void state.rpc.request('droid.interrupt_session').catch(() => {}); done = true; enqueue({ type: 'cancelled' }) }
      state.stop = () => { done = true; enqueue({ type: 'cancelled' }) }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        void state.rpc.request('droid.add_user_message', { text: textOf(message) }).catch(error => { failure = error; done = true; enqueue({ type: 'error', message: error.message }) })
        while (!done || queue.length) {
          if (queue.length) yield queue.shift()
          else await new Promise(resolve => { wake = resolve })
        }
        if (failure) throw failure
      } finally { if (!done) await state.rpc.request('droid.interrupt_session').catch(() => {}); stop(); signal?.removeEventListener('abort', abort); state.requests.clear(); state.active = null; state.stop = undefined }
    },
    async respond(id, requestId, result) {
      const state = get(id), frame = state.requests.get(requestId)
      if (typeof result === 'string') result = frame?.method === 'droid.request_permission' ? { selectedOption: result } : { answers: [{ index: 0, question: frame?.params?.questions?.[0]?.question ?? '', answer: result }] }
      if (!frame) throw new Error('Droid request is no longer pending')
      if (frame.method === 'droid.request_permission' && !(frame.params.options ?? []).some(option => (option.value ?? option) === result.selectedOption)) throw new Error('Permission option was not offered')
      if (frame.method === 'droid.ask_user' && result.cancelled !== true) {
        const questions = frame.params.questions ?? []
        if (!Array.isArray(result.answers) || result.answers.length !== questions.length || questions.some((question, index) => !result.answers.some(answer => answer.index === index && answer.question === question.question && typeof answer.answer === 'string'))) throw new Error('AskUser answers must preserve every question index and text')
      }
      state.rpc.reply(requestId, result); state.requests.delete(requestId)
    },
    async cancel(id, runId) { const state = get(id); if (state.active && state.active === runId) { await state.rpc.request('droid.interrupt_session'); state.stop?.() } },
    async close(id) { const state = get(id); state.rpc.close(); sessions.delete(id) },
    async getUsage(id) { return get(id).usage },
    async updateSettings(id, options) {
      const state = get(id)
      if (state.active) throw new Error('Cannot update a busy Droid session')
      if (options.onlyTools !== undefined) throw new Error('Tool policy is fixed at creation; create a new session to change it')
      const next = { ...state.options, ...options, mode: state.options.mode }
      const result = await state.rpc.request('droid.update_session_settings', settings(next))
      state.options = next
      return result
    },
    async fork(id, options = {}) {
      const state = get(id)
      if (state.active) throw new Error('Cannot fork a busy Droid session')
      const result = await state.rpc.request('droid.fork_session', {})
      if (!result.newSessionId) throw new Error('Droid fork did not return a session ID')
      state.rpc.close(); sessions.delete(id)
      await open(state.options, id)
      return open({ ...state.options, ...options }, result.newSessionId)
    },
    async models(id) { return get(id).rpc.request('droid.list_models', {}) },
    async catalog({ cwd } = {}) {
      const directory = cwd ?? process.cwd()
      const rpc = rpcFactory({ command, cwd: directory })
      try {
        await rpc.request('droid.initialize_session', { machineId: 'default', cwd: directory, disableBuiltinSkills: true })
        const listed = await rpc.request('droid.list_models', {})
        const seen = new Set()
        const models = []
        for (const model of listed?.models ?? []) {
          if (model?.disabled) continue
          const id = typeof model?.modelId === 'string' ? model.modelId : model?.id
          if (typeof id !== 'string' || id === '' || seen.has(id)) continue
          seen.add(id)
          models.push({ id, name: typeof model.displayName === 'string' ? model.displayName : typeof model.shortDisplayName === 'string' ? model.shortDisplayName : id })
        }
        return { models }
      } finally {
        rpc.close()
      }
    },
    async dispose() { for (const state of sessions.values()) state.rpc.close(); sessions.clear() },
  }
}
