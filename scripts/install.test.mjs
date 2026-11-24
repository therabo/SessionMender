import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import { installedBinary, root, windows } from './process.mjs'
import { checkServer } from './test-server.mjs'

test('global install registers a standalone launcher and npm removes its command', { timeout: 900_000 }, async t => {
  assert.ok(process.env.npm_execpath, 'Run this test with npm run test:install.')
  const directory = await mkdtemp(join(tmpdir(), 'SessionMender global '))
  const prefix = join(directory, 'npm prefix ñ')
  const outside = join(directory, 'outside checkout ñ')
  const runtime = join(directory, 'runtime tools')
  const globalBin = windows ? prefix : join(prefix, 'bin')
  const shim = join(globalBin, windows ? 'session-mender.cmd' : 'session-mender')
  const archive = join(outside, 'archive ñ')
  const sentinel = join(archive, 'sentinel')
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const env = {
    ...process.env,
    [pathKey]: [globalBin, runtime].join(delimiter),
    SESSIONMENDER_TEST_ARCHIVE: archive,
  }
  delete env.npm_execpath
  delete env.npm_node_execpath
  const launchOptions = { cwd: outside, env, windowsHide: true, windowsVerbatimArguments: windows }
  await mkdir(archive, { recursive: true })
  await mkdir(runtime)
  await writeFile(sentinel, 'fixture data')
  if (windows) await copyFile(process.execPath, join(runtime, 'node.exe'))
  else await symlink(process.execPath, join(runtime, 'node'))

  function npm(args, options) {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args, '--prefix', prefix], {
      encoding: 'utf8', timeout: 780_000, windowsHide: true, ...options,
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return result.stdout
  }

  function command(args) {
    if (!windows) return ['session-mender', args]
    // The Windows npm shim is a batch file. Only the fixed test arguments below enter this command.
    return [process.env.ComSpec, ['/d', '/s', '/c', `session-mender ${args.join(' ')}`]]
  }

  let installed = false
  try {
    const output = npm(['install', '-g', '.', '--foreground-scripts'], {
      cwd: root,
      env: { ...process.env, CARGO_TARGET_DIR: join(directory, 'Cargo artifacts ñ') },
    })
    installed = true
    assert.match(output, /Installation complete/)
    assert.doesNotMatch(output, /^http:\/\/127\.0\.0\.1:/m)
    assert.ok((await lstat(installedBinary)).isFile())
    await lstat(shim)

    for (const [flag, status, expected] of [['--version', 0, /agentmender \d/], ['--help', 0, /--codex-root/], ['--unknown-option', 2, /unexpected argument/]]) {
      const [file, argv] = command([flag])
      const result = spawnSync(file, argv, { ...launchOptions, encoding: 'utf8', timeout: 15_000 })
      assert.ifError(result.error)
      assert.equal(result.status, status, result.stdout + result.stderr)
      assert.match(result.stdout + result.stderr, expected)
    }
    const args = windows ? '"%SESSIONMENDER_TEST_ARCHIVE%"' : archive
    const [file, argv] = command(['--codex-root', args, '--claude-root', args, 'ui', '--no-open'])
    const child = spawn(file, argv, {
      ...launchOptions, detached: !windows, stdio: ['ignore', 'pipe', 'inherit'],
    })
    const launch = await checkServer(child, t.signal, 'session-mender')
    assert.equal(launch, '', 'The installed launcher should start the backend directly.')

    npm(['uninstall', '-g', 'session-mender'], { cwd: outside })
    installed = false
    await assert.rejects(lstat(shim), { code: 'ENOENT' })
    assert.equal(await readFile(sentinel, 'utf8'), 'fixture data')
    assert.ok((await lstat(installedBinary)).isFile())
  } finally {
    try {
      if (installed) npm(['uninstall', '-g', 'session-mender'], { cwd: outside })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})
