import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const windows = process.platform === 'win32'

async function checkStartup(archive, signal) {
  const child = spawn(process.execPath, [
    process.env.npm_execpath, 'start', '--',
    '--codex-root', archive, '--claude-root', archive, 'ui', '--no-open',
  ], {
    cwd: root, detached: !windows, stdio: ['ignore', 'pipe', 'inherit'],
  })
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
    assert.ok(origin, `npm start exited before readiness:\n${output.join('\n')}`)
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
    if (origin && !windows) assert.ok(code === 130 || exitSignal === 'SIGINT', 'npm start should exit with the Ctrl+C status')
  }
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(5_000) }))
  return output.join('\n')
}

test('npm start serves embedded assets and reuses a prepared frontend', { timeout: 900_000 }, async t => {
  assert.ok(process.env.npm_execpath, 'Run this test with npm run test:startup.')
  const archive = await mkdtemp(join(tmpdir(), 'SessionMender startup '))
  try {
    await checkStartup(archive, t.signal)
    const output = await checkStartup(archive, t.signal)
    assert.match(output, /Frontend dependencies are up to date/)
    assert.match(output, /Frontend build is up to date/)
  } finally {
    await rm(archive, { recursive: true, force: true })
  }
})
