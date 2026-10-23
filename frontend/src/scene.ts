import { Euler, Matrix4, Quaternion, Vector3 } from 'three';

export type Vec3 = [number, number, number];
export type ShapeId = 'a' | 'b';
export type ShapeKind = 'box' | 'cylinder' | 'sphere' | 'cone' | 'rounded';
export type Operation = 'single' | 'subtract' | 'union' | 'intersect' | 'reverse' | 'exclude';
export type Tool = 'translate' | 'rotate' | 'scale';
export interface Deformation { twist: number; bend: number; taper: number; bulge: number; roundness: number }
/** Positions are in shape-relative units; radius is a local thickness multiplier. */
export interface CurvePoint { position: Vec3; radius: number }
export interface Shape { kind: ShapeKind; size: Vec3; position: Vec3; rotation: Vec3; deform: Deformation; spine?: CurvePoint[] }
export interface SceneState { a: Shape; b: Shape; operation: Operation; contours: number }
export interface Reveals { cutter: boolean; construction: boolean; hidden: boolean; seam: boolean }
export interface MeshData { positions: Float32Array; indices: Uint32Array; origins: Uint32Array }
export interface GeometryResult extends MeshData {
  normals: Float32Array; sources: Record<ShapeId, MeshData>;
  volume: number; bodyVolume: number; overlapVolume: number; duration: number;
}
export const SHAPES: { id: ShapeKind; label: string }[] = [
  { id: 'box', label: 'Box' }, { id: 'cylinder', label: 'Cylinder' }, { id: 'sphere', label: 'Sphere / ellipsoid' },
  { id: 'cone', label: 'Cone' }, { id: 'rounded', label: 'Rounded form' },
];
export const shapeName = (kind: ShapeKind) => SHAPES.find(s => s.id === kind)!.label;
export function makeShape(kind: ShapeKind, size?: Vec3): Shape {
  return { kind, size: size ?? (kind === 'rounded' ? [2.6, 2, 5.8] : kind === 'sphere' ? [3, 3, 3] : [3, 3, 4]),
    position: [0, 0, 0], rotation: [0, 0, 0],
    deform: { twist: 0, bend: 0, taper: 0, bulge: 0, roundness: kind === 'box' ? 0 : 1 } };
}
export const DEFAULT_SCENE: SceneState = {
  a: makeShape('box', [3.8, 3.4, 3.4]),
  b: { ...makeShape('cylinder', [1.92, 1.92, 6.4]), position: [.35, .35, 0], rotation: [14, 18, 0] },
  operation: 'subtract', contours: 4,
};
export const cloneScene = (s: SceneState): SceneState => structuredClone(s);
export const radians = (degrees: number) => degrees * Math.PI / 180;
export function shapeMatrix(shape: Pick<Shape, 'position' | 'rotation'>): Matrix4 {
  return new Matrix4().compose(new Vector3(...shape.position),
    new Quaternion().setFromEuler(new Euler(...shape.rotation.map(radians) as Vec3, 'XYZ')), new Vector3(1, 1, 1));
}
/** Keep the inside radius positive, even at the widest, twisted cross-section. */
export function bendLimit(shape: Shape): number {
  const radius = Math.hypot(shape.size[0], shape.size[1]) / 2 * (1 + Math.abs(shape.deform.taper) / 2) * (1 + Math.max(0, shape.deform.bulge));
  return Math.min(120, Math.floor(.75 * shape.size[2] / radius * 180 / Math.PI));
}
export function constrainBend(shape: Shape) {
  const limit = bendLimit(shape); shape.deform.bend = Math.max(-limit, Math.min(limit, shape.deform.bend));
  shape.spine?.forEach(point => { for (const axis of [0, 1]) point.position[axis] = Math.max(-curveOffsetLimit(shape, axis), Math.min(curveOffsetLimit(shape, axis), point.position[axis])); });
}
export const CURVE_GAP = .08;
export const curveOffsetLimit = (shape: Shape, axis: number) => Math.max(1.5, shape.size[2] / (2 * shape.size[axis]));
export function constrainCurvePoint(shape: Shape, index: number, position: Vec3): Vec3 {
  const points = shape.spine!;
  return [Math.max(-curveOffsetLimit(shape, 0), Math.min(curveOffsetLimit(shape, 0), position[0])), Math.max(-curveOffsetLimit(shape, 1), Math.min(curveOffsetLimit(shape, 1), position[1])),
    index === 0 || index === points.length - 1 ? points[index].position[2]
      : Math.max(points[index - 1].position[2] + CURVE_GAP, Math.min(points[index + 1].position[2] - CURVE_GAP, position[2]))];
}
export function sCurvePoints(): CurvePoint[] {
  return [-.65, -.5, 0, .5, .65].map((x, i) => ({ position: [x, 0, i / 4 - .5], radius: [.85, 1.1, .7, 1.1, .85][i] }));
}
export function validateScene(scene: SceneState): void {
  if (!['single', 'subtract', 'union', 'intersect', 'reverse', 'exclude'].includes(scene.operation)) throw new Error('Unknown operation.');
  if (!Number.isInteger(scene.contours) || scene.contours < 1 || scene.contours > 9) throw new Error('Use between 1 and 9 cross-contours.');
  for (const shape of [scene.a, scene.b]) {
    if (!SHAPES.some(s => s.id === shape.kind)) throw new Error('Unknown shape.');
    if (shape.position.length !== 3 || shape.rotation.length !== 3 || ![...shape.position, ...shape.rotation].every(Number.isFinite)) throw new Error('Shape transforms must be finite.');
    if (shape.position.some(v => Math.abs(v) > 20)) throw new Error('Move the shapes closer to the study area.');
    if (shape.size.length !== 3 || shape.size.some(v => !Number.isFinite(v) || v < .4 || v > 12)) throw new Error('Shape dimensions must be between 0.4 and 12.');
    if (shape.spine) {
      if (shape.kind !== 'rounded' || shape.spine.length < 3 || shape.spine.length > 7) throw new Error('Rounded curves need 3 to 7 control points.');
      for (const [i, point] of shape.spine.entries()) {
        if (point.position.length !== 3 || point.position.some(v => !Number.isFinite(v)) || point.position.slice(0, 2).some((v, axis) => Math.abs(v) > curveOffsetLimit(shape, axis) + 1e-7)
          || Math.abs(point.position[2]) > .5 || (i > 0 && point.position[2] - shape.spine[i - 1].position[2] < CURVE_GAP - 1e-7)) throw new Error('Keep curve points ordered along the length, with space between them.');
        if (!Number.isFinite(point.radius) || point.radius < .2 || point.radius > 1.8) throw new Error('Point thickness must be between 20% and 180%.');
      }
      if (Math.abs(shape.deform.bend) > 1e-7) throw new Error('Control points replace the arc bend.');
    }
    const ranges: Record<keyof Deformation, [number, number]> = { twist: [-180, 180], bend: [-bendLimit(shape), bendLimit(shape)], taper: [-1.2, 1.2], bulge: [-.65, .7], roundness: [0, 1] };
    for (const key of Object.keys(ranges) as (keyof Deformation)[]) {
      const value = shape.deform[key], [min, max] = ranges[key];
      if (!Number.isFinite(value) || value < min || value > max) throw new Error(`The ${key} setting is outside the safe range.`);
    }
  }
}
function study(kind: ShapeKind, deform: Partial<Deformation>, size?: Vec3): SceneState {
  const scene = cloneScene(DEFAULT_SCENE); scene.operation = 'single'; scene.a = makeShape(kind, size);
  Object.assign(scene.a.deform, deform); constrainBend(scene.a); return scene;
}
export const PRESETS: { name: string; description: string; scene: SceneState }[] = [
  { name: 'Oblique passage', description: 'A tilted cylinder passes through two faces.', scene: DEFAULT_SCENE },
  { name: 'Straight through', description: 'Compare the opening with its hidden exit.', scene: { ...cloneScene(DEFAULT_SCENE), b: makeShape('cylinder', [2, 2, 6.4]) } },
  { name: 'Open channel', description: 'Watch the cut interrupt the top silhouette.', scene: { ...cloneScene(DEFAULT_SCENE), b: { ...makeShape('cylinder', [2.2, 2.2, 6.4]), position: [0, 1.45, 0] } } },
  { name: 'Corner cut', description: 'Follow one curve across adjoining planes.', scene: { ...cloneScene(DEFAULT_SCENE), b: { ...makeShape('cylinder', [2.3, 2.3, 7]), position: [1.55, .8, 0], rotation: [16, -8, 0] } } },
  { name: 'Twisted box', description: 'Follow the four corners as they turn around the axis.', scene: study('box', { twist: 75 }, [2.5, 2.5, 5.5]) },
  { name: 'Rounded bean', description: 'Wrap a few contours around the bend; compare the near and far halves.', scene: study('rounded', { bend: 95, taper: .35, bulge: -.2 }, [2.3, 1.8, 6]) },
  { name: 'Pinched form', description: 'Watch the sections narrow at the waist and expand at the ends.', scene: study('rounded', { bend: -35, taper: -.35, bulge: -.62 }, [3.6, 2.8, 6.5]) },
  { name: 'Bent cone', description: 'Track the changing width along the curved axis.', scene: study('cone', { bend: 70 }, [2.8, 2.8, 5.8]) },
  { name: 'Ellipsoid', description: 'Compare the contour ellipses with the long axis.', scene: study('sphere', {}, [2.7, 2, 4.8]) },
  { name: 'S-curve', description: 'Follow the changing direction; pinch or widen the form at each point.', scene: {
    ...study('rounded', {}, [2.1, 1.7, 7.5]), a: { ...makeShape('rounded', [2.1, 1.7, 7.5]), spine: sCurvePoints() },
  } },
];
/** Bounded random references, repeatable with an injected random-number source. */
export function generateRounded(random: () => number = Math.random): SceneState {
  const scene = study('rounded', { bend: (random() * 2 - 1) * 100, twist: (random() * 2 - 1) * 70,
    taper: (random() * 2 - 1) * .8, bulge: -.6 + random() * 1.05 }, [2 + random() * 1.4, 1.5 + random(), 5.5 + random() * 1.5]);
  scene.a.rotation = [-15 + random() * 30, -20 + random() * 40, -25 + random() * 50];
  return scene;
}
