import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { Vector3 } from 'three';
import { addShape, cloneScene, DEFAULT_SCENE, getShape, makeShape, MAX_SHAPES, PRESETS, removeShape, shapeEntries, validateScene, type Operation } from '../src/scene';
import { evaluateScene } from '../src/geometry';
import { extractEdges, packedEdgeLines, packEdges } from '../src/edges';
import { prepareRenderGeometry } from '../src/render-geometry';
import { geometryKey } from '../src/geometry-pipeline';
import { decodeStudy, DEFAULT_CAMERA, encodeStudy, parseSharedStudy, type SharedStudy } from '../src/share-state';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const combined = () => {
  const scene = cloneScene(DEFAULT_SCENE);
  scene.a = makeShape('box', [4, 4, 4]);
  scene.b = { ...makeShape('box', [4, 4, 4]), position: [2, 0, 0] };
  scene.extraShapes = [{ ...makeShape('box', [4, 4, 4]), position: [1, 0, 0] }];
  scene.operation = 'union'; return scene;
};
const study = (): SharedStudy => ({ version: 2, scene: combined(), camera: structuredClone(DEFAULT_CAMERA),
  reveals: { cutter: true, construction: false, hidden: true, seam: false }, locked: false, focus: false });

describe('basic starting points and editable collections', () => {
  it('starts on an undeformed cube with no Boolean operation', () => {
    expect(PRESETS[0].name).toBe('Cube');
    expect(PRESETS[0].scene).toEqual(DEFAULT_SCENE);
    expect(DEFAULT_SCENE.operation).toBe('single');
    expect(DEFAULT_SCENE.a).toEqual(makeShape('box', [3, 3, 3]));
    expect(evaluateScene(wasm, DEFAULT_SCENE).volume).toBe(27);
    expect(extractEdges(evaluateScene(wasm, DEFAULT_SCENE)).filter(e => e.crease)).toHaveLength(12);
    expect(PRESETS.filter(p => p.group === 'Basics').every(p => p.scene.operation === 'single')).toBe(true);
  });
  it('adds independent forms, selects their IDs and enforces the six-form limit', () => {
    const scene = cloneScene(DEFAULT_SCENE);
    for (const kind of ['sphere', 'cylinder', 'cone', 'rounded', 'box'] as const) {
      const id = addShape(scene, kind);
      expect(getShape(scene, id).kind).toBe(kind);
      validateScene(scene);
    }
    expect(scene.operation).toBe('union');
    expect(shapeEntries(scene)).toHaveLength(MAX_SHAPES);
    expect(() => addShape(scene, 'box')).toThrow(/six|6/);
    const clone = cloneScene(scene); getShape(clone, 'c').size[0] = 5;
    expect(getShape(scene, 'c').size[0]).toBe(3);
  });
  it('removes any operand, promotes the remaining forms and returns to a single form', () => {
    const scene = combined();
    scene.extraShapes![0].deform.twist = 40;
    const kept = structuredClone(scene.extraShapes![0]);
    expect(removeShape(scene, 'b')).toBe('b');
    expect(scene.b).toEqual(kept); expect(scene.extraShapes).toBeUndefined();
    expect(removeShape(scene, 'a')).toBe('a');
    expect(scene.a).toEqual(kept); expect(scene.operation).toBe('single');
    expect(shapeEntries(scene)).toHaveLength(1);
    removeShape(scene, 'a'); expect(scene.a).toEqual(kept);
  });
  it('includes every active form in the geometry cache key', () => {
    const scene = combined(), before = geometryKey(scene);
    getShape(scene, 'c').position[0] += .1;
    expect(geometryKey(scene)).not.toBe(before);
    scene.operation = 'single'; const single = geometryKey(scene);
    getShape(scene, 'c').deform.twist = 80;
    expect(geometryKey(scene)).toBe(single);
    scene.contours = 8; expect(geometryKey(scene)).toBe(single);
  });
});

describe('multi-form operations and connection lines', () => {
  it.each<Operation>(['union', 'subtract', 'intersect', 'reverse', 'exclude'])('%s evaluates all three operands with defined grouping', operation => {
    const scene = combined(); scene.operation = operation;
    const mesh = evaluateScene(wasm, scene);
    expect(mesh.volume).toBeCloseTo({ union: 96, subtract: 16, intersect: 32, reverse: 32, exclude: 48, single: 64 }[operation], 5);
    expect(mesh.overlapVolume).toBeCloseTo(operation === 'intersect' ? 32 : 48, 5);
    expect(Object.keys(mesh.sources)).toEqual(['a', 'b', 'c']);
    expect(extractEdges(mesh).every(edge => edge.normals.length === 2)).toBe(true);
  });
  it('preserves each source outline and connection provenance after joining three different forms', () => {
    const scene = combined(); scene.b = makeShape('cylinder', [2, 2, 7]);
    scene.extraShapes = [{ ...makeShape('sphere', [3, 3, 3]), position: [1.8, .5, .5] }];
    const result = prepareRenderGeometry(evaluateScene(wasm, scene, 'preview'), scene, 'preview');
    expect(new Set(result.origins).size).toBe(3);
    for (const [id] of shapeEntries(scene)) expect(result.sourceEdges[id]!.length).toBeGreaterThan(0);
    const camera = new Vector3(7, 6, 10);
    const shown = packedEdgeLines(result.featureEdges, camera), hidden = packedEdgeLines(result.featureEdges, camera, false);
    expect(shown.seam.length).toBeGreaterThan(0);
    expect(hidden.seam).toEqual([]);
    expect(hidden.contour.length).toBeGreaterThanOrEqual(shown.contour.length);
    expect(packedEdgeLines(result.featureEdges, camera, true)).toEqual(shown);
  });
  it('keeps an outer silhouette where a hidden connection reaches the outline', () => {
    const edge = { a: new Vector3(0, 0, 0), b: new Vector3(0, 0, 1), origins: [1, 2], seam: true, crease: true };
    const camera = new Vector3(5, 5, 5);
    const interior = packEdges([{ ...edge, normals: [new Vector3(1, 0, 0), new Vector3(0, 1, 0)] }]);
    const silhouette = packEdges([{ ...edge, normals: [new Vector3(1, 0, 0), new Vector3(0, -1, 0)] }]);
    expect(packedEdgeLines(interior, camera, false)).toEqual({ contour: [], seam: [] });
    expect(packedEdgeLines(silhouette, camera, false)).toEqual({ contour: [0, 0, 0, 0, 0, 1], seam: [] });
  });
  it('evaluates six operands and excludes dormant forms in single mode', () => {
    const scene = combined();
    for (let i = 0; i < 3; i++) addShape(scene, 'box');
    expect(evaluateScene(wasm, scene, 'preview').volume).toBeGreaterThan(96);
    scene.operation = 'single';
    const mesh = evaluateScene(wasm, scene); expect(mesh.volume).toBe(64);
    expect(Object.keys(mesh.sources)).toEqual(['a', 'b']);
    expect(mesh.sources.b.positions).toHaveLength(0);
  });
});

describe('shared multi-form studies', () => {
  it('round-trips all six deformed forms, control points, and the hidden-connection setting', () => {
    const original = study();
    for (let i = 0; i < 3; i++) addShape(original.scene, 'rounded');
    for (const [id, shape] of shapeEntries(original.scene)) {
      shape.deform.twist = id.charCodeAt(0) - 90;
      if (shape.kind === 'rounded') shape.spine = structuredClone(PRESETS.find(p => p.name === 'S-curve')!.scene.a.spine);
    }
    const link = encodeStudy(original);
    expect(link.length).toBeLessThan(12000);
    expect(decodeStudy(link)).toEqual(original);
  });
  it('still decodes version-one two-form links', () => {
    const original: SharedStudy = { ...study(), version: 1, scene: cloneScene(PRESETS.find(p => p.name === 'Oblique passage')!.scene) };
    expect(decodeStudy(encodeStudy(original))).toEqual(original);
    expect(parseSharedStudy(original)).toEqual(original);
  });
  it('rejects oversized or malformed additional shapes', () => {
    const original = study();
    original.scene.extraShapes = Array(5).fill(makeShape('box'));
    expect(() => encodeStudy(original)).toThrow();
    original.scene.extraShapes = [makeShape('box')]; original.scene.extraShapes[0].size[0] = 0;
    expect(() => encodeStudy(original)).toThrow();
    expect(() => parseSharedStudy({ ...study(), scene: { ...combined(), extraShapes: {} } })).toThrow();
  });
});
