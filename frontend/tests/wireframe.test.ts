import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { Vector3 } from 'three';
import { evaluateScene } from '../src/geometry';
import { prepareRenderGeometry } from '../src/render-geometry';
import { packedEdgeLines, sourceEdgeLines } from '../src/edges';
import { addShape, cloneScene, DEFAULT_SCENE } from '../src/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const camera = new Vector3(7, 5, 10);

describe('transparent form outlines', () => {
  it('draws exactly twelve cube edges, including the back edges, with no face diagonals', () => {
    const scene = cloneScene(DEFAULT_SCENE);
    const geometry = prepareRenderGeometry(evaluateScene(wasm, scene), scene, 'final');
    const lines = sourceEdgeLines(geometry.sourceEdges, camera);
    expect(lines.length / 6).toBe(12);
    for (let i = 0; i < lines.length; i += 6) {
      expect([0, 1, 2].filter(axis => lines[i + axis] !== lines[i + axis + 3])).toHaveLength(1);
      expect(Math.hypot(...[0, 1, 2].map(axis => lines[i + axis] - lines[i + axis + 3]))).toBe(3);
    }
    // Camera changes do not remove any back-facing box edges.
    expect(sourceEdgeLines(geometry.sourceEdges, camera.clone().negate())).toEqual(lines);
  });
  it.each(['union', 'subtract', 'intersect', 'reverse', 'exclude'] as const)('keeps both complete boxes for %s, independently of connection reveals', operation => {
    const scene = cloneScene(DEFAULT_SCENE); scene.operation = operation;
    const geometry = prepareRenderGeometry(evaluateScene(wasm, scene), scene, 'final');
    const lines = sourceEdgeLines(geometry.sourceEdges, camera);
    expect(lines.length / 6).toBe(24);
    expect(packedEdgeLines(geometry.featureEdges, camera, true).seam.length).toBeGreaterThan(0);
    expect(packedEdgeLines(geometry.featureEdges, camera, false).seam).toEqual([]);
    expect(sourceEdgeLines(geometry.sourceEdges, camera)).toEqual(lines);
  });
  it('includes all six forms, but only the active form in a single-form study', () => {
    const scene = cloneScene(DEFAULT_SCENE);
    for (let i = 0; i < 5; i++) addShape(scene, 'box');
    let geometry = prepareRenderGeometry(evaluateScene(wasm, scene), scene, 'final');
    expect(sourceEdgeLines(geometry.sourceEdges, camera).length / 6).toBe(72);
    scene.operation = 'single';
    geometry = prepareRenderGeometry(evaluateScene(wasm, scene), scene, 'final');
    expect(sourceEdgeLines(geometry.sourceEdges, camera).length / 6).toBe(12);
  });
});
