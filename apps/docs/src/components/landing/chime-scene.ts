/**
 * Procedural 風鈴 (wind chime) scene. Browser-only: imported lazily from
 * chime-canvas.tsx so neither three.js nor WebGL is touched during SSR/SSG.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  NormalBlending,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

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

const TEAL = new Color("#4fc9c6");
const BG_DARK = new Color("#080d18");
const PALETTES = {
  dark: {
    attenuation: "#bfeeee",
    env: 0.7,
    glass: "#ffffff",
    paper: 0.74,
    particleA: "#4fc9c6",
    particleB: "#dbe8ff",
    particleOpacity: 1,
    rim: "#5fe0dc",
    ring: "#6fe3df",
    thread: "#c9d4e3",
  },
  light: {
    attenuation: "#8fd6d4",
    env: 1.1,
    glass: "#eaf7f7",
    paper: 1,
    particleA: "#138a88",
    particleB: "#44546e",
    particleOpacity: 0.55,
    rim: "#1a9c99",
    ring: "#0f8583",
    thread: "#5b6778",
  },
} as const;
const RIPPLE_SLOTS = 3;
const RIPPLE_LIFE = 2.6;

// ---------------------------------------------------------------- shaders --

const PARTICLE_VERT = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uAspect;
uniform float uTanHalfFov;
uniform vec4 uRipples[${RIPPLE_SLOTS}];
uniform float uScroll;
attribute vec4 aSeed;
varying float vAlpha;
varying float vRipple;
varying float vTint;

void main() {
  vec3 p = position;
  float speed = aSeed.x;
  // Wind streamlines: drift left→right and wrap; y undulates along the stream.
  p.x = mod(p.x + uTime * speed + 9.0, 18.0) - 9.0;
  // aSeed.y is shared per lane, so whole lanes undulate together and read as wisps
  float wave = sin(p.x * 0.42 + aSeed.y * 6.2831 + uTime * 0.3);
  p.y += wave * (0.3 + aSeed.y * 0.35) + sin(p.x * 1.3 + uTime * 0.7 + aSeed.y * 9.0) * 0.08;
  p.z += cos(p.x * 0.4 + aSeed.w * 6.2831) * 0.3;

  // Ripples: a spherical shockwave pushing particles outward.
  float ripple = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i += 1) {
    vec4 r = uRipples[i];
    float age = uTime - r.w;
    if (age > 0.0 && age < ${RIPPLE_LIFE.toFixed(1)}) {
      vec3 d = p - r.xyz;
      d.z *= 0.6;
      float dist = length(d);
      float radius = age * 3.2;
      float band = exp(-pow((dist - radius) / 0.35, 2.0)) * (1.0 - age / ${RIPPLE_LIFE.toFixed(1)});
      p += normalize(d + 1e-4) * band * 0.45;
      ripple += band;
    }
  }

  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  // Cursor vortex, evaluated in view space so it tracks the pointer at every depth.
  float depth = -mv.z;
  vec2 pointerView = uPointer * vec2(uAspect, 1.0) * uTanHalfFov * depth;
  vec2 toP = pointerView - mv.xy;
  float r2 = dot(toP, toP);
  float fall = exp(-r2 / (0.9 + depth * 0.12)) * uPointerActive;
  mv.xy += toP * fall * 0.32 + vec2(-toP.y, toP.x) * fall * 0.22;

  gl_Position = projectionMatrix * mv;
  float size = uSize * (0.35 + aSeed.z * 0.9) * (1.0 + ripple * 1.6 + fall * 0.8);
  gl_PointSize = size * uPixelRatio * (7.0 / depth);

  float fadeX = 1.0 - smoothstep(6.5, 9.0, abs(p.x));
  float twinkle = 0.65 + 0.35 * sin(uTime * (1.0 + aSeed.y * 2.0) + aSeed.w * 40.0);
  vAlpha = fadeX * twinkle * (1.0 - smoothstep(4.0, 18.0, depth)) * (1.0 - uScroll * 0.5) * (0.25 + aSeed.z);
  vRipple = ripple + fall * 0.6;
  vTint = aSeed.y;
}
`;

const PARTICLE_FRAG = /* glsl */ `
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
varying float vAlpha;
varying float vRipple;
varying float vTint;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float disc = 1.0 - smoothstep(0.0, 0.5, d);
  disc *= disc;
  vec3 col = mix(uColorA, uColorB, vTint);
  col += uColorA * vRipple * 1.4;
  float a = disc * vAlpha * uOpacity * (0.4 + vRipple * 1.4);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}
`;

const RING_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv * 2.0 - 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAG = /* glsl */ `
uniform float uTime;
uniform vec4 uRipples[${RIPPLE_SLOTS}];
uniform vec3 uColor;
uniform float uHalf;
varying vec2 vUv;
void main() {
  vec2 world = vUv * uHalf;
  float a = 0.0;
  for (int i = 0; i < ${RIPPLE_SLOTS}; i += 1) {
    vec4 r = uRipples[i];
    float age = uTime - r.w;
    if (age > 0.0 && age < ${RIPPLE_LIFE.toFixed(1)}) {
      float dist = length(world - r.xy);
      float radius = age * 3.2;
      float life = 1.0 - age / ${RIPPLE_LIFE.toFixed(1)};
      float ring = exp(-pow((dist - radius) / 0.018, 2.0));
      float halo = exp(-pow((dist - radius) / 0.22, 2.0)) * 0.18;
      // a fainter echo trailing behind the main front
      float echo = exp(-pow((dist - radius * 0.72) / 0.012, 2.0)) * 0.35;
      a += (ring + halo + echo) * life * life;
    }
  }
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

const TANZAKU_VERT = /* glsl */ `
uniform float uTime;
uniform float uWind;
varying vec2 vUv;
varying float vShade;
void main() {
  vUv = uv;
  vec3 p = position;
  float d = 1.0 - uv.y;
  float phase = d * 5.5 - uTime * 3.4 + p.x * 3.0;
  float amp = d * d * (0.5 + uWind * 1.5);
  p.z += sin(phase) * 0.07 * amp + sin(d * 11.0 - uTime * 6.3) * 0.012 * d;
  p.z += uWind * d * d * 0.22;
  float tw = sin(uTime * 1.25 + d * 2.2) * 0.35 * d * (0.4 + uWind);
  float c = cos(tw);
  float s = sin(tw);
  p.xz = mat2(c, -s, s, c) * p.xz;
  vShade = 0.82 + 0.18 * cos(phase) * d;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const TANZAKU_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uDim;
varying vec2 vUv;
varying float vShade;
void main() {
  vec4 tex = texture2D(uMap, vUv);
  float back = gl_FrontFacing ? 1.0 : 0.78;
  gl_FragColor = vec4(tex.rgb * vShade * back * uDim, 1.0);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------- helpers --

function paintTanzaku(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1024;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  // washi paper
  ctx.fillStyle = "#f3ede1";
  ctx.fillRect(0, 0, 256, 1024);
  for (let i = 0; i < 1400; i += 1) {
    ctx.fillStyle = `rgba(120,100,70,${Math.random() * 0.05})`;
    ctx.fillRect(
      Math.random() * 256,
      Math.random() * 1024,
      1 + Math.random() * 2,
      6 + Math.random() * 30
    );
  }
  // teal brush stroke (echoes the diagonal in the logo's tanzaku)
  ctx.strokeStyle = "#35b3b0";
  ctx.lineCap = "round";
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.moveTo(28, 800);
  ctx.quadraticCurveTo(128, 760, 230, 700);
  ctx.stroke();
  // calligraphy
  ctx.fillStyle = "#1c2433";
  ctx.font = '600 118px "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("風", 128, 250);
  ctx.fillText("鈴", 128, 420);
  // hanko seal
  ctx.fillStyle = "#c8553d";
  ctx.fillRect(160, 900, 44, 44);
  ctx.fillStyle = "#f3ede1";
  ctx.font = '700 26px "Hiragino Sans", sans-serif';
  ctx.fillText("F", 182, 923);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function bellProfile(): Vector2[] {
  const pts: Vector2[] = [];
  const radius = 0.46;
  const steps = 40;
  const end = Math.PI * 0.6;
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * end;
    pts.push(new Vector2(Math.max(0.001, radius * Math.sin(a)), -radius * (1 - Math.cos(a))));
  }
  return pts;
}

const LANES = 6;

function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

/**
 * 75% of particles ride a few coherent "wind lanes" (shared phase + speed per lane,
 * so each lane reads as a ribbon); the rest is sparse, tiny ambient dust.
 */
function makeParticles(count: number, height: number): BufferGeometry {
  const geo = new BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count * 4);
  const lanes = Array.from({ length: LANES }, (_, l) => ({
    speed: 0.25 + Math.random() * 0.35,
    width: 0.05 + Math.random() * 0.12,
    y: (l / (LANES - 1) - 0.5) * height * 0.9 + gauss() * 0.2,
    z: -0.6 - Math.random() * 3.2,
  }));
  for (let i = 0; i < count; i += 1) {
    const inLane = Math.random() < 0.75;
    const l = i % LANES;
    const lane = lanes[l] as (typeof lanes)[number];
    pos[i * 3] = (Math.random() - 0.5) * 18;
    if (inLane) {
      pos[i * 3 + 1] = lane.y + gauss() * lane.width;
      pos[i * 3 + 2] = lane.z + gauss() * 0.25;
      seed[i * 4] = lane.speed + Math.random() * 0.05;
      seed[i * 4 + 1] = l / LANES + Math.random() * 0.015;
      seed[i * 4 + 2] = 0.25 + Math.random() ** 2 * 0.75;
    } else {
      pos[i * 3 + 1] = (Math.random() - 0.5) * height * 1.4;
      pos[i * 3 + 2] = 1 - Math.random() * 8;
      seed[i * 4] = 0.1 + Math.random() * 0.3;
      seed[i * 4 + 1] = Math.random();
      seed[i * 4 + 2] = Math.random() * 0.22;
    }
    seed[i * 4 + 3] = Math.random();
  }
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new BufferAttribute(seed, 4));
  return geo;
}

// ------------------------------------------------------------------ scene --

/** Ends the current task so hydration, input and paint can run between setup phases. */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function createChimeScene(
  canvas: HTMLCanvasElement,
  opts: ChimeSceneOptions
): Promise<ChimeScene> {
  const isHero = opts.variant === "hero";
  const renderer = new WebGLRenderer({
    alpha: true,
    antialias: true,
    canvas,
    powerPreference: "high-performance",
  });
  const maxDpr = isHero ? 1.75 : 2;
  let dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  renderer.setPixelRatio(dpr);
  renderer.setClearColor(0x00_00_00, 0);
  // Skip the per-program info-log reads on first use: they are synchronous GPU round-trips
  // (the bulk of the first-frame stall) and these shaders are static. Flip to true when
  // editing a shader to get compile errors in the console.
  renderer.debug.checkShaderErrors = false;

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  // 128px is plenty for a bell that covers a few hundred pixels (default 256 is 4x the work).
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04, 0.1, 100, { size: 128 });
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.7;
  await yieldToMain();

  const camera = new PerspectiveCamera(35, 1, 0.1, 60);
  camera.position.set(0, 0, 7);

  let theme: ChimeTheme = opts.theme;
  const clock = { elapsed: 0, last: performance.now(), start: performance.now() };

  // ---- chime
  const root = new Group();
  scene.add(root);

  const threadMat = new MeshBasicMaterial({ color: 0xc9_d4_e3, opacity: 0.55, transparent: true });
  const upperThread = new Mesh(new CylinderGeometry(0.0045, 0.0045, 8, 6), threadMat);
  upperThread.position.y = 4;
  root.add(upperThread);

  const swing = new Group();
  root.add(swing);

  const THREAD_LEN = 0.55;
  const lowerThread = new Mesh(new CylinderGeometry(0.0045, 0.0045, THREAD_LEN, 6), threadMat);
  lowerThread.position.y = -THREAD_LEN / 2;
  swing.add(lowerThread);

  const bellMat = new MeshPhysicalMaterial({
    attenuationColor: new Color("#bfeeee"),
    attenuationDistance: 1.4,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    color: 0xff_ff_ff,
    envMapIntensity: 0.9,
    ior: 1.45,
    iridescence: 1,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [180, 520],
    metalness: 0,
    roughness: 0.04,
    side: DoubleSide,
    specularIntensity: 1,
    thickness: 0.35,
    transmission: 1,
    transparent: false,
  });
  const bell = new Mesh(new LatheGeometry(bellProfile(), 96), bellMat);
  bell.position.y = -THREAD_LEN;
  swing.add(bell);

  const mouthY = -THREAD_LEN - 0.46 * (1 - Math.cos(Math.PI * 0.6));
  const mouthR = 0.46 * Math.sin(Math.PI * 0.6);
  const rimMat = new MeshBasicMaterial({ color: TEAL.clone().multiplyScalar(1.25) });
  const rim = new Mesh(new TorusGeometry(mouthR, 0.011, 10, 128), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = mouthY;
  swing.add(rim);

  const knot = new Mesh(new SphereGeometry(0.035, 16, 12), rimMat);
  knot.position.y = -THREAD_LEN + 0.01;
  swing.add(knot);

  // clapper + tanzaku hang from a lagged pivot at the top of the bell
  const clapperPivot = new Group();
  clapperPivot.position.y = -THREAD_LEN - 0.02;
  swing.add(clapperPivot);

  const CLAPPER_STRING = 0.95;
  const clapperString = new Mesh(new CylinderGeometry(0.003, 0.003, CLAPPER_STRING, 6), threadMat);
  clapperString.position.y = -CLAPPER_STRING / 2;
  clapperPivot.add(clapperString);

  const clapperMat = new MeshPhysicalMaterial({
    color: 0xe8_fb_ff,
    envMapIntensity: 1.2,
    ior: 1.5,
    iridescence: 0.6,
    roughness: 0.1,
    thickness: 0.2,
    transmission: 0.9,
  });
  const clapper = new Mesh(new CylinderGeometry(0.035, 0.035, 0.16, 24), clapperMat);
  clapper.position.y = mouthY + THREAD_LEN + 0.07;
  clapperPivot.add(clapper);

  const tanzakuPivot = new Group();
  tanzakuPivot.position.y = -CLAPPER_STRING;
  clapperPivot.add(tanzakuPivot);

  const TANZAKU_W = 0.3;
  const TANZAKU_H = 1.12;
  const tanzakuGeo = new PlaneGeometry(TANZAKU_W, TANZAKU_H, 6, 40);
  tanzakuGeo.translate(0, -TANZAKU_H / 2, 0);
  const tanzakuTex = paintTanzaku();
  const tanzakuUniforms = {
    uDim: { value: 0.92 },
    uMap: { value: tanzakuTex },
    uTime: { value: 0 },
    uWind: { value: 0 },
  };
  const tanzaku = new Mesh(
    tanzakuGeo,
    new ShaderMaterial({
      fragmentShader: TANZAKU_FRAG,
      side: DoubleSide,
      uniforms: tanzakuUniforms,
      vertexShader: TANZAKU_VERT,
    })
  );
  tanzakuPivot.add(tanzaku);

  // ---- ripples (shared by particles + ring quad)
  const ripples = Array.from({ length: RIPPLE_SLOTS }, () => new Vector4(0, 0, 0, -100));
  let rippleCursor = 0;

  const RING_HALF = 9;
  const ringUniforms = {
    uColor: { value: TEAL.clone() },
    uHalf: { value: RING_HALF },
    uRipples: { value: ripples },
    uTime: { value: 0 },
  };
  const ringQuad = new Mesh(
    new PlaneGeometry(RING_HALF * 2, RING_HALF * 2),
    new ShaderMaterial({
      blending: AdditiveBlending,
      depthWrite: false,
      fragmentShader: RING_FRAG,
      transparent: true,
      uniforms: ringUniforms,
      vertexShader: RING_VERT,
    })
  );
  ringQuad.renderOrder = 2;
  scene.add(ringQuad);

  // ---- particles
  const particleUniforms = {
    uAspect: { value: 1 },
    uColorA: { value: TEAL.clone() },
    uColorB: { value: new Color("#dbe8ff") },
    uOpacity: { value: 1 },
    uPixelRatio: { value: dpr },
    uPointer: { value: new Vector2(10, 10) },
    uPointerActive: { value: 0 },
    uRipples: { value: ripples },
    uScroll: { value: 0 },
    uSize: { value: isHero ? 3.2 : 2.6 },
    uTanHalfFov: { value: Math.tan((camera.fov * Math.PI) / 360) },
    uTime: { value: 0 },
  };
  const particleMat = new ShaderMaterial({
    blending: AdditiveBlending,
    depthWrite: false,
    fragmentShader: PARTICLE_FRAG,
    transparent: true,
    uniforms: particleUniforms,
    vertexShader: PARTICLE_VERT,
  });
  const particles = new Points(makeParticles(opts.particleCount, 6), particleMat);
  particles.frustumCulled = false;
  scene.add(particles);

  // ---- post-processing (dark theme only; bloom on light backgrounds just washes out)
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(256, 256), 0.35, 0.5, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  let bloomEnabled = isHero;
  const BLOOM_BASE = 0.32;

  function applyTheme() {
    const pal = PALETTES[theme];
    const blending = theme === "dark" ? AdditiveBlending : NormalBlending;
    const ringMat = ringQuad.material as ShaderMaterial;
    particleMat.blending = blending;
    particleMat.needsUpdate = true;
    ringMat.blending = blending;
    ringMat.needsUpdate = true;
    particleUniforms.uColorA.value.set(pal.particleA);
    particleUniforms.uColorB.value.set(pal.particleB);
    particleUniforms.uOpacity.value = pal.particleOpacity;
    ringUniforms.uColor.value.set(pal.ring);
    threadMat.color.set(pal.thread);
    rimMat.color.set(pal.rim);
    bellMat.attenuationColor.set(pal.attenuation);
    bellMat.color.set(pal.glass);
    tanzakuUniforms.uDim.value = pal.paper;
    scene.environmentIntensity = pal.env;
    // Bloom needs an opaque backdrop (UnrealBloom does not preserve alpha). Use
    // scene.background rather than setClearColor: the latter is resolved against the
    // canvas color space and would be sRGB-encoded twice inside the composer's linear target.
    scene.background = theme === "dark" && bloomEnabled ? BG_DARK : null;
  }
  applyTheme();

  // ---- layout
  const chimeBase = new Vector3();
  let cameraBaseZ = 7;
  function layout() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    const aspect = w / h;
    camera.aspect = aspect;
    if (isHero) {
      const wide = aspect > 1.1;
      cameraBaseZ = wide ? 7 : 11;
      const visH = 2 * cameraBaseZ * Math.tan((camera.fov * Math.PI) / 360);
      // wide: chime sits in the right third; narrow: centered in the top area
      chimeBase.set(wide ? Math.min(visH * aspect * 0.24, 2.6) : 0, wide ? 0.55 : visH * 0.29, 0);
    } else {
      cameraBaseZ = 5;
      chimeBase.set(0, -0.05, 0);
    }
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    particleUniforms.uAspect.value = aspect;
  }
  layout();

  // ---- physics state: bell swing (x/z) + lagged clapper/tanzaku
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
  let bloomPulse = 0;

  function toNdc(clientX: number, clientY: number): Vector2 {
    const rect = canvas.getBoundingClientRect();
    return new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  function ndcToWorldZ0(ndc: Vector2): Vector3 {
    const v = new Vector3(ndc.x, ndc.y, 0.5).unproject(camera);
    const dir = v.sub(camera.position).normalize();
    const t = -camera.position.z / dir.z;
    return camera.position.clone().add(dir.multiplyScalar(t));
  }

  function bellWorld(): Vector3 {
    return new Vector3(0, -THREAD_LEN - 0.25, 0).applyMatrix4(swing.matrixWorld);
  }

  function addRipple(origin: Vector3, strength: number) {
    ripples[rippleCursor]?.set(origin.x, origin.y, origin.z, clock.elapsed);
    rippleCursor = (rippleCursor + 1) % RIPPLE_SLOTS;
    bloomPulse = Math.max(bloomPulse, strength);
  }

  function step(dt: number) {
    const t = clock.elapsed;
    // Wind: layered sines + gusts + scroll velocity + cursor sweeps.
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

    // Bell pendulum
    const K = 9;
    const C = 1.1;
    sim.vx += (-K * sim.ax - C * sim.vx + windForce) * dt;
    sim.vz += (-K * sim.az - C * sim.vz + sim.wind * 0.05 * Math.sin(t * 0.61 + 2)) * dt;
    sim.ax += sim.vx * dt;
    sim.az += sim.vz * dt;

    // Clapper: longer, lighter pendulum; driven by bell motion + direct wind on the tanzaku
    const K2 = 5.2;
    const C2 = 0.9;
    const tanzakuWind = sim.wind * (0.55 + 0.45 * Math.sin(t * 1.7)) * 0.9;
    sim.cvx += (-K2 * sim.cx - C2 * sim.cvx - (sim.vx - 0) * 0.8 + tanzakuWind * 0.5) * dt;
    sim.cvz += (-K2 * sim.cz - C2 * sim.cvz + tanzakuWind * 0.15 * Math.cos(t * 0.9)) * dt;
    sim.cx += sim.cvx * dt;
    sim.cz += sim.cvz * dt;

    // Natural strike when the clapper swings far enough relative to the bell.
    const rel = Math.hypot(sim.cx, sim.cz);
    if (rel > 0.11 && t - sim.lastStrike > 5) {
      sim.lastStrike = t;
      sim.cvx *= -0.5;
      sim.cvz *= -0.5;
      swing.updateMatrixWorld(true);
      addRipple(bellWorld(), 0.35);
    }

    // Pointer smoothing
    pointer.active += (pointer.target - pointer.active) * Math.min(1, dt * 4);
    pointer.vx *= 0.9;

    bloomPulse *= Math.exp(-dt * 2.2);
    tanzakuUniforms.uWind.value = Math.min(1.2, sim.wind * 0.7 + Math.abs(sim.cvx) * 0.6);
  }

  function applyPose() {
    const clampA = (a: number) => Math.max(-0.5, Math.min(0.5, a));
    swing.rotation.z = clampA(sim.ax);
    swing.rotation.x = clampA(sim.az);
    clapperPivot.rotation.z = clampA(sim.cx);
    clapperPivot.rotation.x = clampA(sim.cz);
    tanzakuPivot.rotation.z = clampA(sim.cx * 0.6);

    const s = isHero ? scroll : 0;
    root.position.set(chimeBase.x, chimeBase.y + 1.4 + s * 0.8, chimeBase.z);
    camera.position.set(s * -0.3, s * 0.35, cameraBaseZ + s * 3.2);
    camera.lookAt(s * -0.3, s * 0.2, 0);
    particleUniforms.uScroll.value = s;

    const time = clock.elapsed;
    particleUniforms.uTime.value = time;
    ringUniforms.uTime.value = time;
    tanzakuUniforms.uTime.value = time;
    particleUniforms.uPointer.value.set(pointer.x, pointer.y);
    particleUniforms.uPointerActive.value = pointer.active;
    bloom.strength = BLOOM_BASE + bloomPulse * 0.9;
  }

  let firstFrame = false;
  function draw() {
    applyPose();
    if (bloomEnabled && theme === "dark") {
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
    if (!firstFrame) {
      firstFrame = true;
      opts.onFirstFrame();
    }
  }

  function renderStatic() {
    if (!(opts.animate && running)) {
      draw();
    }
  }

  // ---- adaptive quality
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
    if (avg > 22) {
      if (dpr > 1) {
        dpr = Math.max(1, dpr - 0.25);
        renderer.setPixelRatio(dpr);
        particleUniforms.uPixelRatio.value = dpr;
        layout();
      } else if (bloomEnabled) {
        bloomEnabled = false;
        applyTheme();
      }
    }
  }

  // ---- loop (renderer-owned rAF; setAnimationLoop(null) fully pauses rendering)
  let running = false;
  let active = false;
  function frame(now: number) {
    const dt = Math.min((now - clock.last) / 1000, 1 / 30);
    const frameMs = now - clock.last;
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
      renderer.setAnimationLoop(frame);
    } else if (!shouldRun && running) {
      running = false;
      renderer.setAnimationLoop(null);
    }
  }
  const onVisibility = () => syncLoop();
  document.addEventListener("visibilitychange", onVisibility);

  // Settle the pendulum a bit so a static (reduced-motion) render isn't dead-center.
  sim.ax = 0.06;
  sim.cx = -0.04;
  // Compile every program via KHR_parallel_shader_compile before the first frame, so the
  // link step happens off the main thread instead of stalling the first render. Program
  // keys depend on the bound render target (linear inside the bloom composer, sRGB on
  // screen), so compile against the target the first frame will actually draw into.
  applyPose();
  renderer.setRenderTarget(bloomEnabled && theme === "dark" ? composer.readBuffer : null);
  const compiled = renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(null);
  await compiled;
  draw();

  return {
    clearPointer() {
      pointer.target = 0;
    },
    dispose() {
      running = false;
      renderer.setAnimationLoop(null);
      document.removeEventListener("visibilitychange", onVisibility);
      scene.traverse((obj) => {
        const mesh = obj as Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as MeshBasicMaterial | undefined;
        mat?.dispose?.();
      });
      tanzakuUniforms.uMap.value.dispose();
      envRT.dispose();
      pmrem.dispose();
      composer.dispose();
      renderer.dispose();
    },
    resize() {
      layout();
      renderStatic();
    },
    ring(strength, clientX, clientY) {
      if (!opts.animate) {
        return;
      }
      swing.updateMatrixWorld(true);
      const origin =
        clientX !== undefined && clientY !== undefined
          ? ndcToWorldZ0(toNdc(clientX, clientY))
          : bellWorld();
      addRipple(origin, strength);
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
      const ndc = toNdc(clientX, clientY);
      const px = (ndc.x - pointer.lastX) * 60;
      pointer.lastX = ndc.x;
      pointer.vx = pointer.vx * 0.6 + px * 0.4;
      pointer.x = ndc.x;
      pointer.y = ndc.y;
      pointer.target = 1;
    },
    setScroll(progress) {
      scroll = progress;
      renderStatic();
    },
    setTheme(next) {
      theme = next;
      applyTheme();
      renderStatic();
    },
  };
}
