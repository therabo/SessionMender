#!/usr/bin/env node

import { installedBinary, run, runMain } from './process.mjs'

await runMain(() => run(installedBinary, process.argv.slice(2), {
  label: 'the installed SessionMender executable',
  cwd: process.cwd(),
  server: true,
  launchHint: '. From the SessionMender checkout, run npm install -g . to repair the installation.',
}))
