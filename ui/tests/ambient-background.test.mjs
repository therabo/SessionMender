import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { BoxGeometry, Group, Mesh, Vector3 } from 'three'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null, ws: false },
})
after(() => vite.close())

const feature = '/src/features/ambient-background'
const { profiles, scenes } = await vite.ssrLoadModule(feature + '/config.ts')
const { fitModel } = await vite.ssrLoadModule(feature + '/model.ts')

test('both desktop scenes have seven mascots and five decorative shells', () => {
  for (const scene of Object.values(scenes)) {
    assert.equal(scene.placements.length, profiles.desktop.bubbles)
    assert.equal(scene.placements.filter(p => p.mascot).length, profiles.desktop.mascots)
    for (const profile of [profiles.compact, profiles.phone]) {
      assert.ok(scene.placements.slice(0, profile.bubbles).filter(p => p.mascot).length >= profile.mascots)
    }
  }
  assert.equal(new Set(scenes.codex.placements.filter(p => p.mascot).map(p => p.radius)).size, 7)
  assert.notEqual(scenes.codex.motionSeed, scenes.claude.motionSeed)
  assert.notEqual(scenes.codex.motionPhase, scenes.claude.motionPhase)
})

test('normalization centers a transformed static model and fits its actual vertices', () => {
  const root = new Group()
  const geometry = new BoxGeometry(2, 4, 6)
  const mesh = new Mesh(geometry)
  mesh.position.set(8, -6, 2)
  mesh.rotation.z = Math.PI / 6
  mesh.scale.set(1.5, 0.5, 1)
  root.add(mesh)

  const { center, fit } = fitModel(root, 0.76)
  assert.ok(center.distanceTo(mesh.position) < 1e-10)
  const vertex = new Vector3()
  let maxDistance = 0
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    vertex.fromBufferAttribute(geometry.attributes.position, i).applyMatrix4(mesh.matrixWorld)
    maxDistance = Math.max(maxDistance, vertex.distanceTo(center) * fit)
  }
  assert.ok(Math.abs(maxDistance - 0.76) < 1e-10)
  assert.throws(() => fitModel(new Group(), 0.76), /Invalid bubble model bounds/)
})
