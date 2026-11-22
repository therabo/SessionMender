import { AnimationMixer, Box3, Mesh, Vector3, type AnimationClip, type Object3D } from 'three'

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
