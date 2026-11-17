import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** Result frame body; every Droid call answers with a JSON object. */
export interface DroidResult {
  sessionId?: string
  newSessionId?: string
  cwd?: string
  tools?: { id?: string; llmId?: string; name?: string }[]
  models?: { id?: string; modelId?: string; disabled?: boolean; displayName?: string; shortDisplayName?: string }[]
  [key: string]: unknown
}

/** One NDJSON protocol frame on either direction of the Droid channel. */
export interface RpcMessage {
  id?: string
  method?: string
  type?: string
  params?: unknown
  result?: DroidResult
  error?: { code?: number; message?: string }
  transportError?: Error
  [key: string]: unknown
}

/** One in-flight request waiting for its response frame. */
interface PendingRequest {
  resolve(value: DroidResult): void
  reject(reason: unknown): void
  timer: NodeJS.Timeout
}

/** Construction options; `spawnProcess` is injectable for tests. */
export interface DroidRpcOptions {
  command?: string
  spawnProcess?: typeof spawn
  cwd?: string
  timeoutMs?: number
  maxBytes?: number
}

/** NDJSON transport. stdout is protocol-only; stderr is bounded diagnostics. */
export class DroidRpc {
  pending: Map<string, PendingRequest>
  listeners: Set<(message: RpcMessage) => void>
  timeoutMs: number
  maxBytes: number
  stderr: string
  buffer: string
  error?: Error
  process: ChildProcessWithoutNullStreams

  constructor({ command = 'droid', spawnProcess = spawn, cwd, timeoutMs = 30_000, maxBytes = 4_194_304 }: DroidRpcOptions = {}) {
    this.pending = new Map()
    this.listeners = new Set()
    this.timeoutMs = timeoutMs
    this.maxBytes = maxBytes
    this.stderr = ''
    this.buffer = ''
    // The stdio triple below guarantees all three streams exist.
    this.process = spawnProcess(command, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false }) as ChildProcessWithoutNullStreams
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', (chunk: string) => {
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer) > maxBytes) return this.fail(new Error('Droid protocol buffer limit exceeded'))
      let end
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) } catch (error) { this.fail(new Error(`Invalid Droid protocol: ${error instanceof Error ? error.message : String(error)}`)); break }
      }
    })
    this.process.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8192) })
    this.process.on('error', error => this.fail(error))
    this.process.on('exit', (code, signal) => this.fail(new Error(`Droid exited (${code ?? signal})`)))
    this.process.stdin.on('error', error => this.fail(error))
  }

  receive(message: RpcMessage) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Droid RPC error'))
      else pending.resolve(message.result ?? {})
    } else for (const listener of this.listeners) listener(message)
  }

  write(message: RpcMessage) {
    if (this.error) throw this.error
    const line = JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', ...message }) + '\n'
    if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Droid request too large')
    this.process.stdin.write(line)
  }

  request(method: string, params: unknown = {}): Promise<DroidResult> {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => this.fail(new Error(`Droid request timed out: ${method}`)), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ type: 'request', id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  reply(id: string, result: DroidResult) { this.write({ type: 'response', id, result }) }

  subscribe(listener: (message: RpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  fail(error: Error) {
    if (this.error) return
    this.error = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const listener of this.listeners) listener({ transportError: error })
    this.process.kill()
  }

  close() { this.fail(new Error('Droid connection closed')); this.listeners.clear() }
}
