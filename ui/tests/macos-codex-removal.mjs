import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const binary = process.env.SESSIONMENDER_TEST_BINARY
  ?? fileURLToPath(new URL('../../target/debug/agentmender', import.meta.url))
const chrome = process.env.SESSIONMENDER_TEST_CHROMIUM
  ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const uuid = number => '019abcd0-0000-7000-8000-' + String(number).padStart(12, '0')
const date = '2026-11-22T12:30:00.000Z'
const seconds = Date.parse(date) / 1000
const parent = id => ({ subagent: { thread_spawn: { parent_thread_id: id, depth: 1 } } })

async function fixture(root, executable) {
  const home = join(root, 'home')
  const codex = join(home, '.codex')
  const active = join(codex, 'sessions', '2026', '11', '22')
  const archived = join(codex, 'archived_sessions')
  const claude = join(home, '.claude')
  const workspace = join(root, 'workspace')
  await Promise.all([active, archived, claude, workspace].map(path => mkdir(path, { recursive: true })))
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: root, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex,
  }
  const bootstrap = spawnSync(executable, ['delete', uuid(999), '--force'], {
    cwd: codex, env, encoding: 'utf8', timeout: 20000,
  })
  assert.equal(bootstrap.status, 1, bootstrap.error?.message ?? bootstrap.stderr)
  const database = join(codex, 'state_5.sqlite')
  const db = new DatabaseSync(database)
  const rows = new Map()
  try {
    // Use a readable, closed database to isolate traversal from live WAL changes.
    db.exec('PRAGMA journal_mode=DELETE')
    const insert = db.prepare(`INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const [number, title, options] of [
      [1, 'Fixture main', {}],
      [2, 'Fixture subagent', { source: parent(uuid(1)) }],
      [3, 'Fixture archived', { archived: true }],
      [4, 'Fixture unindexed child', { source: parent(uuid(1)), archived: true, unindexed: true }],
      [5, 'Fixture parent of protected child', {}],
      [6, 'Fixture protected child', { source: parent(uuid(5)) }],
      [7, 'Fixture protected main', {}],
    ]) {
      const id = uuid(number)
      const source = options.source ?? 'cli'
      const path = join(options.archived ? archived : active, 'rollout-2026-11-22T12-30-00-' + id + '.jsonl')
      const metadata = {
        id, timestamp: date, cwd: workspace, originator: 'codex_cli_rs',
        cli_version: '0.171.0-alpha.13', source, model_provider: 'openai',
      }
      const message = { timestamp: date, type: 'response_item', payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fixture prompt ' + number }],
      } }
      const write = override => writeFile(path, [
        { timestamp: date, type: 'session_meta', payload: { ...metadata, ...override } },
        message,
      ].map(record => JSON.stringify(record) + '\n').join(''))
      await write()
      rows.set(number, { path, write })
      if (!options.unindexed) {
        insert.run(id, path, seconds, seconds, typeof source === 'string' ? source : JSON.stringify(source),
          'openai', workspace, title, '{"type":"read-only"}', 'never', Number(!!options.archived))
      }
    }
  } finally {
    db.close()
  }
  return { codex, active, claude, database, env, rows, workspace }
}

function client(url, authorization) {
  return async (path, body, expected = 200) => {
    const response = await fetch(url.origin + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization, origin: url.origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(75000),
    })
    const result = await response.json()
    assert.equal(response.status, expected, path + ': ' + JSON.stringify(result))
    return result
  }
}

test('macOS reviews and removes a verified Codex tree under HOME', { timeout: 180000 }, async () => {
  assert.equal(process.platform, 'darwin')
  assert.ok(process.env.SESSIONMENDER_TEST_CODEX, 'Set SESSIONMENDER_TEST_CODEX to native Codex 0.171.0-alpha.13')
  const executable = await realpath(process.env.SESSIONMENDER_TEST_CODEX)
  const root = await mkdtemp('/private/tmp/sessionmender-mac-')
  let server
  let browser
  try {
    const { codex, active, claude, database, env, rows, workspace } = await fixture(root, executable)
    server = spawn(binary, ['--codex-root', codex, '--claude-root', claude,
      '--claude-desktop-root', join(root, 'desktop'), '--codex-executable', executable,
      '--protect-codex-session', uuid(6), '--protect-codex-session', uuid(7), 'ui', '--no-open'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'],
    })
    const stdout = createInterface({ input: server.stdout })
    const [line] = await Promise.race([
      once(stdout, 'line'),
      once(server, 'exit').then(([status]) => { throw Error('SessionMender exit ' + status) }),
    ])
    const url = new URL(line)
    browser = await chromium.launch({ executablePath: chrome })
    const page = await browser.newPage({ reducedMotion: 'reduce' })
    page.setDefaultTimeout(15000)
    const authorized = page.waitForResponse(response => response.url().endsWith('/api/authorize'))
    await page.goto(url.toString())
    const { authorization } = await (await authorized).json()
    const api = client(url, authorization)
    const dialog = page.getByRole('dialog', { name: 'Remove this session?', exact: true })

    const inventory = await api('/codex/sessions?limit=100')
    assert.equal(inventory.provider.coverage, 'available')
    const session = number => inventory.rows.find(row => row.native_id === uuid(number))
    const path = number => '/codex/sessions/' + session(number).key
    assert.equal(session(2), undefined)
    assert.equal(session(4), undefined)
    assert.equal(session(3).state, 'archived')
    const transcript = await api(path(3) + '/conversation')
    assert.ok(transcript.messages.some(message => message.text === 'Fixture prompt 3'))
    const archivedReview = await api(path(3) + '/removal-preview', {})
    assert.deepEqual(archivedReview.plan.trees, [{ id: uuid(3), descendants: [] }])
    await api(path(5) + '/removal-preview', {}, 409)
    await api(path(7) + '/removal-preview', {}, 409)
    await api('/codex/sessions/' + '0'.repeat(64) + '/removal-preview', {}, 404)
    assert.ok((await api(path(7))).session.removal_reason)

    const preview = () => api(path(1) + '/removal-preview', {})
    const confirm = (review, expected = 200) => api(path(1) + '/delete', { confirm: true, review }, expected)
    const reviewed = await preview()
    assert.deepEqual(reviewed.plan.trees, [{ id: uuid(1), descendants: [
      { id: uuid(2), parent: uuid(1), archived: false, present: true, depth: 1 },
      { id: uuid(4), parent: uuid(1), archived: true, present: true, depth: 1 },
    ] }])
    await api(path(1) + '/delete', { confirm: false, review: reviewed.review }, 400)
    await confirm('invalid-ticket', 409)

    const unreadable = join(active, 'unreadable')
    await mkdir(unreadable, { mode: 0 })
    try {
      const detail = await api(path(1))
      assert.equal(detail.session.removal_reason, null)
      assert.equal(detail.conversation_preview, true)
      await page.getByRole('button', { name: /Fixture main/ }).click()
      await page.getByText('Fixture prompt 1', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Remove session', exact: true }).click()
      await dialog.getByText(/Grafo o archivio Codex non verificabile/).waitFor()
      assert.equal(await dialog.getByRole('button', { name: 'Confirm removal' }).count(), 0)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await confirm(reviewed.review, 409)
      assert.ok(existsSync(rows.get(1).path))
    } finally {
      await chmod(unreadable, 0o700)
      await rm(unreadable, { recursive: true })
    }

    const linked = join(active, 'linked-fixture')
    await symlink(workspace, linked)
    await preview()
    await rm(linked)
    const linkedRollout = join(active, uuid(1) + '.jsonl')
    await symlink(rows.get(1).path, linkedRollout)
    await api(path(1) + '/removal-preview', {}, 409)
    await rm(linkedRollout)

    const changedReview = await preview()
    await rows.get(4).write({ source: parent(uuid(3)) })
    const changed = await confirm(changedReview.review, 409)
    assert.match(changed.error, /relazioni sono cambiati/)
    await rows.get(4).write()

    const unambiguousReview = await preview()
    await rows.get(4).write({ parent_thread_id: uuid(3) })
    const ambiguous = await api(path(1) + '/removal-preview', {}, 409)
    assert.match(ambiguous.error, /discendenza Codex ambigua/)
    await confirm(unambiguousReview.review, 409)
    await rows.get(4).write()

    const identityReview = await preview()
    await rows.get(1).write({ id: uuid(8) })
    const unknown = await api(path(1) + '/removal-preview', {}, 409)
    assert.match(unknown.error, /identità o relazione/)
    await confirm(identityReview.review, 409)
    await rows.get(1).write()
    for (const { path } of rows.values()) assert.ok(existsSync(path))

    await page.getByRole('button', { name: 'Remove session', exact: true }).click()
    await dialog.getByText('1 selected session · 2 verified descendants', { exact: true }).waitFor()
    const response = page.waitForResponse(result => result.url().endsWith('/api' + path(1) + '/delete'))
    await dialog.getByRole('button', { name: 'Confirm removal' }).click()
    const result = await (await response).json()
    assert.equal(result.status, 'deleted', JSON.stringify(result))
    assert.equal(result.verified_absent, 3)
    assert.equal(result.requested_absent, true)
    await dialog.getByText('Removed', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('heading', { name: 'Fixture main', exact: true }).waitFor({ state: 'detached' })
    await page.getByRole('button', { name: /Fixture protected main/ }).click()
    const protectedButton = page.getByRole('button', { name: 'Remove session', exact: true })
    await protectedButton.waitFor()
    assert.equal(await protectedButton.isDisabled(), true)
    for (const number of [1, 2, 4]) assert.equal(existsSync(rows.get(number).path), false)
    const db = new DatabaseSync(database, { readOnly: true })
    try {
      assert.deepEqual(db.prepare('SELECT id FROM threads ORDER BY id').all().map(row => row.id),
        [uuid(3), uuid(5), uuid(6), uuid(7)])
    } finally {
      db.close()
    }
  } finally {
    await browser?.close()
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      const exit = once(server, 'exit')
      server.kill()
      await exit
    }
    await rm(root, { recursive: true, force: true })
  }
})
