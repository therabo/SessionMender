import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { checkServer } from './test-server.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const windows = process.platform === 'win32'

function checkStartup(archive, signal) {
  const child = spawn(process.execPath, [
    process.env.npm_execpath, 'start', '--',
    '--codex-root', archive, '--claude-root', archive, 'ui', '--no-open',
  ], {
    cwd: root, detached: !windows, stdio: ['ignore', 'pipe', 'inherit'],
  })
  return checkServer(child, signal, 'npm start')
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
