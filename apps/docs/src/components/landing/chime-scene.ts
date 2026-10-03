/**
 * Procedural 風鈴 (wind chime) scene in raw WebGL2: ~6 tiny programs, a handful of draws per
 * frame and no per-frame allocations. Browser-only — every DOM/GL access happens inside
 * createChimeScene(), so the module is safe to import (and bundle) on the server.
 */

export type ChimeTheme = "dark" | "light";

export interface ChimeSceneOptions {
  /** false = prefers-reduced-motion: render static frames only. */
  animate: boolean;
  onFirstFrame: () => void;
  particleCount: number;
  theme: ChimeTheme;
  variant: "hero" | "mini";
}

export interface ChimeScene {
  clearPointer: () => void;
  dispose: () => void;
  resize: () => void;
  ring: (strength: number, clientX?: number, clientY?: number) => void;
  setActive: (active: boolean) => void;
  setPointer: (clientX: number, clientY: number) => void;
  setScroll: (progress: number) => void;
  setTheme: (theme: ChimeTheme) => void;
}

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const channel = (at: number) => Number.parseInt(value.slice(at, at + 2), 16) / 255;
  return [channel(1), channel(3), channel(5)];
}

const PALETTES = {
  dark: {
    additive: true,
    envHigh: hex("#2e3a4a"),
    envLow: hex("#05080f"),
    film: 0.4,
    glassAlpha: 0.06,
    glassTint: hex("#bfeeee"),
    halo: 0.55,
    paper: 0.8,
    particleA: hex("#4fc9c6"),
    particleB: hex("#dbe8ff"),
    particleOpacity: 1,
    rim: hex("#5fe0dc"),
    ring: hex("#6fe3df"),
    thread: hex("#c9d4e3"),
  },
  light: {
    additive: false,
    envHigh: hex("#ffffff"),
    envLow: hex("#c4e2e2"),
    film: 0.1,
    glassAlpha: 0.1,
    glassTint: hex("#8fd6d4"),
    halo: 0,
    paper: 1,
    particleA: hex("#138a88"),
    particleB: hex("#44546e"),
    particleOpacity: 0.6,
    rim: hex("#1a9c99"),
    ring: hex("#0f8583"),
    thread: hex("#5b6778"),
  },
} as const;

const RIPPLE_SLOTS = 3;
const RIPPLE_LIFE = 2.6;
const LIFE = RIPPLE_LIFE.toFixed(1);
const FOV = (35 * Math.PI) / 180;
const TAN_HALF_FOV = Math.tan(FOV / 2);

const THREAD_LEN = 0.55;
const BELL_R = 0.46;
const BELL_END = Math.PI * 0.6;
const MOUTH_Y = -THREAD_LEN - BELL_R * (1 - Math.cos(BELL_END));
const MOUTH_R = BELL_R * Math.sin(BELL_END);
const CLAPPER_STRING = 0.95;
const TANZAKU_W = 0.3;
const TANZAKU_H = 1.12;
const RING_HALF = 9;

// ---------------------------------------------------------------- shaders --

const PARTICLE_VERT = /* glsl */ `#version 300 es
uniform mat4 uView;
uniform mat4 uProj;
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uAspect;
uniform vec4 uRipples[${RIPPLE_SLOTS}];
uniform float uScroll;
in vec3 aPos;
in vec4 aSeed;
out float vAlpha;
out float vRipple;
out float vTint;

void main() {
  vec3 p = aPos;
  // Wind streamlines: drift left→right and wrap; aSeed.y is shared per lane so lanes read as wisps.
  p.x = mod(p.x + uTime * aSeed.x + 9.0, 18.0) - 9.0;
  float wave = sin(p.x * 0.42 + aSeed.y * 6.2831 + uTime * 0.3);
  p.y += wave * (0.3 + aSeed.y * 0.35) + sin(p.x * 1.3 + uTime * 0.7 + aSeed.y * 9.0) * 0.08;
  p.z += cos(p.x * 0.4 + aSeed.w * 6.2831) * 0.3;

  float ripple = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i += 1) {
    vec4 r = uRipples[i];
    float age = uTime - r.w;
    if (age > 0.0 && age < ${LIFE}) {
      vec3 d = p - r.xyz;
      d.z *= 0.6;
      float dist = length(d);
      float band = exp(-pow((dist - age * 3.2) / 0.35, 2.0)) * (1.0 - age / ${LIFE});
      p += normalize(d + 1e-4) * band * 0.45;
      ripple += band;
    }
  }

  vec4 mv = uView * vec4(p, 1.0);
  float depth = -mv.z;
  vec2 pointerView = uPointer * vec2(uAspect, 1.0) * ${TAN_HALF_FOV.toFixed(6)} * depth;
  vec2 toP = pointerView - mv.xy;
  float fall = exp(-dot(toP, toP) / (0.9 + depth * 0.12)) * uPointerActive;
  mv.xy += toP * fall * 0.32 + vec2(-toP.y, toP.x) * fall * 0.22;

  gl_Position = uProj * mv;
  float size = uSize * (0.35 + aSeed.z * 0.9) * (1.0 + ripple * 1.6 + fall * 0.8);
  gl_PointSize = size * uPixelRatio * (7.0 / depth);

  float fadeX = 1.0 - smoothstep(6.5, 9.0, abs(p.x));
  float twinkle = 0.65 + 0.35 * sin(uTime * (1.0 + aSeed.y * 2.0) + aSeed.w * 40.0);
  vAlpha = fadeX * twinkle * (1.0 - smoothstep(4.0, 18.0, depth)) * (1.0 - uScroll * 0.5) * (0.25 + aSeed.z);
  vRipple = ripple + fall * 0.6;
  vTint = aSeed.y;
}
`;

const PARTICLE_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
in float vAlpha;
in float vRipple;
in float vTint;
out vec4 outColor;

void main() {
  float d = length(gl_PointCoord - 0.5);
  float disc = 1.0 - smoothstep(0.0, 0.5, d);
  disc *= disc;
  vec3 col = mix(uColorA, uColorB, vTint) + uColorA * vRipple * 1.4;
  float a = disc * vAlpha * uOpacity * (0.75 + vRipple * 1.4);
  if (a < 0.003) discard;
  outColor = vec4(col, a);
}
`;

// World-space quad on z = 0; drawn only while a ripple is alive.
const RING_VERT = /* glsl */ `#version 300 es
uniform mat4 uView;
uniform mat4 uProj;
in vec3 aPos;
out vec2 vWorld;
void main() {
  vWorld = aPos.xy;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
`;

const RING_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform float uTime;
uniform vec4 uRipples[${RIPPLE_SLOTS}];
uniform vec3 uColor;
in vec2 vWorld;
out vec4 outColor;
void main() {
  float a = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i += 1) {
    vec4 r = uRipples[i];
    float age = uTime - r.w;
    if (age > 0.0 && age < ${LIFE}) {
      float dist = length(vWorld - r.xy);
      float radius = age * 3.2;
      float life = 1.0 - age / ${LIFE};
      float ring = exp(-pow((dist - radius) / 0.018, 2.0));
      float halo = exp(-pow((dist - radius) / 0.22, 2.0)) * 0.18;
      float echo = exp(-pow((dist - radius * 0.72) / 0.012, 2.0)) * 0.35;
      a += (ring + halo + echo) * life * life;
    }
  }
  if (a < 0.002) discard;
  outColor = vec4(uColor, min(a, 1.0));
}
`;

const TANZAKU_VERT = /* glsl */ `#version 300 es
uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uModel;
uniform float uTime;
uniform float uWind;
in vec3 aPos;
in vec2 aUv;
out vec2 vUv;
out float vShade;
void main() {
  vUv = aUv;
  vec3 p = aPos;
  float d = 1.0 - aUv.y;
  float phase = d * 5.5 - uTime * 3.4 + p.x * 3.0;
  float amp = d * d * (0.5 + uWind * 1.5);
  p.z += sin(phase) * 0.07 * amp + sin(d * 11.0 - uTime * 6.3) * 0.012 * d;
  p.z += uWind * d * d * 0.22;
  float tw = sin(uTime * 1.25 + d * 2.2) * 0.35 * d * (0.4 + uWind);
  p.xz = mat2(cos(tw), -sin(tw), sin(tw), cos(tw)) * p.xz;
  vShade = 0.82 + 0.18 * cos(phase) * d;
  gl_Position = uProj * uView * uModel * vec4(p, 1.0);
}
`;

const TANZAKU_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform sampler2D uMap;
uniform float uDim;
in vec2 vUv;
in float vShade;
out vec4 outColor;
void main() {
  vec3 tex = texture(uMap, vUv).rgb;
  float back = gl_FrontFacing ? 1.0 : 0.78;
  outColor = vec4(tex * vShade * back * uDim, 1.0);
}
`;

// Shared by the bell, clapper, rim, knot and threads.
const SOLID_VERT = /* glsl */ `#version 300 es
uniform mat4 uView;
uniform mat4 uProj;
uniform mat4 uModel;
in vec3 aPos;
in vec3 aNormal;
out vec3 vNormal;
out vec3 vWorld;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uProj * uView * w;
}
`;

// Fake glass: procedural studio environment + Fresnel + thin-film tint. Replaces
// MeshPhysicalMaterial transmission, which costs an extra full scene pass every frame.
const GLASS_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform vec3 uCam;
uniform vec3 uEnvLow;
uniform vec3 uEnvHigh;
uniform vec3 uTint;
uniform float uBaseAlpha;
uniform float uFilm;
in vec3 vNormal;
in vec3 vWorld;
out vec4 outColor;

vec3 env(vec3 d) {
  vec3 c = mix(uEnvLow, uEnvHigh, smoothstep(-0.3, 0.9, d.y));
  // tall softbox "window" on the upper left -> a long vertical streak on the glass
  float win = smoothstep(0.16, 0.05, abs(d.x + 0.42)) * smoothstep(0.05, 0.35, d.y) * smoothstep(0.0, 0.3, d.z);
  c += win * 1.8;
  // small round key light on the right and a soft top light
  c += smoothstep(0.975, 0.995, dot(d, normalize(vec3(0.6, 0.45, 0.66)))) * 1.6;
  c += smoothstep(0.7, 1.0, d.y) * 0.25;
  return c;
}

void main() {
  vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  vec3 v = normalize(uCam - vWorld);
  float ndv = clamp(dot(n, v), 0.0, 1.0);
  float fres = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  vec3 refl = env(reflect(-v, n));
  vec3 film = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + (1.0 - ndv) * 1.4 + 0.15));
  vec3 col = refl * mix(vec3(1.0), film, uFilm) + uTint * 0.08;
  float spec = max(max(refl.r, refl.g), refl.b);
  float a = clamp(uBaseAlpha + fres * 0.8 + smoothstep(0.6, 1.6, spec) * 0.6, 0.0, 1.0);
  outColor = vec4(col, a);
}
`;

const FLAT_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  outColor = uColor;
}
`;

// Additive glow behind the bell: stands in for bloom and pulses when the chime rings.
const HALO_VERT = /* glsl */ `#version 300 es
uniform mat4 uView;
uniform mat4 uProj;
uniform vec3 uCenter;
uniform float uScale;
in vec3 aPos;
out vec2 vUv;
void main() {
  vUv = aPos.xy;
  vec4 c = uView * vec4(uCenter, 1.0);
  c.xy += aPos.xy * uScale;
  gl_Position = uProj * c;
}
`;

const HALO_FRAG = /* glsl */ `#version 300 es
precision mediump float;
uniform vec3 uColor;
uniform float uStrength;
in vec2 vUv;
out vec4 outColor;
void main() {
  float r = length(vUv);
  float a = (exp(-r * r * 5.0) * 0.55 + exp(-r * r * 22.0) * 0.45) * uStrength;
  if (a < 0.002) discard;
  outColor = vec4(uColor, a);
}
`;

// ------------------------------------------------------------------ math --
// Column-major mat4 helpers writing into preallocated arrays (no per-frame allocation).

type Mat4 = Float32Array;

function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

function multiply(out: Mat4, a: Mat4, b: Mat4, tmp: Mat4): Mat4 {
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) {
        s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      }
      tmp[c * 4 + r] = s;
    }
  }
  out.set(tmp);
  return out;
}

/** out = T(x, y, z) · Rz(rz) · Rx(rx) · S(1, sy, 1) */
function compose(out: Mat4, x: number, y: number, z: number, rz: number, rx: number, sy: number) {
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  out[0] = cz;
  out[1] = sz;
  out[2] = 0;
  out[3] = 0;
  out[4] = -sz * cx * sy;
  out[5] = cz * cx * sy;
  out[6] = sx * sy;
  out[7] = 0;
  out[8] = sz * sx;
  out[9] = -cz * sx;
  out[10] = cx;
  out[11] = 0;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
  return out;
}

function perspective(out: Mat4, aspect: number) {
  const near = 0.1;
  const far = 60;
  const f = 1 / TAN_HALF_FOV;
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}

/** View matrix for an eye looking at a target with +Y up; also returns the camera basis. */
function lookAt(out: Mat4, eye: Float32Array, target: Float32Array, basis: Float32Array) {
  let fx = (eye[0] as number) - (target[0] as number);
  let fy = (eye[1] as number) - (target[1] as number);
  let fz = (eye[2] as number) - (target[2] as number);
  const fl = Math.hypot(fx, fy, fz);
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = up × forward(back)
  let rx = fz;
  let rz = -fx;
  const rl = Math.hypot(rx, rz);
  rx /= rl;
  rz /= rl;
  const ux = fy * rz;
  const uy = fz * rx - fx * rz;
  const uz = -fy * rx;
  basis.set([rx, 0, rz, ux, uy, uz, -fx, -fy, -fz]);
  const ex = eye[0] as number;
  const ey = eye[1] as number;
  const ez = eye[2] as number;
  out.set([rx, ux, fx, 0, 0, uy, fy, 0, rz, uz, fz, 0]);
  out[12] = -(rx * ex + rz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = -(fx * ex + fy * ey + fz * ez);
  out[15] = 1;
}

function transformPoint(m: Mat4, x: number, y: number, z: number, out: Float32Array) {
  out[0] = (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
  out[1] = (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
  out[2] = (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
}

// ------------------------------------------------------------- geometry --

interface MeshData {
  index: Uint16Array;
  normal: Float32Array;
  pos: Float32Array;
}

/** Surface of revolution around Y from (radius, y, nx, ny) profile samples. */
function lathe(profile: [number, number, number, number][], segments: number): MeshData {
  const rows = profile.length;
  const pos = new Float32Array(rows * (segments + 1) * 3);
  const normal = new Float32Array(pos.length);
  let o = 0;
  for (const [r, y, nr, ny] of profile) {
    for (let s = 0; s <= segments; s += 1) {
      const a = (s / segments) * Math.PI * 2;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      pos.set([r * c, y, r * sn], o);
      normal.set([nr * c, ny, nr * sn], o);
      o += 3;
    }
  }
  const index = new Uint16Array((rows - 1) * segments * 6);
  let k = 0;
  for (let i = 0; i < rows - 1; i += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = i * (segments + 1) + s;
      const b = a + segments + 1;
      index.set([a, b, a + 1, b, b + 1, a + 1], k);
      k += 6;
    }
  }
  return { index, normal, pos };
}

function bellMesh(): MeshData {
  const steps = 20;
  const profile: [number, number, number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * BELL_END;
    profile.push([
      Math.max(0.001, BELL_R * Math.sin(a)),
      -BELL_R * (1 - Math.cos(a)),
      Math.sin(a),
      Math.cos(a),
    ]);
  }
  return lathe(profile, 48);
}

function sphereMesh(radius: number): MeshData {
  const profile: [number, number, number, number][] = [];
  for (let i = 0; i <= 8; i += 1) {
    const a = (i / 8) * Math.PI;
    profile.push([
      Math.max(0.0001, radius * Math.sin(a)),
      radius * Math.cos(a),
      Math.sin(a),
      Math.cos(a),
    ]);
  }
  return lathe(profile, 12);
}

function cylinderMesh(radius: number, height: number): MeshData {
  return lathe(
    [
      [radius, height / 2, 1, 0],
      [radius, -height / 2, 1, 0],
    ],
    16
  );
}

/** Thin torus lying in the XZ plane. */
function torusMesh(radius: number, tube: number): MeshData {
  const profile: [number, number, number, number][] = [];
  for (let i = 0; i <= 6; i += 1) {
    const a = (i / 6) * Math.PI * 2;
    profile.push([radius + tube * Math.cos(a), tube * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  return lathe(profile, 64);
}

function tanzakuMesh() {
  const cols = 4;
  const rows = 24;
  const pos = new Float32Array((cols + 1) * (rows + 1) * 3);
  const uv = new Float32Array((cols + 1) * (rows + 1) * 2);
  let o = 0;
  for (let r = 0; r <= rows; r += 1) {
    for (let c = 0; c <= cols; c += 1) {
      const u = c / cols;
      const v = 1 - r / rows;
      pos.set([(u - 0.5) * TANZAKU_W, -(r / rows) * TANZAKU_H, 0], o * 3);
      uv.set([u, v], o * 2);
      o += 1;
    }
  }
  const index = new Uint16Array(cols * rows * 6);
  let k = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      index.set([a, b, a + 1, b, b + 1, a + 1], k);
      k += 6;
    }
  }
  return { index, pos, uv };
}

function paintTanzaku(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.fillStyle = "#f3ede1";
  ctx.fillRect(0, 0, 256, 1024);
  ctx.fillStyle = "rgba(120,100,70,0.03)";
  for (let i = 0; i < 500; i += 1) {
    ctx.fillRect(
      Math.random() * 256,
      Math.random() * 1024,
      1 + Math.random() * 2,
      6 + Math.random() * 30
    );
  }
  ctx.strokeStyle = "#35b3b0";
  ctx.lineCap = "round";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(28, 800);
  ctx.quadraticCurveTo(128, 760, 230, 700);
  ctx.stroke();
  ctx.fillStyle = "#1c2433";
  ctx.font = '600 118px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("風", 128, 250);
  ctx.fillText("鈴", 128, 420);
  ctx.fillStyle = "#c8553d";
  ctx.fillRect(160, 900, 44, 44);
  ctx.fillStyle = "#f3ede1";
  ctx.font = '700 26px "Hiragino Sans", sans-serif';
  ctx.fillText("F", 182, 923);
  return canvas;
}

const LANES = 6;

function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

/**
 * 75% of particles ride a few coherent "wind lanes" (shared phase + speed per lane,
 * so each lane reads as a ribbon); the rest is sparse, tiny ambient dust.
 */
function makeParticles(count: number, height: number) {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const lanes = Array.from({ length: LANES }, (_, l) => ({
    speed: 0.25 + Math.random() * 0.35,
    width: 0.05 + Math.random() * 0.12,
    y: (l / (LANES - 1) - 0.5) * height * 0.9 + gauss() * 0.2,
    z: -0.6 - Math.random() * 3.2,
  }));
  for (let i = 0; i < count; i += 1) {
    const l = i % LANES;
    const lane = lanes[l] as (typeof lanes)[number];
    pos[i * 3] = (Math.random() - 0.5) * 18;
    if (Math.random() < 0.75) {
      pos[i * 3 + 1] = lane.y + gauss() * lane.width;
      pos[i * 3 + 2] = lane.z + gauss() * 0.25;
      seed.set(
        [
          lane.speed + Math.random() * 0.05,
          l / LANES + Math.random() * 0.015,
          0.25 + Math.random() ** 2 * 0.75,
        ],
        i * 4
      );
    } else {
      pos[i * 3 + 1] = (Math.random() - 0.5) * height * 1.4;
      pos[i * 3 + 2] = 1 - Math.random() * 8;
      seed.set([0.1 + Math.random() * 0.3, Math.random(), Math.random() * 0.22], i * 4);
    }
    seed[i * 4 + 3] = Math.random();
  }
  return { pos, seed };
}

// ------------------------------------------------------------------- gl --

const UNIFORMS = [
  "uView",
  "uProj",
  "uModel",
  "uTime",
  "uPixelRatio",
  "uSize",
  "uPointer",
  "uPointerActive",
  "uAspect",
  "uRipples",
  "uScroll",
  "uColorA",
  "uColorB",
  "uOpacity",
  "uColor",
  "uWind",
  "uMap",
  "uDim",
  "uCam",
  "uEnvLow",
  "uEnvHigh",
  "uTint",
  "uBaseAlpha",
  "uFilm",
  "uCenter",
  "uScale",
  "uStrength",
] as const;
type UniformName = (typeof UNIFORMS)[number];

interface Program {
  attribs: { aNormal: number; aPos: number; aSeed: number; aUv: number };
  handle: WebGLProgram;
  u: Partial<Record<UniformName, WebGLUniformLocation>>;
}

function compileProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  return program;
}

/** Waits for KHR_parallel_shader_compile so linking never blocks the main thread. */
function linked(gl: WebGL2RenderingContext, programs: WebGLProgram[]): Promise<void> {
  const ext = gl.getExtension("KHR_parallel_shader_compile");
  return new Promise((resolve, reject) => {
    const check = () => {
      if (ext && !programs.every((p) => gl.getProgramParameter(p, ext.COMPLETION_STATUS_KHR))) {
        setTimeout(check, 16);
        return;
      }
      const failed = programs.find((p) => !gl.getProgramParameter(p, gl.LINK_STATUS));
      if (failed) {
        reject(new Error(`[chime] ${gl.getProgramInfoLog(failed)}`));
        return;
      }
      resolve();
    };
    check();
  });
}

function describe(gl: WebGL2RenderingContext, handle: WebGLProgram): Program {
  const u: Program["u"] = {};
  for (const name of UNIFORMS) {
    const loc = gl.getUniformLocation(handle, name) ?? gl.getUniformLocation(handle, `${name}[0]`);
    if (loc) {
      u[name] = loc;
    }
  }
  return {
    attribs: {
      aNormal: gl.getAttribLocation(handle, "aNormal"),
      aPos: gl.getAttribLocation(handle, "aPos"),
      aSeed: gl.getAttribLocation(handle, "aSeed"),
      aUv: gl.getAttribLocation(handle, "aUv"),
    },
    handle,
    u,
  };
}

interface Drawable {
  count: number;
  indexed: boolean;
  vao: WebGLVertexArrayObject;
}

// ------------------------------------------------------------------ scene --

/** Ends the current task so hydration, input and paint can run between boot phases. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function createChimeScene(
  canvas: HTMLCanvasElement,
  opts: ChimeSceneOptions
): Promise<ChimeScene> {
  const isHero = opts.variant === "hero";
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
    premultipliedAlpha: true,
  });
  if (!context) {
    throw new Error("[chime] WebGL2 unavailable");
  }
  const gl = context;

  const handles = {
    flat: compileProgram(gl, SOLID_VERT, FLAT_FRAG),
    glass: compileProgram(gl, SOLID_VERT, GLASS_FRAG),
    halo: compileProgram(gl, HALO_VERT, HALO_FRAG),
    particles: compileProgram(gl, PARTICLE_VERT, PARTICLE_FRAG),
    ring: compileProgram(gl, RING_VERT, RING_FRAG),
    tanzaku: compileProgram(gl, TANZAKU_VERT, TANZAKU_FRAG),
  };
  // Each boot phase is its own short task; the driver links the programs in parallel.
  await yieldToMain();
  const particleData = makeParticles(opts.particleCount, 6);
  await yieldToMain();
  const paper = paintTanzaku();
  await linked(gl, Object.values(handles));
  const P = {
    flat: describe(gl, handles.flat),
    glass: describe(gl, handles.glass),
    halo: describe(gl, handles.halo),
    particles: describe(gl, handles.particles),
    ring: describe(gl, handles.ring),
    tanzaku: describe(gl, handles.tanzaku),
  };

  const buffers: WebGLBuffer[] = [];
  const vaos: WebGLVertexArrayObject[] = [];
  function attrib(loc: number, data: Float32Array, size: number) {
    if (loc < 0) {
      return;
    }
    const buf = gl.createBuffer() as WebGLBuffer;
    buffers.push(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }
  function drawable(
    program: Program,
    attrs: { normal?: Float32Array; pos: Float32Array; seed?: Float32Array; uv?: Float32Array },
    index: Uint16Array | null
  ): Drawable {
    const vao = gl.createVertexArray() as WebGLVertexArrayObject;
    vaos.push(vao);
    gl.bindVertexArray(vao);
    attrib(program.attribs.aPos, attrs.pos, 3);
    if (attrs.normal) {
      attrib(program.attribs.aNormal, attrs.normal, 3);
    }
    if (attrs.seed) {
      attrib(program.attribs.aSeed, attrs.seed, 4);
    }
    if (attrs.uv) {
      attrib(program.attribs.aUv, attrs.uv, 2);
    }
    if (index) {
      const ib = gl.createBuffer() as WebGLBuffer;
      buffers.push(ib);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
    }
    gl.bindVertexArray(null);
    return { count: index ? index.length : attrs.pos.length / 3, indexed: Boolean(index), vao };
  }

  const bellData = bellMesh();
  const clapperData = cylinderMesh(0.035, 0.16);
  const knotData = sphereMesh(0.035);
  const rimData = torusMesh(MOUTH_R, 0.011);
  const tanzakuData = tanzakuMesh();
  const quad = new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
  const H = RING_HALF;
  const D = {
    bell: drawable(P.glass, bellData, bellData.index),
    clapper: drawable(P.glass, clapperData, clapperData.index),
    halo: drawable(P.halo, { pos: quad }, null),
    knot: drawable(P.flat, knotData, knotData.index),
    line: drawable(
      P.flat,
      { normal: new Float32Array(6), pos: new Float32Array([0, 0, 0, 0, -1, 0]) },
      null
    ),
    particles: drawable(P.particles, { pos: particleData.pos, seed: particleData.seed }, null),
    rim: drawable(P.flat, rimData, rimData.index),
    ring: drawable(
      P.ring,
      { pos: new Float32Array([-H, -H, 0, H, -H, 0, -H, H, 0, H, H, 0]) },
      null
    ),
    tanzaku: drawable(P.tanzaku, { pos: tanzakuData.pos, uv: tanzakuData.uv }, tanzakuData.index),
  };

  await yieldToMain();
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, paper);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // ---- state
  let theme: ChimeTheme = opts.theme;
  const clock = { elapsed: 0, last: performance.now() };
  const maxDpr = isHero ? 1.5 : 2;
  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const ripples = new Float32Array(RIPPLE_SLOTS * 4).fill(-100);
  let rippleCursor = 0;
  let lastRipple = -100;
  const sim = {
    ax: 0,
    az: 0,
    cvx: 0,
    cvz: 0,
    cx: 0,
    cz: 0,
    lastStrike: -10,
    vx: 0,
    vz: 0,
    wind: 0,
  };
  let scroll = 0;
  let lastScroll = 0;
  const pointer = { active: 0, lastX: 0, target: 0, vx: 0, x: 10, y: 10 };
  let pulse = 0;
  let aspect = 1;
  let cameraBaseZ = 7;
  const chimeBase = new Float32Array(3);

  // preallocated matrices/vectors
  const view = mat4();
  const proj = mat4();
  const tmp = mat4();
  const root = mat4();
  const swing = mat4();
  const local = mat4();
  const model = mat4();
  const clapperPivot = mat4();
  const eye = new Float32Array(3);
  const target = new Float32Array(3);
  const basis = new Float32Array(9);
  const point = new Float32Array(3);

  function layout() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    aspect = w / h;
    if (isHero) {
      const wide = aspect > 1.1;
      cameraBaseZ = wide ? 7 : 11;
      const visH = 2 * cameraBaseZ * TAN_HALF_FOV;
      chimeBase.set([wide ? Math.min(visH * aspect * 0.24, 2.6) : 0, wide ? 0.55 : visH * 0.29, 0]);
    } else {
      cameraBaseZ = 5;
      chimeBase.set([0, -0.05, 0]);
    }
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    perspective(proj, aspect);
  }
  layout();

  function toNdcX(clientX: number, rect: DOMRect) {
    return ((clientX - rect.left) / rect.width) * 2 - 1;
  }
  function toNdcY(clientY: number, rect: DOMRect) {
    return -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  function addRipple(x: number, y: number, z: number, strength: number) {
    ripples.set([x, y, z, clock.elapsed], rippleCursor * 4);
    rippleCursor = (rippleCursor + 1) % RIPPLE_SLOTS;
    lastRipple = clock.elapsed;
    pulse = Math.max(pulse, strength);
  }

  function bellCenter() {
    transformPoint(swing, 0, -THREAD_LEN - 0.25, 0, point);
  }

  function step(dt: number) {
    const t = clock.elapsed;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.21) * Math.sin(t * 0.13 + 1.7);
    const scrollV = (scroll - lastScroll) / Math.max(dt, 1e-3);
    lastScroll = scroll;
    sim.wind +=
      ((0.35 + gust * 0.9) * (0.6 + 0.4 * Math.sin(t * 1.1)) +
        Math.abs(scrollV) * 0.6 +
        Math.abs(pointer.vx) * 0.02 -
        sim.wind) *
      Math.min(1, dt * 1.5);
    const windForce =
      sim.wind * (0.18 * Math.sin(t * 0.83) + 0.1 * Math.sin(t * 2.1 + 0.6) + 0.12) +
      pointer.vx * 0.004 * pointer.active;

    sim.vx += (-9 * sim.ax - 1.1 * sim.vx + windForce) * dt;
    sim.vz += (-9 * sim.az - 1.1 * sim.vz + sim.wind * 0.05 * Math.sin(t * 0.61 + 2)) * dt;
    sim.ax += sim.vx * dt;
    sim.az += sim.vz * dt;

    const tanzakuWind = sim.wind * (0.55 + 0.45 * Math.sin(t * 1.7)) * 0.9;
    sim.cvx += (-5.2 * sim.cx - 0.9 * sim.cvx - sim.vx * 0.8 + tanzakuWind * 0.5) * dt;
    sim.cvz += (-5.2 * sim.cz - 0.9 * sim.cvz + tanzakuWind * 0.15 * Math.cos(t * 0.9)) * dt;
    sim.cx += sim.cvx * dt;
    sim.cz += sim.cvz * dt;

    if (Math.hypot(sim.cx, sim.cz) > 0.11 && t - sim.lastStrike > 5) {
      sim.lastStrike = t;
      sim.cvx *= -0.5;
      sim.cvz *= -0.5;
      bellCenter();
      addRipple(point[0] as number, point[1] as number, point[2] as number, 0.35);
    }

    pointer.active += (pointer.target - pointer.active) * Math.min(1, dt * 4);
    pointer.vx *= 0.9;
    pulse *= Math.exp(-dt * 2.2);
  }

  function pose() {
    const clampA = (a: number) => Math.max(-0.5, Math.min(0.5, a));
    const s = isHero ? scroll : 0;
    compose(root, chimeBase[0] as number, (chimeBase[1] as number) + 1.4 + s * 0.8, 0, 0, 0, 1);
    compose(local, 0, 0, 0, clampA(sim.ax), clampA(sim.az), 1);
    multiply(swing, root, local, tmp);
    compose(local, 0, -THREAD_LEN - 0.02, 0, clampA(sim.cx), clampA(sim.cz), 1);
    multiply(clapperPivot, swing, local, tmp);
    eye.set([s * -0.3, s * 0.35, cameraBaseZ + s * 3.2]);
    target.set([s * -0.3, s * 0.2, 0]);
    lookAt(view, eye, target, basis);
  }

  /** Binds a program and its camera matrices; returns a typed uniform-location getter. */
  function bindProgram(p: Program) {
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a React hook.
    gl.useProgram(p.handle);
    gl.uniformMatrix4fv(p.u.uView ?? null, false, view);
    gl.uniformMatrix4fv(p.u.uProj ?? null, false, proj);
    return (name: UniformName) => p.u[name] ?? null;
  }

  function drawMesh(d: Drawable, mode: number) {
    gl.bindVertexArray(d.vao);
    if (d.indexed) {
      gl.drawElements(mode, d.count, gl.UNSIGNED_SHORT, 0);
    } else {
      gl.drawArrays(mode, 0, d.count);
    }
  }

  function withModel(
    p: Program,
    parent: Mat4,
    x: number,
    y: number,
    z: number,
    rz: number,
    sy: number
  ) {
    compose(local, x, y, z, rz, 0, sy);
    multiply(model, parent, local, tmp);
    gl.uniformMatrix4fv(p.u.uModel ?? null, false, model);
  }

  function blend(additive: boolean) {
    if (additive) {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
    } else {
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
  }

  type Palette = (typeof PALETTES)[ChimeTheme];

  /** Additive glow behind the bell (dark theme): stands in for bloom and pulses on ring. */
  function drawHalo(pal: Palette) {
    const strength = pal.halo * (isHero ? 1 : 0.8) + pulse * 0.9;
    if (!pal.additive || strength < 0.01) {
      return;
    }
    gl.depthMask(false);
    blend(true);
    const u = bindProgram(P.halo);
    gl.uniform3fv(u("uCenter"), point);
    gl.uniform1f(u("uScale"), 1.25 + pulse * 0.35);
    gl.uniform1f(u("uStrength"), strength * 0.22);
    gl.uniform3fv(u("uColor"), pal.rim);
    drawMesh(D.halo, gl.TRIANGLE_STRIP);
  }

  /** Paper strip, rim, knot and threads: depth-writing, drawn before the transparent layers. */
  function drawOpaque(pal: Palette, time: number) {
    gl.depthMask(true);
    blend(false);
    const t = bindProgram(P.tanzaku);
    gl.uniform1f(t("uTime"), time);
    gl.uniform1f(t("uWind"), Math.min(1.2, sim.wind * 0.7 + Math.abs(sim.cvx) * 0.6));
    gl.uniform1f(t("uDim"), pal.paper);
    gl.uniform1i(t("uMap"), 0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    withModel(
      P.tanzaku,
      clapperPivot,
      0,
      -CLAPPER_STRING,
      0,
      Math.max(-0.5, Math.min(0.5, sim.cx * 0.6)),
      1
    );
    drawMesh(D.tanzaku, gl.TRIANGLES);

    const f = bindProgram(P.flat);
    gl.uniform4f(f("uColor"), pal.rim[0], pal.rim[1], pal.rim[2], 1);
    withModel(P.flat, swing, 0, MOUTH_Y, 0, 0, 1);
    drawMesh(D.rim, gl.TRIANGLES);
    withModel(P.flat, swing, 0, -THREAD_LEN + 0.01, 0, 0, 1);
    drawMesh(D.knot, gl.TRIANGLES);
    gl.uniform4f(f("uColor"), pal.thread[0], pal.thread[1], pal.thread[2], 0.6);
    withModel(P.flat, root, 0, 8, 0, 0, 8);
    drawMesh(D.line, gl.LINES);
    withModel(P.flat, swing, 0, 0, 0, 0, THREAD_LEN);
    drawMesh(D.line, gl.LINES);
    withModel(P.flat, clapperPivot, 0, 0, 0, 0, CLAPPER_STRING);
    drawMesh(D.line, gl.LINES);
  }

  /** Wind particles: depth-tested against the opaque parts, no depth write. */
  function drawParticles(pal: Palette, time: number) {
    gl.depthMask(false);
    blend(pal.additive);
    const u = bindProgram(P.particles);
    gl.uniform1f(u("uTime"), time);
    gl.uniform1f(u("uPixelRatio"), dpr);
    gl.uniform1f(u("uSize"), isHero ? 5.4 : 4.2);
    gl.uniform2f(u("uPointer"), pointer.x, pointer.y);
    gl.uniform1f(u("uPointerActive"), pointer.active);
    gl.uniform1f(u("uAspect"), aspect);
    gl.uniform4fv(u("uRipples"), ripples);
    gl.uniform1f(u("uScroll"), isHero ? scroll : 0);
    gl.uniform3fv(u("uColorA"), pal.particleA);
    gl.uniform3fv(u("uColorB"), pal.particleB);
    gl.uniform1f(u("uOpacity"), pal.particleOpacity);
    drawMesh(D.particles, gl.POINTS);
  }

  /** Glass: back faces then front faces, no depth write so both layers show. */
  function drawGlass(pal: Palette) {
    gl.enable(gl.CULL_FACE);
    const u = bindProgram(P.glass);
    gl.uniform3fv(u("uCam"), eye);
    gl.uniform3fv(u("uEnvLow"), pal.envLow);
    gl.uniform3fv(u("uEnvHigh"), pal.envHigh);
    gl.uniform3fv(u("uTint"), pal.glassTint);
    gl.uniform1f(u("uBaseAlpha"), pal.glassAlpha);
    gl.uniform1f(u("uFilm"), pal.film);
    for (const face of [gl.FRONT, gl.BACK]) {
      gl.cullFace(face);
      withModel(P.glass, clapperPivot, 0, MOUTH_Y + THREAD_LEN + 0.07, 0, 0, 1);
      drawMesh(D.clapper, gl.TRIANGLES);
      withModel(P.glass, swing, 0, -THREAD_LEN, 0, 0, 1);
      drawMesh(D.bell, gl.TRIANGLES);
    }
    gl.disable(gl.CULL_FACE);
  }

  /** Ripple ring: only while one is alive (saves a full-screen pass otherwise). */
  function drawRing(pal: Palette, time: number) {
    if (time - lastRipple >= RIPPLE_LIFE) {
      return;
    }
    gl.disable(gl.DEPTH_TEST);
    blend(pal.additive);
    const u = bindProgram(P.ring);
    gl.uniform1f(u("uTime"), time);
    gl.uniform4fv(u("uRipples"), ripples);
    gl.uniform3fv(u("uColor"), pal.ring);
    drawMesh(D.ring, gl.TRIANGLE_STRIP);
  }

  let firstFrame = false;
  function draw() {
    pose();
    bellCenter();
    const pal = PALETTES[theme];
    const time = clock.elapsed;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT + gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    drawHalo(pal);
    drawOpaque(pal, time);
    drawParticles(pal, time);
    drawGlass(pal);
    drawRing(pal, time);
    gl.bindVertexArray(null);
    if (!firstFrame) {
      firstFrame = true;
      opts.onFirstFrame();
    }
  }

  // ---- adaptive quality: step the pixel ratio down if frames run long
  const perf = { acc: 0, frames: 0 };
  function adapt(frameMs: number) {
    perf.acc += frameMs;
    perf.frames += 1;
    if (perf.frames < 90) {
      return;
    }
    const avg = perf.acc / perf.frames;
    perf.acc = 0;
    perf.frames = 0;
    if (avg > 22 && dpr > 1) {
      dpr = Math.max(1, dpr - 0.25);
      layout();
    }
  }

  let running = false;
  let active = false;
  let raf = 0;
  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    const frameMs = now - clock.last;
    const dt = Math.min(frameMs / 1000, 1 / 30);
    clock.last = now;
    clock.elapsed += dt;
    step(dt);
    draw();
    adapt(frameMs);
  }
  function syncLoop() {
    const shouldRun = opts.animate && active && document.visibilityState === "visible";
    if (shouldRun && !running) {
      running = true;
      clock.last = performance.now();
      raf = requestAnimationFrame(frame);
    } else if (!shouldRun && running) {
      running = false;
      cancelAnimationFrame(raf);
    }
  }
  function renderStatic() {
    if (!running) {
      draw();
    }
  }
  const onVisibility = () => syncLoop();
  document.addEventListener("visibilitychange", onVisibility);

  // Settle the pendulum a bit so a static (reduced-motion) render isn't dead-center.
  sim.ax = 0.06;
  sim.cx = -0.04;
  await yieldToMain();
  draw();

  return {
    clearPointer() {
      pointer.target = 0;
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      for (const b of buffers) {
        gl.deleteBuffer(b);
      }
      for (const v of vaos) {
        gl.deleteVertexArray(v);
      }
      for (const p of Object.values(handles)) {
        gl.deleteProgram(p);
      }
      gl.deleteTexture(texture);
    },
    resize() {
      layout();
      renderStatic();
    },
    ring(strength, clientX, clientY) {
      if (!opts.animate) {
        return;
      }
      if (clientX === undefined || clientY === undefined) {
        bellCenter();
        addRipple(point[0] as number, point[1] as number, point[2] as number, strength);
      } else {
        // Intersect the click ray with the z = 0 plane (allocation-free).
        const rect = canvas.getBoundingClientRect();
        const sx = toNdcX(clientX, rect) * TAN_HALF_FOV * aspect;
        const sy = toNdcY(clientY, rect) * TAN_HALF_FOV;
        const dx = (basis[0] as number) * sx + (basis[3] as number) * sy + (basis[6] as number);
        const dy = (basis[1] as number) * sx + (basis[4] as number) * sy + (basis[7] as number);
        const dz = (basis[2] as number) * sx + (basis[5] as number) * sy + (basis[8] as number);
        const t = -(eye[2] as number) / dz;
        addRipple((eye[0] as number) + dx * t, (eye[1] as number) + dy * t, 0, strength);
      }
      sim.vx += (Math.random() > 0.5 ? 1 : -1) * 0.55 * strength;
      sim.vz += 0.25 * strength;
      sim.cvx += 1.4 * strength;
      sim.lastStrike = clock.elapsed;
    },
    setActive(next) {
      active = next;
      syncLoop();
    },
    setPointer(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      const x = toNdcX(clientX, rect);
      pointer.vx = pointer.vx * 0.6 + (x - pointer.lastX) * 60 * 0.4;
      pointer.lastX = x;
      pointer.x = x;
      pointer.y = toNdcY(clientY, rect);
      pointer.target = 1;
    },
    setScroll(progress) {
      scroll = progress;
      renderStatic();
    },
    setTheme(next) {
      theme = next;
      renderStatic();
    },
  };
}
