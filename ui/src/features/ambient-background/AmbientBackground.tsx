import { useEffect, useRef } from 'react'
import type { Provider } from '../../lib/api/contracts'
import { motionDuration } from '../../lib/utils/motion'
import type { BubbleScene } from './scene'
import './background.css'

const modelPaths: Record<Provider, string> = {
  codex: '/assets/codex.glb',
  claude: '/assets/Clawd-Animator.glb',
}

export function AmbientBackground({ provider }: { provider: Provider }) {
  const surface = useRef<HTMLDivElement>(null)
  const scene = useRef<{ provider: Provider; handle: BubbleScene } | null>(null)
  const bytes = useRef(new Map<Provider, ArrayBuffer>())
  const unavailable = useRef(new Set<Provider>())

  useEffect(() => () => {
    scene.current?.handle.dispose()
    scene.current = null
  }, [])

  useEffect(() => {
    const host = surface.current
    if (!host) return
    const current = scene.current
    if (current?.provider === provider) {
      current.handle.start()
      host.dataset.visible = 'true'
      return
    }

    const load = new AbortController()
    const { signal } = load
    const release = () => {
      current?.handle.dispose()
      if (scene.current === current) scene.current = null
    }
    let fade = Promise.resolve()
    if (current) {
      host.dataset.visible = 'false'
      current.handle.pause()
      const duration = motionDuration('--motion-provider-switch')
      if (duration) {
        fade = new Promise<void>(resolve => {
          const timer = window.setTimeout(() => {
            release()
            resolve()
          }, duration)
          signal.addEventListener('abort', () => {
            window.clearTimeout(timer)
            resolve()
          }, { once: true })
        })
      } else {
        release()
      }
    }

    function fallback(target: HTMLDivElement) {
      unavailable.current.add(provider)
      bytes.current.delete(provider)
      if (scene.current?.provider === provider) {
        target.dataset.visible = 'false'
        scene.current.handle.dispose()
        scene.current = null
      }
    }

    async function mount(target: HTMLDivElement) {
      try {
        let model = bytes.current.get(provider)
        if (!model) {
          const response = await fetch(modelPaths[provider], { signal, credentials: 'omit' })
          if (!response.ok || response.headers.get('Content-Type') !== 'model/gltf-binary') {
            signal.throwIfAborted()
            fallback(target)
            return
          }
          model = await response.arrayBuffer()
          signal.throwIfAborted()
          bytes.current.set(provider, model)
        }
        const { createScene, scenes } = await import('./scene')
        // Keep the outgoing frame during its fade. Only then acquire the next context.
        await fade
        signal.throwIfAborted()
        const next = await createScene(target, model, scenes[provider], signal, () => fallback(target))
        if (signal.aborted || unavailable.current.has(provider)) {
          next.dispose()
          return
        }
        scene.current = { provider, handle: next }
        next.start()
        target.dataset.theme = provider
        target.dataset.visible = 'true'
      } catch {
        if (!signal.aborted) fallback(target)
      }
    }

    if (!unavailable.current.has(provider)) void mount(host)
    return () => load.abort()
  }, [provider])

  return <div className="ambient-background" ref={surface} aria-hidden="true" />
}
