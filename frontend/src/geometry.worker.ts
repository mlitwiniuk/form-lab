import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { evaluateScene } from './geometry';
import { prepareRenderGeometry } from './render-geometry';
import type { GeometryRequest } from './geometry-pipeline';

const ready = Module({ locateFile: () => wasmUrl }).then(module => { module.setup(); return module; });
self.onmessage = async (event: MessageEvent<GeometryRequest>) => {
  const { revision, scene, quality } = event.data;
  try {
    const result = prepareRenderGeometry(evaluateScene(await ready, scene, quality), scene, quality);
    self.postMessage({ revision, result }, { transfer: [...new Set([result.positions.buffer, result.indices.buffer, result.origins.buffer,
      result.normals.buffer, result.featureEdges.buffer, result.sourceEdges.a.buffer, result.sourceEdges.b.buffer,
      ...Object.values(result.sources).flatMap(s => [s.positions.buffer, s.indices.buffer, s.origins.buffer])])] });
  } catch (error) {
    self.postMessage({ revision, error: error instanceof Error ? error.message : 'The geometry engine could not complete this edit.' });
  }
};
