import { createDroidRuntime } from './lib/adapter.js'
export { createDroidRuntime } from './lib/adapter.js'
export function apply(ctx, config = {}) {
  ctx.inject(['agentRuntime'], scoped => {
    const adapter = createDroidRuntime(config)
    scoped.effect(() => scoped.get('agentRuntime').register(adapter))
    scoped.on('dispose', () => adapter.dispose())
  })
}
