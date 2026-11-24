import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const windows = process.platform === 'win32'

export async function checkServer(child, signal, label) {
  const closed = once(child, 'close')
  const lines = createInterface({ input: child.stdout })
  const stopReading = () => lines.close()
  signal.addEventListener('abort', stopReading, { once: true })
  const output = []
  let origin
  try {
    for await (const line of lines) {
      signal.throwIfAborted()
      if (line.startsWith('http://127.0.0.1:')) {
        origin = new URL(line).origin
        break
      }
      output.push(line)
    }
    signal.throwIfAborted()
    assert.ok(origin, `${label} exited before readiness:\n${output.join('\n')}`)
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/app.css', 'text/css']]) {
      const response = await fetch(origin + path, { signal: AbortSignal.timeout(5_000) })
      assert.equal(response.status, 200, path)
      assert.ok(response.headers.get('content-type').startsWith(type), path)
      assert.ok((await response.text()).length, path)
    }
  } finally {
    signal.removeEventListener('abort', stopReading)
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (windows) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      else process.kill(-child.pid, 'SIGINT')
    }
    const [code, exitSignal] = await closed
    if (origin && !windows) assert.ok(code === 130 || exitSignal === 'SIGINT', `${label} should exit with the Ctrl+C status`)
  }
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(5_000) }))
  return output.join('\n')
}
