import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { evaluateScene } from '../src/geometry';
import { edgeLines, extractEdges } from '../src/edges';
import { cloneScene, CUT_SCENE as DEFAULT_SCENE, PRESETS, SHAPES, makeShape, constrainBend, generateRounded, bendLimit, type Operation } from '../src/scene';
import { constructionLines, sectionPoint, shapeMesh, AXIAL_SEGMENTS } from '../src/forms';
import { Vector3 } from 'three';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const straightScene = () => {
  const scene = cloneScene(DEFAULT_SCENE);
  scene.a.size = [4, 4, 4]; scene.b = makeShape('cylinder', [2, 2, 8]);
  return scene;
};
const polygonArea = 128 / 2 * Math.sin(2 * Math.PI / 128);

describe('real solid operations', () => {
  it.each<Operation>(['single', 'subtract', 'union', 'intersect', 'reverse', 'exclude'])('%s has the expected volume and closed topology', operation => {
    const scene = straightScene(); scene.operation = operation;
    const mesh = evaluateScene(wasm, scene);
    const overlap = polygonArea * 4, cylinderVolume = polygonArea * 8;
    const expected = { single: 64, exclude: 64 + cylinderVolume - 2 * overlap, subtract: 64 - overlap, union: 64 + cylinderVolume - overlap, intersect: overlap, reverse: cylinderVolume - overlap };
    expect(mesh.volume).toBeCloseTo(expected[operation], 4);
    expect(mesh.overlapVolume).toBeCloseTo(operation === 'single' ? 0 : overlap, 4);
    // XOR components touch at coincident seam positions; coordinate welding sees four faces there.
    expect(extractEdges(mesh).every(edge => edge.normals.length === 2 || (operation === 'exclude' && edge.normals.length === 4))).toBe(true);
  });
  it('extracts only the two box/cylinder boundary loops as intersection edges', () => {
    const mesh = evaluateScene(wasm, straightScene());
    const seam = extractEdges(mesh).filter(edge => edge.seam);
    expect(seam.length).toBe(256);
    for (const edge of seam) for (const vertex of [edge.a, edge.b]) {
      expect(Math.abs(vertex.z)).toBeCloseTo(2, 5);
      expect(Math.hypot(vertex.x, vertex.y)).toBeCloseTo(1, 5);
    }
    const lines = edgeLines(extractEdges(mesh), new Vector3(7, 6, 10));
    expect(lines.contour.length / 6).toBeLessThan(40);
  });
  it('handles a disjoint cylinder without inventing a seam', () => {
    const scene = straightScene(); scene.b.position[0] = 5;
    const mesh = evaluateScene(wasm, scene);
    expect(mesh.volume).toBeCloseTo(64, 5);
    expect(mesh.overlapVolume).toBe(0);
    expect(extractEdges(mesh).some(edge => edge.seam)).toBe(false);
  });
  it('handles exact tangency without removing volume', () => {
    const scene = straightScene(); scene.b.position[0] = 3;
    const mesh = evaluateScene(wasm, scene);
    expect(mesh.volume).toBeCloseTo(64, 5);
    expect(mesh.overlapVolume).toBeCloseTo(0, 6);
  });
  it('handles full subtraction as an empty valid result', () => {
    const scene = straightScene(); scene.b.size[0] = scene.b.size[1] = 8;
    const mesh = evaluateScene(wasm, scene);
    expect(mesh.volume).toBe(0); expect(mesh.indices.length).toBe(0);
    expect(extractEdges(mesh)).toEqual([]);
  });
  it('handles a completely enclosed cylindrical cavity', () => {
    const scene = straightScene(); scene.b.size[2] = 1;
    const mesh = evaluateScene(wasm, scene);
    expect(mesh.volume).toBeCloseTo(64 - polygonArea, 5);
    expect(extractEdges(mesh).every(edge => edge.normals.length === 2)).toBe(true);
  });
  it('keeps the result equivalent when both shapes rotate and translate together', () => {
    const scene = straightScene();
    scene.a.rotation = scene.b.rotation = [15, 32, 42];
    scene.a.position = scene.b.position = [1, 2, -1];
    expect(evaluateScene(wasm, scene).volume).toBeCloseTo(64 - polygonArea * 4, 4);
  });
  it.each(PRESETS.filter(p => p.scene.operation !== 'single'))('$name produces a nonempty cut, seam and closed solid', preset => {
    const mesh = evaluateScene(wasm, preset.scene), edges = extractEdges(mesh);
    expect(mesh.volume).toBeGreaterThan(0); expect(mesh.overlapVolume).toBeGreaterThan(0);
    expect(edges.some(edge => edge.seam)).toBe(true);
    expect(edges.every(edge => edge.normals.length === 2)).toBe(true);
  });
  it('remains stable through 100 repeated transformed cuts', () => {
    for (let i = 0; i < 100; i++) {
      const scene = cloneScene(DEFAULT_SCENE);
      scene.b.rotation[1] = i * 1.8; scene.b.position[0] = Math.sin(i) * 1.5;
      const result = evaluateScene(wasm, scene);
      expect(Number.isFinite(result.volume)).toBe(true);
      expect(result.volume).toBeGreaterThan(0);
      expect(result.volume).toBeLessThan(result.bodyVolume);
    }
  });
  it('rejects nonfinite and unsupported dimensions before invoking the kernel', () => {
    const scene = straightScene(); scene.a.size[0] = NaN;
    expect(() => evaluateScene(wasm, scene)).toThrow('Shape dimensions');
    scene.a.size[0] = 0;
    expect(() => evaluateScene(wasm, scene)).toThrow('Shape dimensions');
  });
});


describe('deformed volumes and construction guides', () => {
  it.each(PRESETS.filter(p => p.scene.operation === 'single'))('$name is a closed volume with finite unit normals', preset => {
    const mesh = evaluateScene(wasm, preset.scene);
    expect(mesh.volume).toBeGreaterThan(0);
    expect(extractEdges(mesh).every(edge => edge.normals.length === 2)).toBe(true);
    expect(extractEdges(mesh).some(edge => edge.seam)).toBe(false);
    for (let i = 0; i < mesh.normals.length; i += 3) expect(Math.hypot(...mesh.normals.slice(i, i + 3))).toBeCloseTo(1, 4);
  });
  it('approximates the analytic ellipsoid and cone volumes', () => {
    const scene = straightScene(); scene.operation = 'single';
    scene.a = makeShape('sphere', [2, 4, 6]);
    const ratio = evaluateScene(wasm, scene).volume / (4 / 3 * Math.PI * 1 * 2 * 3);
    expect(ratio).toBeGreaterThan(.997); expect(ratio).toBeLessThanOrEqual(1);
    scene.a = makeShape('cone', [2, 2, 6]);
    expect(evaluateScene(wasm, scene).volume).toBeCloseTo(polygonArea * 2, 4);
  });
  it('twists opposite ends in opposite directions without moving their center', () => {
    const shape = makeShape('box', [2, 2, 6]); shape.deform.twist = 90;
    const bottom = sectionPoint(shape, -.5, 0), top = sectionPoint(shape, .5, 0);
    expect(bottom[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(bottom[1]).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(top[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(bottom[2]).toBe(-3); expect(top[2]).toBe(3);
  });
  it('keeps bent cross-sections perpendicular to the centerline', () => {
    const shape = makeShape('rounded'); shape.deform.bend = 80;
    const t = .2, epsilon = .0001;
    const center = new Vector3(...sectionPoint(shape, t, 0, true));
    const radial = new Vector3(...sectionPoint(shape, t, 0)).sub(center).normalize();
    const tangent = new Vector3(...sectionPoint(shape, t + epsilon, 0, true)).sub(new Vector3(...sectionPoint(shape, t - epsilon, 0, true))).normalize();
    expect(radial.dot(tangent)).toBeCloseTo(0, 6);
  });
  it('places every guide vertex on a loft vertex rather than on an unrelated ellipse', () => {
    const shape = makeShape('rounded'); Object.assign(shape.deform, { bend: 70, twist: 65, taper: .5, bulge: -.4 });
    const mesh = shapeMesh(shape), guides = constructionLines(shape, 5);
    const key = (values: ArrayLike<number>) => Array.from(values).map(n => Math.round(Math.fround(n) * 1e5)).join(',');
    const points = new Set(Array.from({ length: mesh.positions.length / 3 }, (_, i) => key(mesh.positions.slice(i * 3, i * 3 + 3))));
    for (let i = 0; i < guides.sections.length; i += 3) expect(points.has(key(guides.sections.slice(i, i + 3)))).toBe(true);
    expect(guides.sections.length).toBe(5 * 128 * 6);
    expect(guides.axis.length).toBe(AXIAL_SEGMENTS * 6);
  });
  it('preserves operand intersection curves when a twisted form is cut by a sphere', () => {
    const scene = straightScene(); scene.a.deform.twist = 95;
    scene.b = makeShape('sphere', [3, 3, 5]); scene.b.position = [1.1, 0, 0];
    const result = evaluateScene(wasm, scene), edges = extractEdges(result);
    expect(result.volume).toBeGreaterThan(0); expect(result.volume).toBeLessThan(result.bodyVolume);
    expect(edges.some(e => e.seam)).toBe(true);
    expect(edges.every(e => e.normals.length === 2)).toBe(true);
  });
  it('morphs a square section into a circle continuously', () => {
    const scene = straightScene(); scene.operation = 'single'; scene.a = makeShape('box', [2, 2, 4]);
    const volumes = [0, .5, 1].map(roundness => { scene.a.deform.roundness = roundness; return evaluateScene(wasm, scene).volume; });
    expect(volumes[0]).toBeCloseTo(16, 4); expect(volumes[2]).toBeCloseTo(polygonArea * 4, 4);
    expect(volumes[1]).toBeLessThan(volumes[0]); expect(volumes[1]).toBeGreaterThan(volumes[2]);
  });
  it('generates repeatable, bounded rounded references with closed geometry', () => {
    let seed = 42;
    const random = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296);
    const first = generateRounded(random); seed = 42;
    expect(generateRounded(random)).toEqual(first);
    for (let i = 0; i < 20; i++) {
      const scene = generateRounded(random), result = evaluateScene(wasm, scene);
      expect(Math.abs(scene.a.deform.bend)).toBeLessThanOrEqual(bendLimit(scene.a));
      expect(result.volume).toBeGreaterThan(0);
      expect(extractEdges(result).every(e => e.normals.length === 2)).toBe(true);
    }
  });
  it('bounds bending after a size edit and rejects invalid deformations', () => {
    const scene = straightScene(); scene.a.deform.bend = 120; scene.a.size = [8, 8, .4];
    expect(() => evaluateScene(wasm, scene)).toThrow('bend');
    constrainBend(scene.a); expect(scene.a.deform.bend).toBeLessThan(5);
    scene.a.deform.twist = NaN; expect(() => evaluateScene(wasm, scene)).toThrow('twist');
  });
});


describe('deformed operand combinations', () => {
  it.each(SHAPES)('$label supports every boolean operation after deformation', ({ id }) => {
    const scene = straightScene(); scene.a = makeShape(id, [3, 2.6, 5]);
    Object.assign(scene.a.deform, { twist: -120, taper: -.6, bulge: .3, bend: 25, roundness: .6 });
    constrainBend(scene.a);
    scene.b = makeShape('cone', [3.1, 3.1, 6]); scene.b.rotation = [20, 35, 10]; scene.b.position = [.7, 0, 0];
    for (const operation of ['subtract', 'union', 'intersect', 'reverse', 'exclude'] as const) {
      scene.operation = operation;
      const result = evaluateScene(wasm, scene);
      expect(result.volume).toBeGreaterThan(0); expect(result.overlapVolume).toBeGreaterThan(0);
      const edges = extractEdges(result);
      expect(edges.some(e => e.seam)).toBe(true);
      expect(edges.every(e => e.normals.length === 2 || (operation === 'exclude' && e.normals.length === 4))).toBe(true);
    }
  });
});
