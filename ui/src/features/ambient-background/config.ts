import type { Provider } from '../../lib/api/contracts'
import type { GlassPalette } from './glass'

export const profiles = {
  desktop: { bubbles: 12, mascots: 7, dpr: 1.5, pixels: 2_100_000, fps: 60 },
  compact: { bubbles: 6, mascots: 2, dpr: 1.2, pixels: 1_050_000, fps: 30 },
  phone: { bubbles: 5, mascots: 1, dpr: 1.1, pixels: 700_000, fps: 30 },
} as const

export const depths = {
  near: { strength: 1, drift: 1, depthExtent: 0.42 },
  middle: { strength: 0.76, drift: 0.76, depthExtent: 0.34 },
  far: { strength: 0.38, drift: 0.50, depthExtent: 0.27 },
} as const

type Placement = {
  x: number
  y: number
  z: number
  radius: number
  depth: keyof typeof depths
  mascot?: true
  yaw?: number
  phone?: { x: number; y?: number }
  compactY?: number
}

type Directional = readonly [color: string, intensity: number, x: number, y: number, z: number]

export type SceneConfig = {
  placements: readonly Placement[]
  motionSeed: number
  motionPhase: number
  model: {
    maxRadius: number
    idle?: string
    defaultSurface?: { roughness: number; metalness: number }
  }
  exposure: number
  hemisphere: readonly [sky: string, ground: string, intensity: number]
  lights: readonly Directional[]
  glass: GlassPalette
}

export const scenes: Record<Provider, SceneConfig> = {
  claude: {
    placements: [
      { x: -0.66, y: 0.80, z: 2.6, radius: 0.77, depth: 'near', mascot: true, yaw: 0.28, phone: { x: 0.83 }, compactY: 0.85 },
      { x: 0.78, y: 0.81, z: -1.2, radius: 0.73, depth: 'middle', mascot: true, yaw: -0.34, phone: { x: -0.98, y: -0.38 }, compactY: 0.85 },
      { x: 0.85, y: -0.75, z: 2.0, radius: 1.08, depth: 'near', mascot: true, yaw: -0.52 },
      { x: -0.87, y: -0.56, z: -5.3, radius: 1.13, depth: 'far' },
      { x: 0.92, y: 0.32, z: -3.7, radius: 0.51, depth: 'middle' },
      { x: -0.94, y: 0.27, z: -6.6, radius: 0.53, depth: 'far' },
      { x: 0.36, y: 0.83, z: -4.9, radius: 0.63, depth: 'middle', mascot: true, yaw: -0.19 },
      { x: -0.58, y: 0.55, z: -9.2, radius: 0.77, depth: 'far' },
      { x: 0.78, y: -0.31, z: -5.5, radius: 0.76, depth: 'middle' },
      { x: -0.95, y: -0.86, z: -6.8, radius: 0.56, depth: 'far', mascot: true, yaw: 0.42 },
      { x: 0.075, y: 0.67, z: -3.4, radius: 0.66, depth: 'middle', mascot: true, yaw: -0.15 },
      { x: -0.20, y: -0.48, z: -2.1, radius: 0.90, depth: 'middle', mascot: true, yaw: 0.24 },
    ],
    motionSeed: 0,
    motionPhase: 0,
    model: { maxRadius: 0.78, idle: 'Clawd / Idle' },
    exposure: 0.91,
    hemisphere: ['#ffe0ef', '#61406c', 1.91],
    lights: [
      ['#fff0dd', 2.75, -4, 8, 6],
      ['#f9a5d4', 2.10, 5, 1, -5],
      ['#c8b5ff', 0.75, 4, -2, 5],
    ],
    glass: {
      tint: [0.66, 0.19, 0.36],
      pearl: [0.55, 0.49, 0.83],
      key: [0.78, 0.64, 0.63],
      glint: [0.86, 0.74, 0.73],
      fill: [0.44, 0.39, 0.78],
      sweep: [0.56, 0.25, 0.35],
      caustic: [0.42, 0.19, 0.30],
    },
  },
  codex: {
    placements: [
      { x: 0.68, y: 0.75, z: -1.05, radius: 1.00, depth: 'far', mascot: true, yaw: -0.32, phone: { x: 0.78, y: 0.79 }, compactY: 0.82 },
      { x: -0.76, y: 0.75, z: -1.75, radius: 0.83, depth: 'middle', mascot: true, yaw: 0.45, phone: { x: -0.92, y: -0.53 }, compactY: 0.83 },
      { x: -0.715, y: -0.69, z: -1.1, radius: 1.18, depth: 'middle', mascot: true, yaw: 0.38 },
      { x: 0.93, y: 0.12, z: -4.1, radius: 0.63, depth: 'middle' },
      { x: -0.37, y: -0.86, z: -9.2, radius: 0.76, depth: 'far' },
      { x: -0.94, y: 0.32, z: -6.0, radius: 0.58, depth: 'far' },
      { x: -0.32, y: 0.85, z: -7.0, radius: 0.49, depth: 'far', mascot: true, yaw: 0.67 },
      { x: 0.39, y: -0.14, z: -10.6, radius: 0.72, depth: 'far' },
      { x: 0.58, y: -0.91, z: -8.4, radius: 0.86, depth: 'far' },
      { x: 0.80, y: -0.61, z: -4.8, radius: 0.66, depth: 'middle', mascot: true, yaw: -0.68 },
      { x: 0.15, y: 0.60, z: -3.65, radius: 0.71, depth: 'middle', mascot: true, yaw: 0.18 },
      { x: 0.22, y: -0.39, z: -2.9, radius: 0.93, depth: 'near', mascot: true, yaw: -0.34 },
    ],
    motionSeed: 40,
    motionPhase: 37,
    model: { maxRadius: 0.76, defaultSurface: { roughness: 0.78, metalness: 0.04 } },
    exposure: 0.93,
    hemisphere: ['#e6f5ff', '#315c8a', 1.65],
    lights: [
      ['#d9f0ff', 2.50, -5, 7, 6],
      ['#72e6ff', 2.25, 5, 2, -6],
      ['#8bbaff', 0.85, 5, -2, 5],
    ],
    glass: {
      tint: [0.08, 0.43, 0.64],
      pearl: [0.29, 0.65, 0.85],
      key: [0.67, 0.80, 0.94],
      glint: [0.78, 0.91, 0.99],
      fill: [0.21, 0.55, 0.81],
      sweep: [0.06, 0.43, 0.56],
      caustic: [0.12, 0.47, 0.67],
    },
  },
}
