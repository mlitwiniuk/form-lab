import { Vector3 } from 'three';
import { radians, shapeMatrix, type Shape, type MeshData, type CurvePoint, type Vec3 } from './scene';
import { createSpineSampler } from './spine';

export const RADIAL_SEGMENTS = 128;
export const AXIAL_SEGMENTS = 48;
export type GeometryQuality = 'preview' | 'final';
export const RESOLUTIONS = { preview: { radial: 32, axial: 24 }, final: { radial: RADIAL_SEGMENTS, axial: AXIAL_SEGMENTS } } as const;
// Concentrate vertices near closed tips, where curvature changes most quickly.
function ringParameter(shape: Shape, ring: number, axial: number) {
  const u = ring / axial;
  return shape.kind === 'sphere' || shape.kind === 'rounded' ? -Math.cos(Math.PI * u) / 2 : u - .5;
}
/** Parameter t runs from -1/2 to +1/2 along the local Z axis. */
export function createSectionSampler(shape: Shape) {
  const spine = shape.spine ? createSpineSampler(shape) : null;
  const frames = new Map<number, ReturnType<ReturnType<typeof createSpineSampler>>>();
  return (t: number, angle: number, axis = false): Vec3 => {
  const { twist, bend, taper, bulge, roundness } = shape.deform;
  const rounded = shape.kind === 'sphere' || shape.kind === 'rounded';
  const profile = rounded ? (shape.kind === 'sphere' ? Math.sqrt(Math.max(0, 1 - 4 * t * t)) : Math.pow(Math.max(0, Math.cos(t * Math.PI)), .65))
    : shape.kind === 'cone' ? .5 - t : 1;
  let frame = frames.get(t);
  if (spine && !frame) { frame = spine(t + .5); frames.set(t, frame); }
  const width = profile * (1 + taper * t) * (1 + bulge * Math.cos(t * Math.PI * 2)) * (frame?.radius ?? 1);
  const c = Math.cos(angle), s = Math.sin(angle), squareRadius = 1 / Math.max(Math.abs(c), Math.abs(s));
  const r = (1 - roundness) * squareRadius + roundness;
  const x = axis ? 0 : shape.size[0] / 2 * c * r * width;
  const y = axis ? 0 : shape.size[1] / 2 * s * r * width;
  const turn = radians(twist) * t;
  const tx = x * Math.cos(turn) - y * Math.sin(turn), ty = x * Math.sin(turn) + y * Math.cos(turn);
  if (frame) return frame.center.clone().addScaledVector(frame.normal, tx).addScaledVector(frame.binormal, ty).toArray() as Vec3;
  const b = radians(bend), theta = b * t, length = shape.size[2];
  // An arc sweep: sections stay perpendicular to the centerline. bendLimit prevents folding.
  const cx = Math.abs(b) < 1e-7 ? 0 : length / b * (1 - Math.cos(theta));
  const cz = Math.abs(b) < 1e-7 ? length * t : length / b * Math.sin(theta);
  return [cx + tx * Math.cos(theta), ty, cz - tx * Math.sin(theta)];
  };
}
export function sectionPoint(shape: Shape, t: number, angle: number, axis = false): Vec3 { return createSectionSampler(shape)(t, angle, axis); }

/** Convert an existing arc into editable points without discarding its overall direction. */
export function curveFromShape(shape: Shape): CurvePoint[] {
  const sample = createSectionSampler(shape);
  return Array.from({ length: 5 }, (_, i) => ({ position: sample(i / 4 - .5, 0, true).map((v, axis) => v / shape.size[axis]) as Vec3, radius: 1 }));
}

/** Detect local sweep folds before sending a self-overlapping surface to the kernel. */
export function validateSpineSweep(shape: Shape) {
  if (!shape.spine) return;
  const sample = createSpineSampler(shape);
  let previous = sample(0);
  for (let i = 1; i <= 192; i++) {
    const u = i / 192, frame = sample(u), t = u - .5;
    const curvature = frame.tangent.distanceTo(previous.tangent) / Math.max(1e-8, frame.center.distanceTo(previous.center));
    const width = Math.pow(Math.max(0, Math.sin(u * Math.PI)), .65) * (1 + shape.deform.taper * t)
      * (1 + shape.deform.bulge * Math.cos(t * Math.PI * 2)) * frame.radius;
    const radius = (shape.deform.roundness === 1 ? Math.max(shape.size[0], shape.size[1]) : Math.hypot(shape.size[0], shape.size[1])) / 2 * width;
    if (curvature * radius > .9) throw new Error('This bend is too tight for its thickness. Reduce point thickness, spread the points out, or increase Length. Your last valid form is still shown.');
    previous = frame;
  }
}

/** Closed, indexed loft with single pole vertices and consistently outward winding. */
export function shapeMesh(shape: Shape, quality: GeometryQuality = 'final'): Pick<MeshData, 'positions' | 'indices'> {
  validateSpineSweep(shape);
  const sample = createSectionSampler(shape);
  const positions: number[] = [], indices: number[] = [], rings: number[][] = [];
  const { radial: n, axial } = RESOLUTIONS[quality];
  const rounded = shape.kind === 'sphere' || shape.kind === 'rounded';
  const poleBottom = rounded, poleTop = rounded || shape.kind === 'cone';
  for (let j = 0; j <= axial; j++) {
    const t = ringParameter(shape, j, axial);
    const pole = (j === 0 && poleBottom) || (j === axial && poleTop);
    const ring: number[] = [];
    for (let i = 0; i < (pole ? 1 : n); i++) {
      ring.push(positions.length / 3); positions.push(...sample(t, i / n * Math.PI * 2, pole));
    }
    rings.push(ring);
  }
  for (let j = 0; j < axial; j++) for (let i = 0; i < n; i++) {
    const a = rings[j], b = rings[j + 1], k = (i + 1) % n;
    if (a.length === 1) indices.push(a[0], b[k], b[i]);
    else if (b.length === 1) indices.push(a[i], a[k], b[0]);
    else indices.push(a[i], a[k], b[k], a[i], b[k], b[i]);
  }
  for (const [j, pole] of [[0, poleBottom], [axial, poleTop]] as const) if (!pole) {
    const center = positions.length / 3; positions.push(...sample(j / axial - .5, 0, true));
    for (let i = 0; i < n; i++) {
      const a = rings[j][i], b = rings[j][(i + 1) % n];
      indices.push(...(j === 0 ? [center, b, a] : [center, a, b]));
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Guides use the same loft rings as the solid, so they lie on the rendered surface. */
export function constructionLines(shape: Shape, count: number, quality: GeometryQuality = 'final') {
  const sample = createSectionSampler(shape);
  const { radial, axial } = RESOLUTIONS[quality];
  const matrix = shapeMatrix(shape), point = new Vector3();
  const sections: number[] = [], axis: number[] = [];
  const segment = (a: number[], b: number[], out: number[]) => out.push(...point.fromArray(a).applyMatrix4(matrix).toArray(), ...point.fromArray(b).applyMatrix4(matrix).toArray());
  const rounded = shape.kind === 'sphere' || shape.kind === 'rounded';
  const rings = new Set(Array.from({ length: count }, (_, i) => {
    const u = (i + 1) / (count + 1);
    return Math.round((rounded ? Math.acos(1 - 2 * u) / Math.PI : u) * axial);
  }));
  for (const ring of rings) for (let i = 0; i < radial; i++) {
    const t = ringParameter(shape, ring, axial);
    segment(sample(t, i / radial * 2 * Math.PI), sample(t, (i + 1) / radial * 2 * Math.PI), sections);
  }
  for (let j = 0; j < axial; j++) segment(sample(j / axial - .5, 0, true), sample((j + 1) / axial - .5, 0, true), axis);
  return { sections, axis };
}
