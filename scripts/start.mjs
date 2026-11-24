import { cargo, withPreparedFrontend } from './build.mjs'
import { prefix, run, runMain } from './process.mjs'

await runMain(() => withPreparedFrontend(async (fingerprint, release) => {
  console.log(`${prefix} Starting SessionMender with Cargo...`)
  await run(cargo, ['run', '--locked', '--package', 'agentmender', '--', ...process.argv.slice(2)], {
    label: 'Cargo',
    env: { ...process.env, SESSIONMENDER_UI_FINGERPRINT: fingerprint },
    server: true,
    onReady: release,
  })
}))
