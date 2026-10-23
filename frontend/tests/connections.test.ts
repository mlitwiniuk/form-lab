import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { Vector3 } from 'three';
import { evaluateScene } from '../src/geometry';
import { extractEdges, packedEdgeLines } from '../src/edges';
import { prepareRenderGeometry } from '../src/render-geometry';
import { cloneScene, DEFAULT_SCENE, makeShape, shapeEntries, sCurvePoints, type Operation, type SceneState, type ShapeKind, type Vec3 } from '../src/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const camera = new Vector3(7, 5, 10);
const box = (size: Vec3, position: Vec3) => ({ ...makeShape('box', size), position });
function secondaryJoin(): SceneState {
  return { a: box([2, 2, 2], [-6, 0, 0]), b: box([4, 4, 4], [0, 0, 0]),
    extraShapes: [box([4, 4, 4], [2, 1, .7])], operation: 'subtract', contours: 4 };
}
function lines(scene: SceneState) {
  return packedEdgeLines(evaluateScene(wasm, scene).connectionEdges, camera).seam;
}
function length(points: number[]) {
  let total = 0;
  for (let i = 0; i < points.length; i += 6) total += Math.hypot(...[0, 1, 2].map(axis => points[i + axis + 3] - points[i + axis]));
  return total;
}

describe('exterior connection edges across all forms', () => {
  it('reveals B–C connections even when the cut result is only a disjoint A', () => {
    const scene = secondaryJoin(), geometry = evaluateScene(wasm, scene);
    expect(extractEdges(geometry).filter(edge => edge.seam)).toEqual([]);
    const connections = packedEdgeLines(geometry.connectionEdges, camera).seam;
    expect(connections.length).toBeGreaterThan(0);
    for (let i = 0; i < connections.length; i += 3) expect(connections[i]).toBeGreaterThanOrEqual(-2);
    expect(prepareRenderGeometry(geometry, scene, 'final').connectionEdges).toBe(geometry.connectionEdges);
  });
  it.each<Operation>(['union', 'subtract', 'intersect', 'reverse', 'exclude'])('uses the same exposed joins for %s', operation => {
    const scene = secondaryJoin(), expected = lines(scene);
    scene.operation = operation;
    expect(lines(scene)).toEqual(expected);
  });
  it('has no special first operand: promoting B or C keeps the same exterior seam length', () => {
    const scene = secondaryJoin(), baseline = length(lines(scene)), c = scene.extraShapes![0];
    expect(baseline).toBeGreaterThan(0);
    expect(length(lines({ ...scene, a: scene.b, b: c, extraShapes: [scene.a] }))).toBeCloseTo(baseline, 5);
    expect(length(lines({ ...scene, a: c, b: scene.a, extraShapes: [scene.b] }))).toBeCloseTo(baseline, 5);
  });
  it('clips a connection where a third form covers it, instead of hiding or revealing the whole pair', () => {
    const scene = cloneScene(DEFAULT_SCENE); scene.operation = 'union';
    scene.a = box([4, 4, 4], [0, 0, 0]); scene.b = box([4, 4, 4], [2, 1, .7]);
    const uncovered = lines(scene);
    const cover = box([2, 8, 8], [1.5, 0, 0]);
    const inside = (point: number[], shape: ReturnType<typeof box>) => point.every((value, axis) => Math.abs(value - shape.position[axis]) < shape.size[axis] / 2 - 1e-5);
    const sample = (points: number[], offset: number, t: number) => [0, 1, 2].map(axis => points[offset + axis] * (1 - t) + points[offset + axis + 3] * t);
    expect(Array.from({ length: uncovered.length / 6 }, (_, i) => inside(sample(uncovered, i * 6, .5), cover)).some(Boolean)).toBe(true);
    scene.extraShapes = [cover];
    const exposed = lines(scene);
    expect(exposed.length).toBeGreaterThan(0);
    for (let i = 0; i < exposed.length; i += 6) for (const t of [.01, .25, .5, .75, .99]) {
      const point = sample(exposed, i, t);
      for (const [, shape] of shapeEntries(scene)) expect(inside(point, shape)).toBe(false);
      // A true connection lies on the boundaries of at least two original boxes.
      expect(shapeEntries(scene).filter(([, shape]) => point.every((value, axis) => Math.abs(value - shape.position[axis]) <= shape.size[axis] / 2 + 1e-5)
        && point.some((value, axis) => Math.abs(Math.abs(value - shape.position[axis]) - shape.size[axis] / 2) < 1e-5)).length).toBeGreaterThanOrEqual(2);
    }
  });
  it('omits intersections completely enclosed by another form', () => {
    const scene = secondaryJoin();
    expect(lines(scene).length).toBeGreaterThan(0);
    scene.a = box([12, 12, 12], [0, 0, 0]);
    expect(lines(scene)).toEqual([]);
  });
  it('does not mark coplanar ownership boundaries, coincident forms, or a single form', () => {
    const scene = cloneScene(DEFAULT_SCENE); scene.operation = 'union';
    scene.b = box([3, 3, 3], [3, 0, 0]);
    expect(lines(scene)).toEqual([]); // Flush face-to-face join has no exterior crease.
    scene.b.position = [0, 0, 0]; expect(lines(scene)).toEqual([]);
    scene.b = box([1, 1, 1], [1, 0, 0]); expect(lines(scene)).toEqual([]); // Inside A, touching one face.
    scene.operation = 'single'; expect(lines(scene)).toEqual([]);
  });
  it.each<ShapeKind>(['box', 'rounded'])('does not invent joins between identical deformed %s forms', kind => {
    const scene = cloneScene(DEFAULT_SCENE); scene.operation = 'union';
    scene.a = makeShape(kind);
    if (kind === 'rounded') scene.a.spine = sCurvePoints();
    else { scene.a.deform.bend = 35; scene.a.deform.twist = 30; }
    scene.b = structuredClone(scene.a);
    expect(lines(scene)).toHaveLength(0);
  });
  it('preserves both complete exterior rings where a cylinder passes through a box', () => {
    const scene = cloneScene(DEFAULT_SCENE); scene.operation = 'subtract';
    scene.a = box([4, 4, 4], [0, 0, 0]); scene.b = makeShape('cylinder', [2, 2, 8]);
    const connections = lines(scene);
    expect(length(connections) / (4 * Math.PI)).toBeCloseTo(1, 2);
    for (let i = 0; i < connections.length; i += 3) {
      expect(Math.abs(connections[i + 2])).toBeCloseTo(2, 5);
      expect(Math.hypot(connections[i], connections[i + 1])).toBeCloseTo(1, 5);
    }
  });
  it('keeps curved B–C joins and back-side exterior curves available in wireframe', () => {
    const scene = secondaryJoin(); scene.b = makeShape('sphere', [4, 4, 4]);
    scene.extraShapes = [{ ...makeShape('cylinder', [2, 2, 6]), position: [.5, 0, 0] }];
    const geometry = evaluateScene(wasm, scene, 'preview');
    const front = packedEdgeLines(geometry.connectionEdges, camera).seam;
    expect(front.length).toBeGreaterThan(0);
    expect(front.every(Number.isFinite)).toBe(true);
    expect(packedEdgeLines(geometry.connectionEdges, camera.clone().negate()).seam).toEqual(front);
    expect(packedEdgeLines(geometry.connectionEdges, camera, false).seam).toEqual([]);
  });
});
