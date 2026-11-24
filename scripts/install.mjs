import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { cargo, withPreparedFrontend } from './build.mjs'
import { checkInterrupted, installedBinary, prefix, run, runMain, windows } from './process.mjs'

await runMain(() => withPreparedFrontend(async fingerprint => {
  const executables = new Set()
  console.log(`${prefix} Building the optimized SessionMender executable...`)
  await run(cargo, ['build', '--locked', '--release', '--package', 'agentmender', '--message-format=json-render-diagnostics'], {
    label: 'Cargo release build',
    env: { ...process.env, SESSIONMENDER_UI_FINGERPRINT: fingerprint },
    onStdout(line) {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        console.log(line)
        return
      }
      if (message?.reason === 'compiler-artifact' && message.target?.name === 'agentmender' && message.executable) {
        executables.add(message.executable)
      }
    },
  })
  checkInterrupted()
  if (executables.size !== 1) {
    throw new Error('Cargo did not report exactly one SessionMender executable. Configure a single Cargo build target for this machine.')
  }

  const [executable] = executables
  const directory = dirname(installedBinary)
  mkdirSync(directory, { recursive: true })
  const staging = mkdtempSync(join(directory, 'staging-'))
  try {
    const candidate = join(staging, basename(installedBinary))
    copyFileSync(executable, candidate)
    if (!windows) chmodSync(candidate, 0o755)
    // Check that the selected Cargo target runs here without starting a server.
    await run(candidate, ['--version'], {
      label: 'compiled SessionMender executable',
      launchHint: '. Check that the Cargo target matches this machine.',
    })
    checkInterrupted()
    try {
      renameSync(candidate, installedBinary)
    } catch (error) {
      throw new Error(`Could not replace the installed executable. Close SessionMender and retry installation. ${error.message}`)
    }
  } finally {
    rmSync(staging, { force: true, recursive: true })
  }
  console.log(`${prefix} Installation complete. Run session-mender to open the app.`)
}))
