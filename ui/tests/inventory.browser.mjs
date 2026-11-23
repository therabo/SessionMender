import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

let server
let browser
let url

before(async () => {
  server = await preview({ root: fileURLToPath(new URL('../', import.meta.url)), preview: { host: '127.0.0.1', port: 0 } })
  url = `http://127.0.0.1:${server.httpServer.address().port}/#ticket=fixture`
  const executablePath = process.env.SESSIONMENDER_TEST_CHROMIUM
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' })
})

after(async () => {
  await browser?.close()
  await server?.close()
})

const fixtures = { codex: 12, claude: 2 }
const label = { codex: 'Codex', claude: 'Claude Code' }
const descendants = [
  { id: 'fixture-descendant', parent: 'root', archived: true, present: true, depth: 1 },
  { id: 'absent-descendant', parent: 'root', archived: false, present: false, depth: 1 },
]
const exportGroup = {
  key: 'export', name: 'Fixture export', path: '/fixture/export', size: { logical_bytes: 1024, files: 1 },
  modified_at: null, protection: 'user_output', reason: 'Fixture', removal_available: true, complete: true,
}
const exampleSession = (provider, group, index) => ({
  key: `${group}-${index}`, native_id: `${provider}-${group}-${index}`, title: `${provider} session ${group}-${index}`,
  state: 'active', kind: 'main', last_active_at: null, transcript_bytes: 1024, protected: false, removal_reason: null,
})

async function open(t, options, outcome) {
  const page = await browser.newPage(options)
  t.after(() => page.close())
  page.setDefaultTimeout(6000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  const gates = []
  const removed = new Set()
  let exportRemoved = false
  await page.route('**/api/**', async route => {
    const { pathname, searchParams } = new URL(route.request().url())
    const [, , provider, resource, key, action] = pathname.split('/')
    const json = data => route.fulfill({ json: data })
    if (pathname === '/api/authorize') return json({ authorization: 'fixture' })
    if (pathname === '/api/storage/exports') {
      return json({ rows: exportRemoved ? [] : [exportGroup], total: Number(!exportRemoved), complete: true })
    }
    if (pathname === '/api/storage/exports/preview') {
      return json({ groups: [exportGroup], size: exportGroup.size, protected: 0, removable: 1, complete: true, receipt: 'fixture' })
    }
    if (pathname === '/api/storage/exports/operations/fixture/confirm') {
      exportRemoved = true
      return json({ deleted: [{ key: exportGroup.key }], not_deleted: [] })
    }

    const count = fixtures[provider]
    assert.ok(count, pathname)
    const rowsFor = group => Array.from({ length: group === 'unassigned' ? 1 : count }, (_, index) =>
      exampleSession(provider, group, index + 1)).filter(row => !removed.has(row.native_id))
    const unassigned = rowsFor('unassigned')
    const projects = ['first', 'second'].map(group => ({
      key: group, name: `${provider} ${group} project`, provider, roots: [], main_conversations: rowsFor(group).length, removal_available: provider === 'codex',
    }))
    const info = {
      id: provider, coverage: 'available', project_count: projects.length, unassigned_sessions: unassigned.length,
      total: projects.reduce((total, project) => total + project.main_conversations, unassigned.length),
      sessions_observed_only: provider === 'claude', projects_observed_only: provider === 'claude',
      observed_transcript_bytes: provider === 'codex' ? 120020 : null,
    }
    const gateIndex = gates.findIndex(({ match }) => match(pathname, searchParams))
    if (gateIndex >= 0) {
      const [gate] = gates.splice(gateIndex, 1)
      gate.start()
      await gate.released
    }
    if (resource === 'projects' && !key) {
      return json({ provider: info, total: projects.length, rows: projects.slice(0, Number(searchParams.get('limit'))) })
    }
    if ((resource === 'projects' && action === 'sessions') || resource === 'unassigned') {
      const rows = rowsFor(key ?? 'unassigned')
      return json({ provider: info, total: rows.length, rows })
    }
    const session = rowsFor('first').find(row => row.key === key)
    if (resource === 'sessions' && !action && session) {
      return json({ session, conversation_preview: false, claude_cleanup_supported: provider === 'claude' })
    }
    if (action === 'removal-preview') {
      const plan = provider === 'codex' ? { trees: [{ id: session.native_id, descendants }] } : {
        files: [{ root: '/fixture', relative_path: 'session.jsonl', bytes: 1024 }],
        directories: [{ root: '/fixture', relative_path: 'sidecars' }],
        logical_bytes: 1024, history_matches: 2, notes: ['Fixture preview note'],
      }
      return json({ review: 'fixture-review', plan })
    }
    if (action === 'delete') {
      assert.deepEqual(route.request().postDataJSON(), { confirm: true, review: 'fixture-review' })
      if (outcome?.httpError) return route.fulfill({ status: 409, json: { error: outcome.httpError } })
      const result = outcome ?? { status: 'deleted', message: 'Fixture removed', errors: [],
        ...(provider === 'codex' ? { requested_absent: true } : {}) }
      if (result.requested_absent ?? (result.status === 'deleted')) removed.add(session.native_id)
      return json(result)
    }
    assert.fail(`Unexpected fixture request ${pathname}`)
  })
  function hold(match) {
    let start, release
    const started = new Promise(resolve => { start = resolve })
    const released = new Promise(resolve => { release = resolve })
    gates.push({ match, start, released })
    t.after(release)
    return { started, release }
  }
  await page.goto(url)
  await page.getByRole('button', { name: /codex session first-1\b/ }).waitFor()
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(document.getAnimations().filter(animation => ['panel-enter', 'stat-enter'].includes(animation.animationName))
      .map(animation => animation.finished))
  })
  return { page, hold }
}

const providerButton = (page, provider) => page.getByRole('button', { name: label[provider], exact: true })
const geometry = page => page.evaluate(() => ['.sessions-panel', '.inventory-header', '.inventory-body'].map(selector => {
  const node = document.querySelector(selector)
  const { x, y, width, height } = node.getBoundingClientRect()
  return [x, y, width, height, node.clientWidth]
}))
const rows = (page, provider) => page.getByRole('button', { name: new RegExp(`^${provider} session `) })

for (const { width, height, reducedMotion } of [
  { width: 1280, height: 850 },
  { width: 800, height: 720 },
  { width: 390, height: 760 },
  { width: 320, height: 640, reducedMotion: 'reduce' },
]) {
  test(`provider switch keeps the inventory stable at ${width} × ${height}`, { timeout: 20000 }, async t => {
    const { page, hold } = await open(t, { viewport: { width, height }, reducedMotion })
    const baseline = await geometry(page)
    const projectList = (provider, path, params) => path === `/api/${provider}/projects` && params.get('limit') === '12'
    const projects = hold((path, params) => projectList('claude', path, params))
    const firstGroup = hold(path => path === '/api/claude/projects/first/sessions')
    const unassigned = hold(path => path === '/api/claude/unassigned')
    await providerButton(page, 'claude').click()
    await projects.started
    assert.deepEqual(await geometry(page), baseline)
    assert.equal(await page.locator('.sessions-panel').evaluate(node => getComputedStyle(node).animationName), 'none')
    assert.equal(await rows(page, 'codex').count(), 0)
    await page.getByText('Loading projects…', { exact: true }).waitFor()

    projects.release()
    await Promise.all([firstGroup.started, unassigned.started])
    assert.deepEqual(await geometry(page), baseline)
    assert.equal(await page.getByRole('button', { name: /claude second project/ }).count(), 0)
    firstGroup.release()
    unassigned.release()
    await rows(page, 'claude').last().waitFor()
    assert.equal(await rows(page, 'claude').count(), 5)
    assert.deepEqual(await geometry(page), baseline)
    await page.getByText('Unavailable', { exact: true }).and(page.locator('.stat-card strong')).waitFor()
    assert.ok(await page.locator('.stat-card strong').evaluateAll(values =>
      values.every(value => value.scrollWidth === value.clientWidth)))

    const interrupted = hold((path, params) => projectList('codex', path, params))
    await providerButton(page, 'codex').click()
    await interrupted.started
    assert.deepEqual(await geometry(page), baseline)
    for (const provider of ['claude', 'codex', 'claude', 'codex']) {
      await providerButton(page, provider).evaluate(button => button.click())
      assert.deepEqual(await geometry(page), baseline)
    }
    await rows(page, 'codex').last().waitFor()
    interrupted.release()
    assert.equal(await rows(page, 'codex').count(), 25)
    assert.equal(await rows(page, 'claude').count(), 0)
    assert.deepEqual(await geometry(page), baseline)

    const project = page.getByRole('button', { name: /^codex first project/ })
    assert.equal(await project.getAttribute('aria-expanded'), 'true')
    await project.click()
    assert.equal(await project.getAttribute('aria-expanded'), 'false')
    await project.click()
    await rows(page, 'codex').first().click()
    await page.getByRole('dialog', { name: 'Session details' }).getByRole('heading', { name: 'codex session first-1' }).waitFor()
    await page.getByRole('button', { name: 'Close preview' }).click()
    await page.locator('dialog.preview-surface').waitFor({ state: 'detached' })
  })
}

async function reviewSession(page, provider) {
  await page.getByRole('button', { name: new RegExp(`^${provider} session first-1\\b`) }).click()
  await page.getByRole('button', { name: 'Remove session', exact: true }).click()
  const review = page.getByRole('dialog', { name: 'Remove this session?', exact: true })
  await review.getByRole('button', { name: 'Confirm removal' }).waitFor()
  return review
}

async function complete(page, review) {
  await review.getByRole('button', { name: 'Confirm removal' }).click()
  const dialog = page.getByRole('dialog', { name: 'Deletion completed', exact: true })
  const content = dialog.locator('.confirmation-completed')
  const appearance = await content.evaluate(node => {
    const icon = node.querySelector('.confirmation-icon')
    const { width, height } = node.getBoundingClientRect()
    const { gap, padding } = getComputedStyle(node)
    const { color, animationName, animationDuration } = getComputedStyle(icon)
    return { width, height, gap, padding, color, animationName, animationDuration, check: !!icon.querySelector('svg.lucide-check') }
  })
  assert.equal(appearance.check, true)
  assert.equal(appearance.animationName, 'confirmation-complete')
  assert.equal(await dialog.getByRole('button').count(), 0)
  await dialog.waitFor({ state: 'detached', timeout: 2500 })
  return appearance
}

test('Codex and Claude share the export completion and refresh their inventories', { timeout: 20000 }, async t => {
  const { page } = await open(t, { viewport: { width: 1280, height: 850 } })
  await page.getByRole('button', { name: 'Exports', exact: true }).click()
  await page.getByRole('checkbox', { name: 'Select Fixture export' }).check()
  await page.getByRole('button', { name: 'Remove selected' }).click()
  const exportAppearance = await complete(page, page.getByRole('dialog', { name: 'Remove selected export?' }))
  await page.getByRole('heading', { name: 'No export groups observed' }).waitFor()
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()

  for (const provider of Object.keys(fixtures)) {
    await providerButton(page, provider).click()
    const review = await reviewSession(page, provider)
    if (provider === 'codex') {
      await review.getByText('2 sessions in the removal plan', { exact: true }).waitFor()
      assert.equal(await review.locator('details').count(), 0)
      assert.equal(await review.getByText(descendants[0].id).count(), 0)
    } else {
      await review.getByText('Files and folders', { exact: true }).click()
      await review.getByText('session.jsonl', { exact: true }).waitFor()
      await review.getByText('sidecars/', { exact: true }).waitFor()
      await review.getByText('2 matching history entries', { exact: true }).waitFor()
    }
    assert.deepEqual(await complete(page, review), exportAppearance)
    await page.locator('dialog.preview-surface').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: new RegExp(`^${provider} session first-1\\b`) }).waitFor({ state: 'detached' })
  }
})

for (const scenario of [
  { provider: 'codex', outcome: { status: 'partial', requested_absent: true, message: 'Codex target removed', errors: ['Descendant cleanup failed'] }, tone: 'warning', message: 'Descendant cleanup failed' },
  { provider: 'codex', outcome: { status: 'deleted', requested_absent: false, message: 'Codex target still present', errors: [] }, tone: 'warning', message: 'Codex target still present' },
  { provider: 'codex', outcome: { status: 'failed', requested_absent: false, message: 'Codex removal failed', errors: [] }, tone: 'error', message: 'Codex removal failed' },
  { provider: 'claude', outcome: { httpError: 'Claude review expired' }, tone: 'error', message: 'Claude review expired' },
]) {
  test(`keeps ${scenario.message} visible until dismissed`, { timeout: 12000 }, async t => {
    const { page } = await open(t, { reducedMotion: 'reduce' }, scenario.outcome)
    await providerButton(page, scenario.provider).click()
    const review = await reviewSession(page, scenario.provider)
    await page.clock.install()
    await review.getByRole('button', { name: 'Confirm removal' }).click()
    await review.locator(`.notice.${scenario.tone}`).getByText(scenario.message, { exact: true }).waitFor()
    await page.clock.runFor(1300)
    assert.equal(await page.getByRole('dialog', { name: 'Deletion completed' }).count(), 0)
    await review.getByRole('button', { name: 'Close', exact: true }).click()
    await review.waitFor({ state: 'detached' })
    const detail = page.locator('dialog.preview-surface')
    await detail.waitFor({ state: scenario.outcome.requested_absent ? 'detached' : 'visible' })
  })
}
