# AgentMender

AgentMender is a local browser app for browsing and cleaning up Codex and Claude Code sessions. It brings conversations, projects, and storage into one place so you can find old work and review what a cleanup would remove.

## Features

- Discover local installations and archives. Search and filter main conversations by project, activity, state, and size, then open their transcripts.
- Review a Codex session and its verified descendants before deleting the tree. Where project membership is complete, delete a registered project's sessions in bulk while keeping the project and workspace. After native deletion, AgentMender cleans up scoped history, indexes, and recognized Codex Desktop catalog entries.
- Review and delete a Claude Code session, including verified session files, checkpoints, and matching shared history entries.
- Use Storage Manager to inspect Claude Code disk usage and review individual Codex export and backup groups before removing them.

## Platform support

| Capability | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Codex installation, archive, and export inventory | Yes | Yes | Yes |
| Codex projects, sessions, transcripts, and descendant review | Yes | Unavailable | Verified on Windows 11 x64 |
| Codex session and project-session deletion, with local reference cleanup | Requires a supported native Codex executable | Unavailable | Requires native Codex `0.171.0-alpha.13`. Verified on Windows 11 x64. |
| Codex export deletion | Yes | Yes, with `openat2` required for directories | Verified on Windows 11 x64 |
| Claude Code projects, sessions, transcripts, and storage | Yes | Yes | Yes |
| Claude Code session deletion | Yes | Unavailable | Verified on Windows 11 x64 with a JSONL fixture |

Inventory and transcript coverage depend on the archive format, available metadata, and filesystem access. On Windows, the Codex reader uses a verified private copy of `state_5.sqlite` and its WAL. The app reports a separate `sqlite_home` as unavailable when it cannot verify its association with the session root. Protected descendants, changed previews, shared files, reparse points, and incomplete export groups can make individual operations unavailable. On Windows, recognized Desktop catalogs in WAL mode are updated in a SQLite transaction. A busy writer or unrecognized schema is reported as incomplete cleanup.

On Windows, Exports also lists entries from `export` and `exports` in the selected Codex workspace. SessionMender uses `desktop.workspace-root` when configured, or `Codex` inside the current user's Windows Documents folder. Restart SessionMender after creating either folder. Workspace exports can be removed through the same review and confirmation flow as other export groups.

## Build and run locally

Install Rust 1.89 or later with Cargo and Node.js 22 with npm. Bundled SQLite and Zstandard require a C compiler on macOS and Windows. On Windows, install Visual Studio Build Tools with the Desktop development with C++ workload and a Windows SDK, then use an MSVC Rust toolchain matching your architecture. From the repository root, build the React frontend first so Cargo can embed it in the executable.

```sh
npm ci --prefix ui
npm run build --prefix ui
cargo build --locked --workspace
./target/debug/agentmender ui
```

On Windows, launch `target\debug\agentmender.exe ui`. The app serves the UI on IPv4 loopback and opens your default browser. Use `ui --no-open` to print the private launch URL or `--help` to see the options for selecting archives and executables.

To launch directly in Google Chrome on Windows, run `scripts\sessionmender-chrome.cmd` from File Explorer or a Desktop shortcut. Keep the launcher window open while using SessionMender. Codex Desktop can be closed.

If a completed deletion left a Desktop catalog entry, run `target\debug\agentmender.exe reconcile-desktop --confirm <UUID>`. Pass only the UUIDs from the earlier deletion result. The command checks that each UUID is absent from the selected Codex archive before reconciling its local Desktop entry. Use the same `--codex-root` override as the original operation if applicable.

### Windows verification and release

The native Windows x64 Codex CLI `0.171.0-alpha.13` from the Codex MSIX package was exercised directly with disposable databases and workspaces. It removed active JSONL, archived JSONL, and archived Zstandard rollouts and their SQLite rows. The Windows API and Chrome suite passed locally on Windows 11 x64 with that Codex version, a Claude Code JSONL fixture with version metadata `2.1.0`, a Desktop SQLite catalog fixture, and export fixtures. The CI matrix includes the suite on Windows x64 and ARM64. Windows ARM64 results are still pending. A Windows host that blocks locally built binaries cannot run the backend suite or the Rust tests there.

To run the suite on Windows, build the app, set `SESSIONMENDER_TEST_CODEX` to that version of the native `codex.exe`, and set `SESSIONMENDER_TEST_CHROMIUM` to Edge or Chromium. Run `cargo test --locked --workspace` and `npm run test:windows --prefix ui`. The suite uses temporary roots for destructive operations.

For distribution to Windows PCs with Smart App Control enabled, Authenticode signing with a trusted code-signing certificate and signature verification are separate release steps. [Microsoft Smart App Control signing guidance](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)

### 3D backgrounds

The build includes the Codex model from `ui/public/assets/codex.glb`. The standard launch command uses this model automatically.

The optional Claude Code preview uses `assets/Clawd-Animator.glb` from [Clawd Little Worlds at `aefeaa7`](https://github.com/leonvanzyl/clawd-little-worlds/tree/aefeaa7f6a9c8126338c7da5b975371a0bb28f04). Keep this model for local evaluation while its redistribution terms are unclear. The loopback server checks its GLB header and accepts files up to 16 MiB.

```sh
mkdir -p ui/.local
curl --fail --location --output ui/.local/Clawd-Animator.glb \
  https://raw.githubusercontent.com/leonvanzyl/clawd-little-worlds/aefeaa7f6a9c8126338c7da5b975371a0bb28f04/assets/Clawd-Animator.glb
SESSIONMENDER_CLAWD_GLB="$PWD/ui/.local/Clawd-Animator.glb" ./target/debug/agentmender ui
```

The Claude Code GLB is read at launch from the configured local path. Three.js loads on demand and shares the renderer setup and motion simulation across the two provider configurations. During a switch, the outgoing canvas pauses and fades before the next context is created. The original provider background is used when its model or WebGL2 is unavailable.

Run `npm run test:background --prefix ui` for the scene configuration and model-fit tests. With `SESSIONMENDER_CLAWD_GLB` set and the app built, run `npm run test:background:browser --prefix ui` for the browser tests. On macOS the browser tests use the standard Google Chrome installation. Set `SESSIONMENDER_TEST_CHROMIUM` to the executable for another Chromium installation.

## Permanent deletion

AgentMender requires an explicit confirmation before deleting sessions or exports. **Deletion is permanent. No backups are created.** Review the affected items before confirming. A cleanup can partially succeed if files change or become inaccessible. The result reports failures and the inventory refreshes after the attempt.
