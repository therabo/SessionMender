import { ShaderMaterial, Vector3 } from 'three'

export type GlassPalette = Record<
  'tint' | 'pearl' | 'key' | 'glint' | 'fill' | 'sweep' | 'caustic',
  readonly [number, number, number]
>

// The shell samples a small analytic lighting environment in reflection and
// refraction directions. It needs no screen capture or transmission pass.
export function glass(strength: number, palette: GlassPalette) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      strength: { value: strength },
      tintColor: { value: new Vector3(...palette.tint) },
      pearlColor: { value: new Vector3(...palette.pearl) },
      keyColor: { value: new Vector3(...palette.key) },
      glintColor: { value: new Vector3(...palette.glint) },
      fillColor: { value: new Vector3(...palette.fill) },
      sweepColor: { value: new Vector3(...palette.sweep) },
      causticColor: { value: new Vector3(...palette.caustic) },
    },
    vertexShader: `
      varying vec3 surface;
      varying vec3 viewNormal;
      varying vec3 shellPoint;

      void main() {
        vec4 point = modelViewMatrix * vec4(position, 1.0);
        surface = point.xyz;
        viewNormal = normalize(normalMatrix * normal);
        shellPoint = position;
        gl_Position = projectionMatrix * point;
      }
    `,
    fragmentShader: `
      uniform float strength;
      uniform vec3 tintColor;
      uniform vec3 pearlColor;
      uniform vec3 keyColor;
      uniform vec3 glintColor;
      uniform vec3 fillColor;
      uniform vec3 sweepColor;
      uniform vec3 causticColor;
      varying vec3 surface;
      varying vec3 viewNormal;
      varying vec3 shellPoint;

      float softbox(vec3 ray, vec3 light, vec2 spread) {
        vec3 u = normalize(cross(vec3(0.0, 1.0, 0.0), light));
        vec3 v = cross(light, u);
        vec2 p = vec2(dot(ray, u), dot(ray, v)) / spread;
        return exp(-dot(p, p)) * smoothstep(0.12, 0.88, dot(ray, light));
      }

      void main() {
        vec3 normal = normalize(viewNormal);
        vec3 eye = normalize(-surface);
        float facing = clamp(dot(normal, eye), 0.0, 1.0);
        float rim = pow(1.0 - facing, 2.35);
        float innerRim = exp(-92.0 * pow(facing - 0.24, 2.0));
        vec3 reflected = reflect(-eye, normal);
        vec3 bent = refract(-eye, normal, 0.94);

        float key = softbox(reflected, normalize(vec3(-0.62, 0.78, 0.37)), vec2(0.48, 0.18));
        float glint = softbox(reflected, normalize(vec3(-0.58, 0.80, 0.32)), vec2(0.33, 0.065));
        float fill = softbox(reflected, normalize(vec3(0.77, 0.32, 0.56)), vec2(0.28, 0.52));
        float sweep = softbox(reflected, normalize(vec3(0.38, -0.83, -0.22)), vec2(0.56, 0.23));
        float caustic = softbox(bent, normalize(vec3(0.34, -0.53, -0.81)), vec2(0.58, 0.20));

        float film = 0.5 + 0.5 * sin(5.8 * facing + dot(shellPoint, vec3(1.5, 2.9, 1.1)));
        vec3 tint = mix(tintColor, pearlColor, film);
        vec3 color = tint * (0.58 + 0.36 * rim)
          + keyColor * key
          + glintColor * glint
          + fillColor * fill
          + sweepColor * sweep
          + causticColor * caustic;
        float alpha = 0.021 + 0.29 * rim + 0.10 * innerRim
          + 0.37 * key + 0.24 * glint + 0.21 * fill + 0.14 * sweep + 0.09 * caustic;
        gl_FragColor = vec4(color, strength * min(alpha, 0.72));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
}
