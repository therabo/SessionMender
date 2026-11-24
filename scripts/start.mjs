import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { constants } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ui = join(root, 'ui')
const modules = join(ui, 'node_modules')
const dist = join(ui, 'dist')
const installStamp = '.sessionmender-install.json'
const buildStamp = '.sessionmender-build.json'
const requiredAssets = ['index.html', 'app.js', 'app.css']
const windows = process.platform === 'win32'
const cargo = windows ? 'cargo.exe' : 'cargo'
const prefix = '[SessionMender]'
let interrupted
let stopChild

for (const signal of ['SIGINT', 'SIGTERM', ...(windows ? ['SIGBREAK'] : [])]) {
  process.on(signal, () => {
    if (interrupted) return
    interrupted = signal
    stopChild?.(signal)
  })
}

function checkInterrupted() {
  if (interrupted) throw new Error('Startup interrupted.')
}

function npmCli() {
  // npm supplies its JS entry point even when invoked through npm.cmd.
  if (process.env.npm_execpath) return process.env.npm_execpath
  const locations = [dirname(process.execPath), ...(process.env.PATH?.split(delimiter) ?? [])]
  for (const location of locations.filter(Boolean)) {
    const candidates = [
      ...(windows ? [] : [join(location, 'npm')]),
      join(location, 'node_modules/npm/bin/npm-cli.js'),
      join(location, '../lib/node_modules/npm/bin/npm-cli.js'),
    ]
    for (const candidate of candidates) {
      try {
        const entry = realpathSync(candidate)
        if (entry.endsWith('npm-cli.js')) return entry
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      }
    }
  }
  throw new Error('npm is required. Install Node.js with npm and run npm start from the repository root.')
}

function toolVersion(executable, args, name) {
  const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${name} is required. Install it and make sure it is on PATH.`)
  }
  if (result.error || result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr)
    throw Object.assign(new Error(`Could not check ${name}: ${result.error?.message ?? `exit code ${result.status}`}`), {
      exitCode: result.status || 1,
    })
  }
  return result.stdout
}

function run(executable, args, { label, fingerprint, onReady } = {}) {
  checkInterrupted()
  return new Promise((done, fail) => {
    const server = fingerprint !== undefined
    // Isolate the child tree from terminal Ctrl+C so the server can drain its requests first.
    const child = spawn(executable, args, {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: [server ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: server ? {
        ...process.env,
        SESSIONMENDER_UI_FINGERPRINT: fingerprint,
        SESSIONMENDER_SHUTDOWN_ON_STDIN_EOF: '1',
      } : process.env,
    })
    let error
    let deadline
    let terminating = false
    let ready = false
    child.on('error', cause => { error = cause })
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
    if (server) {
      child.stdin.on('error', cause => {
        if (cause.code !== 'EPIPE') error = cause
      })
      const lines = createInterface({ input: child.stdout })
      lines.on('line', line => {
        if (line.startsWith('http://127.0.0.1:')) {
          lines.close()
          ready = true
          try {
            onReady()
          } catch (cause) {
            error = cause
            child.stdin.end()
          }
        }
      })
    }

    function terminate(signal) {
      if (!child.pid) return
      if (windows) {
        if (terminating) return
        terminating = true
        const taskkill = process.env.SystemRoot
          ? join(process.env.SystemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.on('error', () => child.kill())
        killer.on('exit', code => { if (code !== 0) child.kill() })
      } else {
        try {
          process.kill(-child.pid, signal)
        } catch (cause) {
          if (cause.code !== 'ESRCH') child.kill(signal)
        }
      }
    }

    stopChild = signal => {
      if (ready) {
        child.stdin.end()
        return
      }
      terminate(signal)
      deadline = setTimeout(() => terminate('SIGKILL'), 5_000)
    }
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      stopChild = undefined
      if (interrupted) done()
      else if (error) fail(new Error(`Could not run ${label}: ${error.message}`))
      else if (code === 0) done()
      else fail(Object.assign(new Error(`${label} failed (${signal ?? `exit code ${code}`}).`), {
        exitCode: code ?? 128 + (constants.signals[signal] ?? 1),
      }))
    })
  })
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function digestTree(directory, excluded = []) {
  const digest = createHash('sha256')
  const parents = new Set()
  function visit(path, relative = '') {
    const realPath = realpathSync(path)
    if (parents.has(realPath)) throw new Error(`Circular directory link: ${path}`)
    parents.add(realPath)
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.name === '.DS_Store' || (!relative && excluded.includes(entry.name))) continue
      const file = join(path, entry.name)
      const name = relative + entry.name
      const link = entry.isSymbolicLink()
      const info = link ? statSync(file) : entry
      if (link) digest.update(JSON.stringify([name, 'link', readlinkSync(file)]) + '\n')
      if (info.isDirectory()) visit(file, `${name}/`)
      else if (info.isFile()) digest.update(JSON.stringify([name, 'file', sha256(readFileSync(file))]) + '\n')
      else throw new Error(`Unsupported frontend file: ${file}`)
    }
    parents.delete(realPath)
  }
  visit(directory)
  return digest.digest('hex')
}

function readStamp(directory, name) {
  try {
    return JSON.parse(readFileSync(join(directory, name), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

function dependencyInputs() {
  const contents = ['package.json', 'package-lock.json', '.npmrc'].map(name => {
    try {
      return sha256(readFileSync(join(ui, name)))
    } catch (error) {
      if (name === '.npmrc' && error.code === 'ENOENT') return null
      throw error
    }
  })
  return sha256(JSON.stringify([
    process.platform, process.arch, process.versions.node, ...contents,
  ]))
}

function installedFiles() {
  return digestTree(modules, [installStamp, '.vite', '.vite-temp'])
}

function builtFiles() {
  for (const asset of requiredAssets) {
    if (readFileSync(join(dist, asset)).length === 0) return null
  }
  return digestTree(dist, [buildStamp])
}

function verifiedOutput(directory, name, inputs, output) {
  try {
    const stamp = readStamp(directory, name)
    return stamp?.inputs === inputs && typeof stamp.output === 'string' && stamp.output === output()
      ? stamp.output : null
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code)) return null
    throw error
  }
}

async function prepare(npm) {
  const dependencies = dependencyInputs()
  const reinstall = !verifiedOutput(modules, installStamp, dependencies, installedFiles)
  if (reinstall) {
    console.log(`${prefix} Installing frontend dependencies...`)
    await run(process.execPath, [npm, 'ci', '--prefix', 'ui', '--include=dev', '--include=optional'], { label: 'npm ci' })
    checkInterrupted()
    if (dependencies !== dependencyInputs()) throw new Error('Frontend dependency files changed during npm ci. Run npm start again.')
    writeFileSync(join(modules, installStamp), JSON.stringify({ inputs: dependencies, output: installedFiles() }))
  } else console.log(`${prefix} Frontend dependencies are up to date.`)

  const buildInputs = () => sha256(JSON.stringify([
    dependencies,
    digestTree(ui, ['node_modules', 'dist', '.local', 'tests']),
    process.env.NODE_ENV,
    Object.entries(process.env).filter(([key]) => key.startsWith('VITE_')).sort(),
  ]))
  const inputs = buildInputs()
  const existing = reinstall ? null : verifiedOutput(dist, buildStamp, inputs, builtFiles)
  if (!existing) {
    // Invalidate the previous stamp before starting a build that may be interrupted.
    try {
      unlinkSync(join(dist, buildStamp))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    console.log(`${prefix} Building the frontend...`)
    await run(process.execPath, [npm, 'run', 'build', '--prefix', 'ui'], { label: 'Frontend build' })
    checkInterrupted()
    if (inputs !== buildInputs()) throw new Error('Frontend files changed during the build. Run npm start again.')
    const output = builtFiles()
    if (!output) throw new Error('The frontend build produced an empty required asset in ui/dist.')
    writeFileSync(join(dist, buildStamp), JSON.stringify({ inputs, output }))
    return output
  }
  console.log(`${prefix} Frontend build is up to date.`)
  return existing
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22)) {
    throw new Error('Node.js 20.19+ (20.x) or 22.12+ with npm is required.')
  }
  const npm = npmCli()
  toolVersion(process.execPath, [npm, '--version'], 'npm')
  toolVersion(cargo, ['--version'], 'Cargo')
  const rust = /^rustc (\d+)\.(\d+)/.exec(toolVersion(windows ? 'rustc.exe' : 'rustc', ['--version'], 'Rust'))
  if (!rust || Number(rust[1]) < 1 || (Number(rust[1]) === 1 && Number(rust[2]) < 89)) {
    throw new Error('Rust 1.89 or newer is required.')
  }
  checkInterrupted()

  // Only serialize preparation and compilation. The lock is released as soon as Cargo's UI is ready.
  const local = join(ui, '.local')
  const lock = join(local, 'startup.lock')
  mkdirSync(local, { recursive: true })
  try {
    writeFileSync(lock, String(process.pid), { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Startup is already in progress. If the launcher has stopped, remove ${lock} and retry.`)
  }
  let preparing = true
  const release = () => {
    if (!preparing) return
    try {
      unlinkSync(lock)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    preparing = false
  }
  try {
    const fingerprint = await prepare(npm)
    console.log(`${prefix} Starting SessionMender with Cargo...`)
    await run(cargo, ['run', '--locked', '--package', 'agentmender', '--', ...process.argv.slice(2)], {
      label: 'Cargo', fingerprint, onReady: release,
    })
  } finally {
    release()
  }
}

try {
  await main()
} catch (error) {
  if (!interrupted) console.error(`${prefix} ${error.message}`)
  process.exitCode = error.exitCode ?? 1
}
if (interrupted) process.exitCode = 128 + (constants.signals[interrupted] ?? 2)
