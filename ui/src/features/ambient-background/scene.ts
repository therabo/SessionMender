import {
  AnimationMixer, DirectionalLight, Group, HemisphereLight, MathUtils, Mesh,
  MeshStandardMaterial, NeutralToneMapping, PerspectiveCamera, Scene, SkinnedMesh, SphereGeometry, Vector3, WebGLRenderer,
  type BufferGeometry, type Material, type Object3D, type Skeleton,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'
import { advanceBubble, createBubbleMotion, motionStep } from './bubbleMotion'
import { depths, profiles, type SceneConfig } from './config'
import { glass } from './glass'
import { fitModel } from './model'

export { scenes } from './config'

const motion = '(prefers-reduced-motion: reduce)'
export type BubbleScene = {
  start: () => void
  pause: () => void
  dispose: () => void
}

export async function createScene(
  host: HTMLElement, bytes: ArrayBuffer, config: SceneConfig, signal: AbortSignal, onLost: () => void,
): Promise<BubbleScene> {
  // Both pinned models are self-contained and need no decoders or texture requests.
  const model = await new GLTFLoader().parseAsync(bytes, '')
  signal.throwIfAborted()

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' })
  if (!context) throw new Error('WebGL2 unavailable')
  const gl = context

  const geometries = new Set<BufferGeometry>()
  const materials = new Set<Material>()
  const skeletons = new Set<Skeleton>()
  function collect(root: Object3D) {
    root.traverse(object => {
      if (!(object instanceof Mesh)) return
      geometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
      if (object instanceof SkinnedMesh) skeletons.add(object.skeleton)
    })
  }
  collect(model.scene)

  let renderer: WebGLRenderer | undefined
  const scene = new Scene()
  const camera = new PerspectiveCamera(40, 1, 0.1, 48)
  camera.position.z = 14
  const reducedMotion = window.matchMedia(motion)
  const coarse = window.matchMedia('(pointer: coarse)')
  const mixers = new Map<Group, { mixer: AnimationMixer; avatar: Object3D }>()
  let listeners: AbortController | undefined
  let frame = 0
  let lastFrame = 0
  let motionTicks = 0
  let stepRemainder = 0
  let width = 0
  let height = 0
  let lateralScale = 1
  let profile: (typeof profiles)[keyof typeof profiles] = profiles.desktop
  let disposed = false
  const resize = new ResizeObserver(() => size())

  function pause() {
    listeners?.abort()
    listeners = undefined
    resize.disconnect()
    stopFrame()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    pause()
    canvas.removeEventListener('webglcontextlost', onLost)
    for (const { mixer, avatar } of mixers.values()) {
      mixer.stopAllAction()
      mixer.uncacheRoot(avatar)
    }
    scene.clear()
    for (const skeleton of skeletons) skeleton.dispose()
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    renderer?.dispose()
    if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.remove()
  }

  const bubbles: {
    group: Group
    anchor: Vector3
    motion: ReturnType<typeof createBubbleMotion>
    mascot?: Object3D
    index: number
  }[] = []

  try {
    renderer = new WebGLRenderer({ canvas, context: gl, alpha: true })
    renderer.setClearColor(0, 0)
    renderer.toneMapping = NeutralToneMapping
    renderer.toneMappingExposure = config.exposure

    scene.add(new HemisphereLight(...config.hemisphere))
    for (const [color, intensity, x, y, z] of config.lights) {
      const light = new DirectionalLight(color, intensity)
      light.position.set(x, y, z)
      scene.add(light)
    }

    const idle = model.animations.find(clip => clip.name === config.model.idle)
    if (config.model.idle && !idle) throw new Error('Configured Idle clip missing')
    const { center, fit } = fitModel(model.scene, config.model.maxRadius, idle)
    const surface = config.model.defaultSurface
    if (surface) {
      for (const material of materials) {
        if (material instanceof MeshStandardMaterial) {
          material.roughness = surface.roughness
          material.metalness = surface.metalness
        }
      }
    }

    const sphere = new SphereGeometry(1, 40, 28)
    geometries.add(sphere)
    const shells = {
      near: glass(depths.near.strength, config.glass),
      middle: glass(depths.middle.strength, config.glass),
      far: glass(depths.far.strength, config.glass),
    }
    for (const material of Object.values(shells)) materials.add(material)

    config.placements.forEach((placement, index) => {
      const group = new Group()
      const shell = new Mesh(sphere, shells[placement.depth])
      group.add(shell)
      const bubble: (typeof bubbles)[number] = {
        group, anchor: new Vector3(), motion: createBubbleMotion(index + config.motionSeed, placement.yaw ?? 0), index,
      }
      if (placement.mascot) {
        const avatar = clone(model.scene)
        collect(avatar)
        avatar.scale.setScalar(fit)
        avatar.position.copy(center).multiplyScalar(-fit)
        if (config.model.facingYaw) {
          avatar.rotateY(config.model.facingYaw)
          avatar.position.applyQuaternion(avatar.quaternion)
        }
        avatar.traverse(object => {
          if (object instanceof SkinnedMesh) object.frustumCulled = false
        })
        if (idle) {
          const mixer = new AnimationMixer(avatar)
          mixer.clipAction(idle).play()
          mixer.setTime(idle.duration * (0.12 + index * 0.29))
          mixers.set(group, { mixer, avatar })
        }
        group.add(avatar)
        bubble.mascot = avatar
      }
      scene.add(group)
      bubbles.push(bubble)
    })
    canvas.addEventListener('webglcontextlost', onLost)
    host.append(canvas)
  } catch (error) {
    dispose()
    throw error
  }

  function size() {
    if (!renderer || !listeners) return
    const nextWidth = host.clientWidth
    const nextHeight = host.clientHeight
    if (!nextWidth || !nextHeight || nextWidth === width && nextHeight === height) return
    width = nextWidth
    height = nextHeight
    const phone = width < 540
    const compact = width < 760 || coarse.matches || navigator.hardwareConcurrency <= 4
    profile = phone ? profiles.phone : compact ? profiles.compact : profiles.desktop
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const dpr = Math.min(devicePixelRatio, profile.dpr, Math.sqrt(profile.pixels / (width * height)))
    renderer.setPixelRatio(dpr)
    renderer.setSize(width, height, false)

    const viewportScale = Math.min(1, width / 950)
    lateralScale = viewportScale * (phone ? 0.55 : 1)
    const halfFov = Math.tan(MathUtils.degToRad(camera.fov / 2))
    let mascots = 0
    for (const { group, anchor, motion, mascot, index } of bubbles) {
      const placement = config.placements[index]
      group.visible = index < profile.bubbles
      if (mascot) mascot.visible = group.visible && mascots++ < profile.mascots
      const halfHeight = (camera.position.z - placement.z) * halfFov
      const phoneAnchor = phone ? placement.phone : undefined
      const x = phoneAnchor?.x ?? placement.x
      const y = phoneAnchor?.y ?? (compact ? placement.compactY : undefined) ?? placement.y
      const halfWidth = halfHeight * camera.aspect
      anchor.set(x * halfWidth, y * halfHeight, placement.z)
      // Allocate less room outward for spheres intentionally placed at the edge.
      motion.outwardExtent = Math.max(0.26, (1 - Math.abs(x)) * halfWidth / lateralScale)
      group.scale.setScalar(placement.radius * viewportScale)
    }
    if (!document.hidden) draw(0)
  }

  function draw(dt: number) {
    stepRemainder += dt
    while (stepRemainder >= motionStep) {
      stepRemainder -= motionStep
      const time = ++motionTicks * motionStep + config.motionPhase
      for (const { anchor, motion, index } of bubbles) {
        const depth = depths[config.placements[index].depth]
        advanceBubble(motion, anchor, time, depth.drift, depth.depthExtent, lateralScale)
      }
    }
    for (const { group, mascot, anchor, motion, index } of bubbles) {
      if (!group.visible) continue
      group.position.set(
        anchor.x + motion.offset.x * lateralScale,
        anchor.y + motion.offset.y * lateralScale,
        anchor.z + motion.offset.z,
      )
      group.quaternion.setFromEuler(motion.angles)
      if (mascot?.visible && dt) mixers.get(group)?.mixer.update(dt * (0.82 + index * 0.07))
    }
    if (width && height) renderer?.render(scene, camera)
  }

  function stopFrame() {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    lastFrame = 0
  }

  function tick(now: number) {
    frame = requestAnimationFrame(tick)
    const step = now - lastFrame
    if (lastFrame && step < 1000 / profile.fps - 1) return
    draw(lastFrame ? Math.min(step / 1000, 0.06) : 0)
    lastFrame = now
  }

  function sync() {
    stopFrame()
    if (document.hidden || !listeners) return
    draw(0)
    if (!reducedMotion.matches) frame = requestAnimationFrame(tick)
  }

  function start() {
    if (disposed || listeners) return
    listeners = new AbortController()
    const signal = listeners.signal
    document.addEventListener('visibilitychange', sync, { signal })
    reducedMotion.addEventListener('change', sync, { signal })
    resize.observe(host)
    size()
    sync()
  }

  return { start, pause, dispose }
}
