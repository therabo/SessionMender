import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { chromium } from 'playwright-core'

const binary = process.env.SESSIONMENDER_TEST_BINARY ?? fileURLToPath(new URL('../../target/debug/agentmender.exe', import.meta.url))
const codexExecutable = process.env.SESSIONMENDER_TEST_CODEX
const uuid = number => '019abcd0-0000-7000-8000-' + String(number).padStart(12, '0')
const date = '2026-11-22T12:30:00.000Z'
const seconds = Date.parse(date) / 1000
const jsonl = rows => rows.map(row => JSON.stringify(row) + '\n').join('')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sessionmender-win-'))
  const codex = join(root, 'codex 日本')
  const claude = join(root, 'claude')
  const workspace = join(root, 'workspace protetto')
  const exports = join(codex, 'exports')
  const namespace = join(claude, 'projects', 'fixture')
  const dirs = [codex, namespace, workspace, exports]
  await Promise.all(dirs.map(dirname => mkdir(dirname, { recursive: true })))
  const env = { ...process.env, CODEX_HOME: codex, CODEX_SQLITE_HOME: codex }
  delete env.ARTIFACT_SESSION_HOST_EXPORT_ROOT
  const bootstrap = spawnSync(codexExecutable, ['delete', uuid(999), '--force'], {
    cwd: codex, env, encoding: 'utf8', timeout: 20000, windowsHide: true,
  })
  assert.equal(bootstrap.status, 1, bootstrap.stderr)
  await writeFile(join(codex, 'config.toml'), `[desktop]\nworkspace-root = ${JSON.stringify(workspace)}\n`)
  await mkdir(join(workspace, 'export', 'empty workspace export'), { recursive: true })
  await symlink(workspace, join(workspace, 'export', 'workspace junction'), 'junction')
  await mkdir(join(workspace, 'exports'))
  await writeFile(join(workspace, 'exports', 'workspace output.txt'), 'output')
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'))
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
  const project = uuid(10)
  db.prepare('INSERT INTO projects (id,name,position,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?)')
    .run(project, 'Fixture project', 0, seconds * 1000, seconds * 1000)
  db.prepare('INSERT INTO project_roots (project_id,position,path) VALUES (?,?,?)').run(project, 0, workspace)
  const paths = new Map()
  for (const [number, name, options] of [
    [1, 'Fixture active', {}],
    [2, 'Fixture descendant', { parent: uuid(1) }],
    [3, 'Fixture archived zstd', { archived: true, compressed: true, project }],
    [4, 'Fixture project active', { project }],
    [5, 'Fixture protected parent', {}],
    [6, 'Fixture protected child', { parent: uuid(5) }],
    [7, 'Fixture browser', {}],
  ]) {
    const id = uuid(number)
    const bucket = options.archived ? join(codex, 'archived_sessions') : join(codex, 'sessions', '2026', '11', '22')
    await mkdir(bucket, { recursive: true })
    const locator = join(bucket, 'rollout-2026-11-22T12-30-00-' + id + '.jsonl')
    const transcript = jsonl([
      { timestamp: date, type: 'session_meta', payload: { id, timestamp: date, cwd: workspace,
        originator: 'codex_cli_rs', cli_version: '0.171.0-alpha.13', source: 'cli', model_provider: 'openai' } },
      { timestamp: date, type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: 'Fixture prompt ' + number }] } },
    ])
    const file = options.compressed ? locator + '.zst' : locator
    await writeFile(file, options.compressed ? zstdCompressSync(Buffer.from(transcript)) : transcript)
    paths.set(id, file)
    db.prepare('INSERT INTO threads(id,rollout_path,created_at,updated_at,source,model_provider,cwd,title,sandbox_policy,approval_mode,archived,project_id,attached_thread_parent_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, locator, seconds, seconds, 'cli', 'openai', workspace, name,
        '{"type":"read-only"}', 'never', Number(!!options.archived), options.project ?? null, options.parent ?? null)
  }
  await writeFile(join(workspace, 'keep.txt'), 'workspace')
  await writeFile(join(codex, 'history.jsonl'), jsonl([{ session_id: uuid(1) }, { session_id: uuid(7) }]))
  await writeFile(join(codex, 'session_index.jsonl'), jsonl([{ id: uuid(1) }, { id: uuid(7) }]))
  await writeFile(join(codex, '.codex-global-state.json'), JSON.stringify({
    'projectless-thread-ids': [uuid(1), uuid(7)], fixture: 'preserve',
  }))
  for (const name of ['backup A', 'backup B', 'backup C']) {
    await mkdir(join(exports, name))
    await writeFile(join(exports, name, 'manifest.json'), JSON.stringify({ type: 'backup' }))
    await writeFile(join(exports, name, 'data.txt'), name)
  }
  await mkdir(join(exports, 'leased'))
  await writeFile(join(exports, 'leased', '.artifact-session-publication-lease.json'), JSON.stringify({
    publicationId: 'fixture', renewedAtMs: Date.now(),
  }))
  await symlink(workspace, join(exports, 'junction'), 'junction')
  const sqlite = join(codex, 'sqlite')
  await mkdir(sqlite)
  const desktopCatalog = join(sqlite, 'codex.db')
  const projection = new DatabaseSync(desktopCatalog)
  projection.exec(`
    CREATE TABLE local_thread_catalog (host_id TEXT, thread_id TEXT, observation_sequence INTEGER, missing_candidate INTEGER, PRIMARY KEY(host_id, thread_id));
    CREATE TABLE local_thread_catalog_scan_entries (host_id TEXT, thread_id TEXT, removed INTEGER, PRIMARY KEY(host_id, thread_id));
    CREATE TABLE local_thread_catalog_hosts (host_id TEXT PRIMARY KEY, host_kind TEXT);
    CREATE TABLE local_thread_catalog_metadata (id INTEGER PRIMARY KEY, catalog_revision INTEGER);
    CREATE TABLE local_thread_catalog_scan_checkpoints (host_id TEXT PRIMARY KEY, checkpoint TEXT);
    CREATE TABLE local_thread_catalog_sync_state (host_id TEXT PRIMARY KEY, observation_sequence INTEGER, last_full_reconciled_at INTEGER);
    INSERT INTO local_thread_catalog_hosts VALUES ('local', 'local'), ('remote', 'remote');
    INSERT INTO local_thread_catalog_metadata VALUES (1, 0);
    INSERT INTO local_thread_catalog_sync_state VALUES ('local', 0, 42), ('remote', 0, 42);
  `)
  const addProjection = projection.prepare('INSERT INTO local_thread_catalog VALUES (?,?,0,0)')
  for (const [host, thread] of [['local', uuid(1)], ['local', uuid(7)], ['remote', uuid(1)]]) {
    addProjection.run(host, thread)
  }
  projection.close()
  await copyFile(desktopCatalog, join(sqlite, 'codex-dev.db'))
  const claudePath = join(namespace, uuid(8) + '.jsonl')
  await writeFile(claudePath, jsonl([{ type: 'user', sessionId: uuid(8), cwd: workspace,
    timestamp: date, version: '2.1.0', entrypoint: 'cli', isSidechain: false,
    message: { role: 'user', content: 'Fixture Claude transcript' } }]))
  await writeFile(join(claude, 'history.jsonl'), jsonl([{ sessionId: uuid(8) }, { sessionId: uuid(9) }]))
  return { root, codex, claude, exports, workspace, env, db, paths, project, claudePath, desktopCatalog }
}

async function serverFor(fixture) {
  const server = spawn(binary, ['--codex-root', fixture.codex, '--claude-root', fixture.claude,
    '--claude-desktop-root', join(fixture.root, 'desktop'), '--codex-executable', codexExecutable,
    '--protect-codex-session', uuid(6), 'ui', '--no-open'], {
    cwd: fixture.root, env: fixture.env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  })
  const stdout = createInterface({ input: server.stdout })
  const [url] = await Promise.race([
    once(stdout, 'line'),
    once(server, 'exit').then(([status]) => { throw Error('SessionMender exit ' + status) }),
  ])
  return { server, url: new URL(url) }
}

async function stop(server) {
  if (server.exitCode === null && server.signalCode === null) {
    const exit = once(server, 'exit')
    server.kill()
    await exit
  }
}

function client(url, authorization) {
  return async (path, body, expected = 200) => {
    const response = await fetch(url.origin + '/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization, origin: url.origin, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    })
    const text = await response.text()
    assert.equal(response.status, expected, path + ' ' + text)
    return text ? JSON.parse(text) : undefined
  }
}

const item = (rows, id) => {
  const row = rows.find(row => row.native_id === id)
  assert.ok(row, 'missing session ' + id)
  return row
}

test('Windows native Codex, Claude and export review and confirmation', { timeout: 180000 }, async () => {
  assert.equal(process.platform, 'win32')
  assert.ok(codexExecutable, 'Set SESSIONMENDER_TEST_CODEX to the native Windows codex.exe')
  const data = await fixture()
  let server
  let browser
  let writer = data.db
  const desktopWriter = new DatabaseSync(data.desktopCatalog)
  try {
    desktopWriter.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    desktopWriter.prepare('UPDATE local_thread_catalog_metadata SET catalog_revision=1 WHERE id=1').run()
    assert.ok(existsSync(data.desktopCatalog + '-wal'))
    const started = await serverFor(data)
    server = started.server
    const { url } = started
    const chromiumPath = process.env.SESSIONMENDER_TEST_CHROMIUM
    assert.ok(chromiumPath, 'Set SESSIONMENDER_TEST_CHROMIUM to a Chromium executable')
    browser = await chromium.launch({ executablePath: chromiumPath })
    const page = await browser.newPage()
    const authorized = page.waitForResponse(response => response.url().endsWith('/api/authorize'))
    await page.goto(url.toString())
    const { authorization } = await (await authorized).json()
    const api = client(url, authorization)

    const state = await api('/codex/sessions?limit=100')
    assert.equal(state.provider.coverage, 'available', JSON.stringify(state.provider))
    const active = item(state.rows, uuid(1))
    const archived = item(state.rows, uuid(3))
    assert.equal(archived.state, 'archived')
    const conversation = await api('/codex/sessions/' + archived.key + '/conversation')
    assert.ok(conversation.messages.some(message => message.text.includes('Fixture prompt 3')))
    writer.close()
    writer = undefined

    const blocked = item(state.rows, uuid(5))
    await api('/codex/sessions/' + blocked.key + '/removal-preview', {}, 409)
    const activePath = '/codex/sessions/' + active.key
    const review = await api(activePath + '/removal-preview', {})
    assert.equal(review.plan.trees[0].descendants[0].id, uuid(2))
    await api(activePath + '/delete', { confirm: true, review: 'wrong-ticket' }, 409)
    const removed = await api(activePath + '/delete', { confirm: true, review: review.review })
    assert.equal(removed.status, 'deleted', JSON.stringify(removed))
    assert.equal(removed.verified_absent, 2)
    assert.equal(removed.requested_absent, true)
    assert.equal(existsSync(data.paths.get(uuid(1))), false)
    assert.equal(existsSync(data.paths.get(uuid(2))), false)
    await api(activePath + '/delete', { confirm: true, review: review.review }, 409)
    assert.equal((await readFile(join(data.codex, 'history.jsonl'), 'utf8')).includes(uuid(1)), false)
    assert.equal((await readFile(join(data.codex, 'session_index.jsonl'), 'utf8')).includes(uuid(7)), true)
    const desktop = JSON.parse(await readFile(join(data.codex, '.codex-global-state.json'), 'utf8'))
    assert.deepEqual(desktop['projectless-thread-ids'], [uuid(7)])
    assert.equal(desktop.fixture, 'preserve')
    const projection = new DatabaseSync(data.desktopCatalog, { readOnly: true })
    try {
      const match = projection.prepare('SELECT host_id FROM local_thread_catalog WHERE thread_id=?').all(uuid(1))
      assert.deepEqual(match.map(row => row.host_id), ['remote'])
      assert.equal(projection.prepare('SELECT removed FROM local_thread_catalog_scan_entries WHERE host_id=? AND thread_id=?').get('local', uuid(1)).removed, 1)
      assert.equal(projection.prepare('SELECT last_full_reconciled_at FROM local_thread_catalog_sync_state WHERE host_id=?').get('local').last_full_reconciled_at, null)
    } finally {
      projection.close()
    }

    const projects = await api('/codex/projects')
    const project = projects.rows.find(row => row.name === 'Fixture project')
    assert.equal(project.removal_available, true, JSON.stringify(project))
    const projectPath = '/codex/projects/' + project.key
    const bulk = await api(projectPath + '/removal-preview', {})
    assert.equal(bulk.plan.trees.length, 2)
    const bulkResult = await api(projectPath + '/delete', { confirm: true, review: bulk.review })
    assert.equal(bulkResult.status, 'deleted', JSON.stringify(bulkResult))
    assert.equal(bulkResult.verified_absent, 2)
    const catalog = new DatabaseSync(join(data.codex, 'state_5.sqlite'), { readOnly: true })
    try {
      assert.ok(catalog.prepare('SELECT 1 FROM projects WHERE id=?').get(data.project))
    } finally {
      catalog.close()
    }
    assert.equal(await readFile(join(data.workspace, 'keep.txt'), 'utf8'), 'workspace')

    const claude = item((await api('/claude/sessions')).rows, uuid(8))
    const claudeApi = '/claude/sessions/' + claude.key
    assert.ok((await api(claudeApi + '/conversation')).messages.length > 0)
    const claudeReview = await api(claudeApi + '/removal-preview', {})
    assert.equal(claudeReview.plan.history_matches, 1)
    const claudeResult = await api(claudeApi + '/delete', { confirm: true, review: claudeReview.review })
    assert.equal(claudeResult.status, 'deleted', JSON.stringify(claudeResult))
    assert.equal(existsSync(data.claudePath), false)
    assert.equal(await readFile(join(data.claude, 'history.jsonl'), 'utf8'), jsonl([{ sessionId: uuid(9) }]))

    const groups = (await api('/storage/exports')).rows
    const workspaceGroups = groups.filter(group => group.root === join(data.workspace, 'export')
      || group.root === join(data.workspace, 'exports'))
    assert.deepEqual(workspaceGroups.map(group => group.name).sort(),
      ['empty workspace export', 'workspace junction', 'workspace output.txt'])
    assert.ok(workspaceGroups.filter(group => group.removal_available)
      .every(group => group.protection === 'user_output' && group.session_id === null))
    assert.equal(workspaceGroups.find(group => group.name === 'workspace junction').removal_available, false)
    const workspacePreview = await api('/storage/exports/preview', { keys: workspaceGroups.map(group => group.key) })
    assert.equal(workspacePreview.removable, 2)
    assert.equal(workspacePreview.protected, 1)
    assert.ok(workspacePreview.receipt)
    const workspaceConfirm = '/storage/exports/operations/' + workspacePreview.receipt + '/confirm'
    await api(workspaceConfirm, { confirm: false }, 400)
    const workspaceRemoval = await api(workspaceConfirm, { confirm: true })
    assert.deepEqual(workspaceRemoval.deleted.map(item => item.name).sort(), ['empty workspace export', 'workspace output.txt'])
    assert.deepEqual(workspaceRemoval.not_deleted.map(item => item.name), ['workspace junction'])
    assert.equal(existsSync(join(data.workspace, 'export', 'empty workspace export')), false)
    assert.equal(existsSync(join(data.workspace, 'exports', 'workspace output.txt')), false)
    assert.equal(existsSync(join(data.workspace, 'export', 'workspace junction')), true)
    assert.equal(groups.find(group => group.name === 'leased').removal_available, false)
    assert.equal(groups.find(group => group.name === 'junction').removal_available, false)
    for (const names of [['backup A'], ['backup B', 'backup C']]) {
      const preview = await api('/storage/exports/preview', {
        keys: names.map(name => groups.find(group => group.name === name).key),
      })
      assert.equal(preview.removable, names.length)
      const done = await api('/storage/exports/operations/' + preview.receipt + '/confirm', { confirm: true })
      assert.equal(done.deleted.length, names.length, JSON.stringify(done))
      for (const name of names) assert.equal(existsSync(join(data.exports, name)), false)
    }
    assert.equal(await readFile(join(data.workspace, 'keep.txt'), 'utf8'), 'workspace')

    const reconcile = (...args) => spawnSync(binary, ['--codex-root', data.codex,
      '--codex-executable', codexExecutable, 'reconcile-desktop', ...args], {
      cwd: data.root, env: data.env, encoding: 'utf8', timeout: 30000, windowsHide: true,
    })
    const localEntry = desktopWriter.prepare("SELECT 1 AS present FROM local_thread_catalog WHERE host_id='local' AND thread_id=?")
    const liveId = uuid(7)
    assert.notEqual(reconcile(liveId).status, 0)
    const stillPresent = reconcile('--confirm', liveId)
    assert.equal(stillPresent.status, 1, stillPresent.stderr)
    assert.match(stillPresent.stderr, /presente/)
    assert.equal(localEntry.get(liveId).present, 1)

    desktopWriter.exec('BEGIN IMMEDIATE')
    await page.getByRole('button', { name: /Fixture browser/ }).click()
    await page.getByRole('button', { name: 'Remove session' }).click()
    await page.getByText('1 session in the removal plan', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Confirm removal' }).click()
    await page.getByText('Partially removed', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('heading', { name: 'Fixture browser', exact: true }).waitFor({ state: 'detached' })
    assert.equal(existsSync(data.paths.get(liveId)), false)
    assert.equal(localEntry.get(liveId).present, 1)
    desktopWriter.exec('ROLLBACK')

    for (const args of [[liveId], ['--confirm', liveId], ['--confirm', liveId]]) {
      const repaired = reconcile(...args)
      assert.equal(repaired.status, args.length === 1 ? 2 : 0, repaired.stderr)
      assert.equal(localEntry.get(liveId)?.present, args.length === 1 ? 1 : undefined)
    }
  } finally {
    writer?.close()
    desktopWriter.close()
    await browser?.close()
    if (server) await stop(server)
    await rm(data.root, { recursive: true, force: true, maxRetries: 3 })
  }
})
