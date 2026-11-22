import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const binary = process.env.SESSIONMENDER_TEST_BINARY
  ?? fileURLToPath(new URL('../../target/debug/agentmender', import.meta.url))
const chromiumPath = process.env.SESSIONMENDER_TEST_CHROMIUM
  ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined)
const canvas = '.ambient-background canvas'

async function open(t, { noGl = false, invalidModel = false, clock = false } = {}) {
  const archive = await mkdtemp(join(tmpdir(), 'sessionmender-background-'))
  t.after(() => rm(archive, { recursive: true, force: true }))
  const codex = join(archive, 'codex')
  const claude = join(archive, 'claude')
  await Promise.all([mkdir(codex), mkdir(claude)])
  const env = { ...process.env }
  if (invalidModel) {
    env.SESSIONMENDER_CODEX_GLB = join(archive, 'invalid.glb')
    await writeFile(env.SESSIONMENDER_CODEX_GLB, 'invalid model')
    delete env.SESSIONMENDER_CLAWD_GLB
  }

  const server = spawn(binary, ['--codex-root', codex, '--claude-root', claude, 'ui', '--no-open'], {
    env, stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => server.kill())
  const stdout = createInterface({ input: server.stdout })
  const [url] = await Promise.race([
    once(stdout, 'line'),
    once(server, 'exit').then(() => { throw new Error('SessionMender stopped before startup') }),
  ])
  const origin = new URL(url).origin
  const browser = await chromium.launch({ executablePath: chromiumPath })
  t.after(() => browser.close())
  const page = await browser.newPage({ baseURL: origin, viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' })
  page.setDefaultTimeout(10000)
  const assets = []
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    const { pathname } = new URL(request.url())
    if (pathname.endsWith('.glb')) assets.push(pathname)
  })
  await page.route('**/*', route => {
    const target = new URL(route.request().url())
    return target.origin === origin ? route.continue() : route.abort()
  })
  await page.addInitScript(({ noGl, clock }) => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8 })
    const contexts = []
    window.backgroundQA = { attempts: 0, live: 0, frames: 0, matrices: [], framesPerContext: [] }
    if (clock) {
      const frames = new Map()
      let nextId = 0
      let now = 1000
      window.requestAnimationFrame = callback => {
        frames.set(++nextId, callback)
        return nextId
      }
      window.cancelAnimationFrame = id => frames.delete(id)
      window.backgroundQA.advance = count => {
        for (let i = 0; i < count; i++) {
          now += 1000 / 60
          const queued = Array.from(frames.values())
          frames.clear()
          for (const callback of queued) callback(now)
        }
      }
    }
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (type !== 'webgl2') return getContext.call(this, type, ...args)
      window.backgroundQA.attempts++
      if (noGl) return null
      const gl = getContext.call(this, type, ...args)
      if (!gl || contexts.includes(gl)) return gl
      contexts.push(gl)
      const qa = window.backgroundQA
      const index = contexts.length - 1
      qa.framesPerContext.push(0)
      qa.live = Math.max(qa.live, contexts.filter(context => !context.isContextLost()).length)
      qa.loseContext = () => gl.getExtension('WEBGL_lose_context').loseContext()
      const clear = gl.clear.bind(gl)
      gl.clear = mask => {
        qa.frames++
        qa.framesPerContext[index]++
        qa.matrices = []
        clear(mask)
      }
      if (clock) {
        const tracked = new WeakSet()
        const getLocation = gl.getUniformLocation.bind(gl)
        const uploadMatrix = gl.uniformMatrix4fv.bind(gl)
        gl.getUniformLocation = (program, name) => {
          const location = getLocation(program, name)
          if (location && name === 'modelViewMatrix') tracked.add(location)
          return location
        }
        gl.uniformMatrix4fv = (location, transpose, value, ...rest) => {
          if (tracked.has(location)) qa.matrices.push(Array.from(value))
          return uploadMatrix(location, transpose, value, ...rest)
        }
      }
      return gl
    }
  }, { noGl, clock })
  await page.goto(url)
  await page.getByRole('heading', { name: 'Sessions', exact: true }).waitFor()
  return { page, assets, errors }
}

const choose = (page, name) => page.getByRole('button', { name, exact: true }).evaluate(button => button.click())
const active = (page, provider) => page.locator(
  '.ambient-background[data-visible="true"][data-theme="' + provider + '"] canvas',
)
const frames = page => page.evaluate(() => window.backgroundQA.frames)

test('switching pauses, releases and reuses the cached model bytes', async t => {
  const { page, assets, errors } = await open(t)
  await active(page, 'codex').waitFor()
  const background = page.locator('.ambient-background')
  assert.equal(await background.getAttribute('aria-hidden'), 'true')
  assert.equal(await background.evaluate(element => getComputedStyle(element).pointerEvents), 'none')
  const initial = await frames(page)
  await page.waitForFunction(initial => window.backgroundQA.frames > initial, initial)

  await choose(page, 'Claude Code')
  await page.locator('.shell[data-provider="claude"]').waitFor({ state: 'attached' })
  const outgoingFrames = () => page.evaluate(() => window.backgroundQA.framesPerContext[0])
  const paused = await outgoingFrames()
  await active(page, 'claude').waitFor()
  assert.equal(await outgoingFrames(), paused)
  assert.equal(await page.locator(canvas).count(), 1)

  await choose(page, 'Codex')
  await active(page, 'codex').waitFor()
  assert.deepEqual(assets, ['/assets/codex.glb', '/assets/Clawd-Animator.glb'])
  assert.equal(await page.evaluate(() => window.backgroundQA.live), 1)
  assert.deepEqual(errors, [])

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const hidden = await frames(page)
  await page.waitForTimeout(120)
  assert.equal(await frames(page), hidden)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForFunction(hidden => window.backgroundQA.frames > hidden + 1, hidden)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(100)
  const reduced = await frames(page)
  await page.waitForTimeout(120)
  assert.equal(await frames(page), reduced)
  await page.evaluate(() => window.backgroundQA.loseContext())
  await page.locator(canvas).waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Refresh sessions' }).click()
})

test('an invalid or missing model and unavailable WebGL retain the original UI', async t => {
  const invalid = await open(t, { invalidModel: true })
  assert.equal((await invalid.page.request.get('/assets/codex.glb')).status(), 404)
  assert.equal((await invalid.page.request.get('/assets/Clawd-Animator.glb')).status(), 404)
  await choose(invalid.page, 'Claude Code')
  assert.equal(await invalid.page.locator(canvas).count(), 0)
  await invalid.page.getByRole('button', { name: 'Refresh sessions' }).click()

  const noGl = await open(t, { noGl: true })
  await noGl.page.waitForFunction(() => window.backgroundQA.attempts === 1)
  await choose(noGl.page, 'Claude Code')
  await noGl.page.waitForFunction(() => window.backgroundQA.attempts === 2)
  await noGl.page.getByRole('button', { name: 'Refresh sessions' }).click()
  assert.equal(await noGl.page.locator(canvas).count(), 0)
  assert.deepEqual(noGl.errors, [])
})

test('the pointer does not affect the Codex trajectories', async t => {
  const { page } = await open(t, { clock: true })
  await active(page, 'codex').waitFor()
  const sample = () => page.evaluate(() => {
    window.backgroundQA.advance(1)
    return window.backgroundQA.matrices
  })
  const initial = await sample()
  const moved = await page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: 1400, clientY: 865, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1400, clientY: 865 }))
    window.backgroundQA.advance(120)
    return window.backgroundQA.matrices
  })
  assert.ok(initial.length >= 12 && moved.length === initial.length)
  assert.notDeepEqual(moved, initial)

  const baseline = await open(t, { clock: true })
  await active(baseline.page, 'codex').waitFor()
  const withoutPointer = await baseline.page.evaluate(() => {
    window.backgroundQA.advance(121)
    return window.backgroundQA.matrices
  })
  assert.deepEqual(moved, withoutPointer)
})
