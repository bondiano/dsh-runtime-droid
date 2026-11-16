import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/** NDJSON transport. stdout is protocol-only; stderr is bounded diagnostics. */
export class DroidRpc {
  constructor({ command = 'droid', spawnProcess = spawn, cwd, timeoutMs = 30_000, maxBytes = 4_194_304 } = {}) {
    this.pending = new Map()
    this.listeners = new Set()
    this.timeoutMs = timeoutMs
    this.maxBytes = maxBytes
    this.stderr = ''
    this.buffer = ''
    this.process = spawnProcess(command, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.process.stdout.setEncoding('utf8')
    this.process.stdout.on('data', chunk => {
      this.buffer += chunk
      if (Buffer.byteLength(this.buffer) > maxBytes) return this.fail(new Error('Droid protocol buffer limit exceeded'))
      let end
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim()
        this.buffer = this.buffer.slice(end + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) } catch (error) { this.fail(new Error(`Invalid Droid protocol: ${error.message}`)); break }
      }
    })
    this.process.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8192) })
    this.process.on('error', error => this.fail(error))
    this.process.on('exit', (code, signal) => this.fail(new Error(`Droid exited (${code ?? signal})`)))
    this.process.stdin.on('error', error => this.fail(error))
  }
  receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'Droid RPC error'))
      else pending.resolve(message.result)
    } else for (const listener of this.listeners) listener(message)
  }
  write(message) {
    if (this.error) throw this.error
    const line = JSON.stringify({ jsonrpc: '2.0', factoryApiVersion: '1.0.0', ...message }) + '\n'
    if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Droid request too large')
    this.process.stdin.write(line)
  }
  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => this.fail(new Error(`Droid request timed out: ${method}`)), this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ type: 'request', id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  reply(id, result) { this.write({ type: 'response', id, result }) }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  fail(error) {
    if (this.error) return
    this.error = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const listener of this.listeners) listener({ transportError: error })
    this.process.kill()
  }
  close() { this.fail(new Error('Droid connection closed')); this.listeners.clear() }
}
