import { extractEdges, packEdges } from './edges';
import { shapeMatrix, type GeometryResult, type SceneState, type ShapeId } from './scene';
import type { GeometryQuality } from './forms';

export interface RenderGeometry extends GeometryResult {
  quality: GeometryQuality;
  featureEdges: Float32Array;
  sourceEdges: Record<ShapeId, Float32Array>;
  preparationDuration: number;
}
/** Expensive adjacency/provenance work stays in the worker, not in an input handler. */
export function prepareRenderGeometry(result: GeometryResult, scene: SceneState, quality: GeometryQuality): RenderGeometry {
  const start = performance.now();
  const source = (id: ShapeId) => {
    const matrix = shapeMatrix(scene[id]);
    return packEdges(extractEdges(result.sources[id]).map(edge => ({ ...edge,
      a: edge.a.clone().applyMatrix4(matrix), b: edge.b.clone().applyMatrix4(matrix),
      normals: edge.normals.map(n => n.clone().transformDirection(matrix)),
    })));
  };
  const sourceEdges = { a: source('a'), b: source('b') };
  return { ...result, quality, sourceEdges, featureEdges: scene.operation === 'single' ? sourceEdges.a : packEdges(extractEdges(result)), preparationDuration: performance.now() - start };
}
