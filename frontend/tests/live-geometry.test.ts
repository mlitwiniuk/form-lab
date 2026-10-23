import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { Vector3 } from 'three';
import { evaluateScene } from '../src/geometry';
import { edgeLines, extractEdges, packedEdgeLines, packEdges } from '../src/edges';
import { prepareRenderGeometry } from '../src/render-geometry';
import { cloneScene, PRESETS, shapeMatrix } from '../src/scene';
import { constructionLines, RESOLUTIONS, shapeMesh } from '../src/forms';
let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
describe('preview quality and worker-prepared drawing lines', () => {
  it.each(['Twisted box', 'Rounded bean', 'Pinched form', 'Bent cone', 'Ellipsoid'])('preview preset %s remains a closed solid close to the final volume', name => {
    const scene = cloneScene(PRESETS.find(p => p.name === name)!.scene);
    const preview = evaluateScene(wasm, scene, 'preview'), final = evaluateScene(wasm, scene);
    expect(preview.indices.length).toBeLessThan(final.indices.length / 2);
    expect(preview.volume / final.volume).toBeGreaterThan(.97);
    expect(preview.volume / final.volume).toBeLessThan(1.03);
    expect(extractEdges(preview).every(e => e.normals.length === 2)).toBe(true);
    expect(preview.sources.b.positions.length).toBe(0);
  });
  it('keeps all nine live cross-contours on preview mesh rings', () => {
    const shape = cloneScene(PRESETS.find(p => p.name === 'Rounded bean')!.scene).a, mesh = shapeMesh(shape, 'preview');
    const lines = constructionLines(shape, 9, 'preview');
    const key = (a: ArrayLike<number>) => Array.from(a).map(n => Math.round(Math.fround(n) * 1e5)).join(',');
    const points = new Set(Array.from({ length: mesh.positions.length / 3 }, (_, i) => key(mesh.positions.slice(i*3,i*3+3))));
    expect(lines.sections.length).toBe(9 * RESOLUTIONS.preview.radial * 6);
    for (let i=0;i<lines.sections.length;i+=3) expect(points.has(key(lines.sections.slice(i,i+3)))).toBe(true);
  });
  it.each(['subtract','exclude'] as const)('packed %s edge data preserves silhouettes and operand seams', operation => {
    const scene = cloneScene(PRESETS.find(p => p.name === 'Oblique passage')!.scene); scene.operation = operation;
    const result = evaluateScene(wasm, scene, 'preview'), edges = extractEdges(result);
    const camera = new Vector3(7,5,10), reference = edgeLines(edges,camera), packed = packedEdgeLines(packEdges(edges),camera);
    expect(packed.contour).toEqual(reference.contour); expect(packed.seam).toEqual(reference.seam);
  });
  it('transforms shared source-edge vertices once and includes transferable render data', () => {
    const scene = cloneScene(PRESETS.find(p => p.name === 'Twisted box')!.scene); scene.a.position = [2,1,3]; scene.a.rotation = [12,17,29];
    const result = evaluateScene(wasm, scene, 'preview');
    const first = extractEdges(result.sources.a)[0], matrix = shapeMatrix(scene.a);
    const prepared = prepareRenderGeometry(result,scene,'preview');
    const expected = [...first.a.applyMatrix4(matrix).toArray(), ...first.b.applyMatrix4(matrix).toArray()];
    expect(Array.from(prepared.sourceEdges.a.slice(0,6))).toEqual(expected.map(Math.fround));
    expect(prepared.sourceEdges.b.length).toBe(0);
  });
});
