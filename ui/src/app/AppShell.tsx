import type { ReactNode } from 'react'
import logo from '../assets/logo.png'
import { SegmentedControl } from '../components/ui/glass'
import { AmbientBackground } from '../features/ambient-background/AmbientBackground'
import type { Provider } from '../lib/api/contracts'

const providers = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
] as const

export function AppShell({ provider, onProviderChange, children }: {
  provider: Provider; onProviderChange: (provider: Provider) => void; children: ReactNode
}) {
  return <div className="shell" data-provider={provider}>
    <div className="aurora" data-theme="codex" aria-hidden />
    <div className="aurora" data-theme="claude" aria-hidden />
    <AmbientBackground provider={provider} />
    <header className="app-header">
      <img className="app-mark" src={logo} alt="SessionMender" width={68} height={68} />
      <SegmentedControl className="provider-switch" label="Provider" items={providers} value={provider} onChange={onProviderChange} />
    </header>
    <main className="workspace">{children}</main>
  </div>
}
