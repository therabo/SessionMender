import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const windows = process.platform === 'win32'
export const prefix = '[SessionMender]'
export const installedBinary = join(root, '.sessionmender', windows ? 'agentmender.exe' : 'agentmender')

let interrupted
let stopChild

function interrupt(signal) {
  if (interrupted) return
  interrupted = signal
  stopChild?.(signal)
}

export function checkInterrupted() {
  if (interrupted) throw new Error('Startup interrupted.')
}

export function run(executable, args, {
  label, cwd = root, env = process.env, server = false, onReady, onStdout, launchHint,
}) {
  checkInterrupted()
  return new Promise((done, fail) => {
    // Isolate the child tree from terminal Ctrl+C so the server can drain its requests first.
    const child = spawn(executable, args, {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: [server ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: server ? { ...env, SESSIONMENDER_SHUTDOWN_ON_STDIN_EOF: '1' } : env,
    })
    let error
    let deadline
    let terminating = false
    let ready = false
    child.on('error', cause => { error = cause })
    if (onStdout) {
      createInterface({ input: child.stdout }).on('line', onStdout)
    } else {
      child.stdout.pipe(process.stdout, { end: false })
    }
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
            onReady?.()
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
      else if (error) fail(new Error(`Could not run ${label}: ${error.message}${launchHint ?? ''}`))
      else if (code === 0) done()
      else fail(Object.assign(new Error(`${label} failed (${signal ?? `exit code ${code}`}).`), {
        exitCode: code ?? 128 + (constants.signals[signal] ?? 1),
      }))
    })
  })
}

export async function runMain(main) {
  const signals = windows ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']
  for (const signal of signals) process.on(signal, interrupt)
  try {
    await main()
  } catch (error) {
    if (!interrupted) console.error(`${prefix} ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  } finally {
    for (const signal of signals) process.off(signal, interrupt)
  }
  if (interrupted) process.exitCode = 128 + (constants.signals[interrupted] ?? 2)
}
