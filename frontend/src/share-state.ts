import { unzlibSync, zlibSync } from 'fflate';
import { MAX_SHAPES, shapeEntries, validateScene, type DisplayMode, type FormAppearance, type Reveals, type SceneState, type Shape, type Vec3 } from './scene';

export interface CameraState { position: Vec3; target: Vec3 }
export interface SharedStudy {
  version: 1 | 2 | 3 | 4;
  display?: DisplayMode;
  scene: SceneState;
  camera: CameraState;
  reveals: Reveals;
  locked: boolean;
  focus: boolean;
}
export const DEFAULT_CAMERA: CameraState = { position: [7.2, 5.5, 9.8], target: [0, 0, 0] };
export const MAX_SHARE_BYTES = 16_384;
const MAX_TOKEN_LENGTH = 12_000;
const INVALID = 'This share link is incomplete or damaged. Your current study is still available.';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID);
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(INVALID);
  return value;
}
function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error(INVALID);
  return value;
}
function vector(value: unknown, bound = 1_000_000): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(INVALID);
  const result = value.map(number) as Vec3;
  if (result.some(n => Math.abs(n) > bound)) throw new Error(INVALID);
  return result;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) throw new Error(INVALID);
  return value as T;
}
function shape(value: unknown, allowAppearance = false): Shape {
  const data = record(value), deform = record(data.deform);
  const result: Shape = {
    kind: choice(data.kind, ['box', 'cylinder', 'sphere', 'cone', 'rounded']),
    size: vector(data.size), position: vector(data.position), rotation: vector(data.rotation),
    deform: { twist: number(deform.twist), bend: number(deform.bend), taper: number(deform.taper),
      bulge: number(deform.bulge), roundness: number(deform.roundness) },
  };
  if (data.appearance !== undefined) {
    if (!allowAppearance) throw new Error(INVALID);
    result.appearance = choice<FormAppearance>(data.appearance, ['solid', 'wireframe']);
  }
  if (data.spine !== undefined) {
    if (!Array.isArray(data.spine) || data.spine.length < 3 || data.spine.length > 7) throw new Error(INVALID);
    result.spine = data.spine.map(value => {
      const point = record(value);
      return { position: vector(point.position), radius: number(point.radius) };
    });
  }
  return result;
}

/** Copy only recognized fields. Never merge URL objects into application state. */
export function parseSharedStudy(value: unknown): SharedStudy {
  const data = record(value);
  if (data.version !== 1 && data.version !== 2 && data.version !== 3 && data.version !== 4) throw new Error('This link uses a newer or unsupported study format. Try an updated version of Form Lab.');
  const source = record(data.scene), camera = record(data.camera), reveals = record(data.reveals);
  const scene: SceneState = { a: shape(source.a, data.version === 4), b: shape(source.b, data.version === 4),
    operation: choice(source.operation, ['single', 'subtract', 'union', 'intersect', 'reverse', 'exclude']),
    contours: number(source.contours) };
  if (source.extraShapes !== undefined) {
    if (data.version === 1 || !Array.isArray(source.extraShapes) || source.extraShapes.length > MAX_SHAPES - 2) throw new Error(INVALID);
    if (source.extraShapes.length) scene.extraShapes = source.extraShapes.map(value => shape(value, data.version === 4));
  }
  validateScene(scene);
  const view = { position: vector(camera.position), target: vector(camera.target) };
  const distance = Math.hypot(...view.position.map((n, i) => n - view.target[i]));
  if (distance < 5 - 1e-7 || distance > 45 + 1e-7) throw new Error(INVALID);
  return { version: data.version, ...(data.version >= 3 ? { display: choice<DisplayMode>(data.display, data.version === 4 ? ['solid', 'wireframe', 'forms'] : ['solid', 'wireframe']) } : {}), scene, camera: view,
    reveals: { cutter: flag(reveals.cutter), construction: flag(reveals.construction), hidden: flag(reveals.hidden), seam: flag(reveals.seam) },
    locked: flag(data.locked), focus: flag(data.focus) };
}

// fflate checks the stream structure but does not check the zlib checksum.
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const byte of bytes) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

export function encodeStudy(study: SharedStudy): string {
  const version = study.display === 'forms' || shapeEntries(study.scene, true).some(([, shape]) => shape.appearance !== undefined) ? 4
    : study.display !== undefined ? Math.max(3, study.version) : study.scene.extraShapes?.length ? Math.max(2, study.version) : study.version;
  const bytes = new TextEncoder().encode(JSON.stringify(parseSharedStudy({ ...study, version })));
  if (bytes.length > MAX_SHARE_BYTES) throw new Error('This study is too large for a share link.');
  const compressed = zlibSync(bytes, { level: 6 });
  const token = btoa(String.fromCharCode(...compressed)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('This study is too large for a share link.');
  return `#s=${token}`;
}

/** No hash means a fresh study. Any nonempty unrecognized hash is recoverable. */
export function decodeStudy(hash: string): SharedStudy | null {
  if (!hash || hash === '#') return null;
  if (!hash.startsWith('#s=')) throw new Error(INVALID);
  const token = hash.slice(3);
  if (!token || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error(INVALID);
  let value: unknown;
  try {
    const compressed = Uint8Array.from(atob(token.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
    if (compressed.length < 6) throw new Error(INVALID);
    // One extra byte detects overflow. A fixed output buffer bounds allocation even for hostile input.
    const bytes = unzlibSync(compressed, { out: new Uint8Array(MAX_SHARE_BYTES + 1) });
    if (bytes.length > MAX_SHARE_BYTES) throw new Error(INVALID);
    const checksum = new DataView(compressed.buffer).getUint32(compressed.length - 4);
    if (adler32(bytes) !== checksum) throw new Error(INVALID);
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error(INVALID); }
  return parseSharedStudy(value);
}
