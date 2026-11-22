import { AnimationMixer, Box3, Mesh, Texture, Vector3, type AnimationClip, type Object3D } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'

export async function loadModel(bytes: ArrayBuffer, signal: AbortSignal) {
  const bitmaps = new Set<ImageBitmap>()
  let released = false
  function closeImages() {
    released = true
    for (const bitmap of bitmaps) bitmap.close()
    bitmaps.clear()
  }

  const loader = new GLTFLoader().register(parser => {
    const loadImageSource = parser.loadImageSource.bind(parser)
    const embedded = new Map<number, Promise<Texture>>()
    parser.loadImageSource = (index, imageLoader) => {
      const source: { bufferView?: number; mimeType?: string } = parser.json.images[index]
      if (source.bufferView === undefined) return loadImageSource(index, imageLoader)
      const cached = embedded.get(index)
      if (cached) return cached.then(texture => texture.clone())

      // Decode the GLB buffer directly. The local UI does not allow blob URL requests.
      const pending = parser.getDependency('bufferView', source.bufferView).then(async (data: ArrayBuffer) => {
        const bitmap = await createImageBitmap(new Blob([data], { type: source.mimeType }), {
          colorSpaceConversion: 'none',
          premultiplyAlpha: 'none',
        })
        if (released || signal.aborted) {
          bitmap.close()
          throw new Error('Model image decoding canceled')
        }
        bitmaps.add(bitmap)
        const texture = new Texture(bitmap)
        texture.needsUpdate = true
        return texture
      })
      embedded.set(index, pending)
      return pending
    }
    return { name: 'embedded-model-images' }
  })

  try {
    const model = await loader.parseAsync(bytes, '')
    signal.throwIfAborted()
    return { model, closeImages }
  } catch (error) {
    closeImages()
    throw error
  }
}

export function fitModel(root: Object3D, maxRadius: number, idle?: AnimationClip) {
  const bounds = new Box3()
  let radius: number
  if (idle) {
    const box = new Box3()
    const sampler = new AnimationMixer(root)
    sampler.clipAction(idle).play()
    const steps = Math.ceil(idle.duration * 24)
    for (let i = 0; i <= steps; i++) {
      sampler.setTime(i / steps * idle.duration)
      bounds.union(box.setFromObject(root, true))
    }
    sampler.stopAllAction()
    sampler.uncacheRoot(root)
    // Half of the envelope diagonal bounds every sampled pose at any angle.
    radius = bounds.getSize(new Vector3()).length() / 2
  } else {
    bounds.setFromObject(root, true)
    const center = bounds.getCenter(new Vector3())
    const vertex = new Vector3()
    let maxDistanceSquared = 0
    root.traverse(object => {
      if (!(object instanceof Mesh)) return
      const count = object.geometry.attributes.position.count
      for (let i = 0; i < count; i++) {
        object.getVertexPosition(i, vertex).applyMatrix4(object.matrixWorld)
        maxDistanceSquared = Math.max(maxDistanceSquared, vertex.distanceToSquared(center))
      }
    })
    radius = Math.sqrt(maxDistanceSquared)
  }

  const fit = maxRadius / radius
  if (!Number.isFinite(fit) || fit <= 0) throw new Error('Invalid bubble model bounds')
  return { center: bounds.getCenter(new Vector3()), fit }
}
