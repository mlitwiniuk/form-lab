import { extractEdges, packEdges } from './edges';
import { shapeEntries, getShape, shapeMatrix, type GeometryResult, type SceneState, type ShapeMap, type ShapeId } from './scene';
import type { GeometryQuality } from './forms';

export interface RenderGeometry extends GeometryResult {
  quality: GeometryQuality;
  featureEdges: Float32Array;
  sourceEdges: ShapeMap<Float32Array>;
  preparationDuration: number;
}
/** Expensive adjacency/provenance work stays in the worker, not in an input handler. */
export function prepareRenderGeometry(result: GeometryResult, scene: SceneState, quality: GeometryQuality): RenderGeometry {
  const start = performance.now();
  const source = (id: ShapeId) => {
    const matrix = shapeMatrix(getShape(scene, id));
    return packEdges(extractEdges(result.sources[id]!).map(edge => ({ ...edge,
      a: edge.a.clone().applyMatrix4(matrix), b: edge.b.clone().applyMatrix4(matrix),
      normals: edge.normals.map(n => n.clone().transformDirection(matrix)),
    })));
  };
  const sourceEdges: ShapeMap<Float32Array> = { a: new Float32Array(), b: new Float32Array() };
  for (const [id] of shapeEntries(scene)) sourceEdges[id] = source(id);
  return { ...result, quality, sourceEdges, featureEdges: scene.operation === 'single' ? sourceEdges.a : packEdges(extractEdges(result)), preparationDuration: performance.now() - start };
}
