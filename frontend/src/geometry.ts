import type { ManifoldToplevel, Manifold, Mat4 } from 'manifold-3d';
import { shapeEntries, shapeMatrix, validateScene, type GeometryResult, type MeshData, type SceneState, type Shape, type ShapeMap } from './scene';
import { RESOLUTIONS, shapeMesh, type GeometryQuality } from './forms';

function readMesh(solid: Manifold): MeshData & { normals: Float32Array } {
  const mesh = solid.getMesh();
  const positions = new Float32Array(mesh.numVert * 3), normals = new Float32Array(mesh.numProp >= 6 ? mesh.numVert * 3 : 0);
  for (let i = 0; i < mesh.numVert; i++) {
    positions.set(mesh.vertProperties.subarray(i * mesh.numProp, i * mesh.numProp + 3), i * 3);
    if (mesh.numProp >= 6) normals.set(mesh.vertProperties.subarray(i * mesh.numProp + 3, i * mesh.numProp + 6), i * 3);
  }
  const origins = new Uint32Array(mesh.triVerts.length / 3);
  for (let run = 0; run < mesh.runOriginalID.length; run++) origins.fill(mesh.runOriginalID[run], mesh.runIndex[run] / 3, mesh.runIndex[run + 1] / 3);
  return { positions, normals, indices: new Uint32Array(mesh.triVerts), origins };
}

/** Run in a worker; preserve source IDs through deformations and solid operations. */
export function evaluateScene(wasm: ManifoldToplevel, scene: SceneState, quality: GeometryQuality = 'final'): GeometryResult {
  validateScene(scene);
  const start = performance.now(), owned: Manifold[] = [];
  const own = (m: Manifold) => { owned.push(m); return m; };
  const create = (shape: Shape) => {
    const d = shape.deform, simple = !d.twist && !d.bend && !d.taper && !d.bulge;
    if (simple && shape.kind === 'box' && d.roundness === 0) return own(wasm.Manifold.cube(shape.size, true));
    if (simple && shape.kind === 'cylinder' && d.roundness === 1) return own(own(wasm.Manifold.cylinder(shape.size[2], .5, .5, RESOLUTIONS[quality].radial, true)).scale([shape.size[0], shape.size[1], 1]));
    const mesh = shapeMesh(shape, quality);
    return own(new wasm.Manifold(new wasm.Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices })));
  };
  try {
    const empty = { positions: new Float32Array(), indices: new Uint32Array(), origins: new Uint32Array() };
    const sources: ShapeMap<MeshData> = { a: empty, b: empty };
    const solids = shapeEntries(scene).map(([id, shape]) => {
      const source = create(shape);
      sources[id] = readMesh(source);
      return own(source.transform(shapeMatrix(shape).elements as Mat4));
    });
    const [a, ...others] = solids;
    let result = a, bVolume = 0;
    if (others.length) {
      if (scene.operation === 'intersect') {
        result = others.reduce((current, next) => own(current.intersect(next)), a);
      } else {
        // Treat all additional forms as one operand for cuts and overlap removal.
        const b = others.slice(1).reduce((current, next) => own(current.add(next)), others[0]);
        bVolume = b.volume();
        result = scene.operation === 'union' ? own(a.add(b)) : scene.operation === 'reverse' ? own(b.subtract(a))
          : scene.operation === 'exclude' ? own(own(a.subtract(b)).add(own(b.subtract(a)))) : own(a.subtract(b));
      }
    }
    if (result.status() !== 'NoError') throw new Error(`The geometry could not be computed (${result.status()}).`);
    const shaded = own(result.calculateNormals(0, 30));
    const volume = result.volume(), bodyVolume = a.volume();
    // Volume identities avoid doing a second Boolean solely for the status label.
    const overlapVolume = scene.operation === 'single' ? 0 : scene.operation === 'intersect' ? volume
      : scene.operation === 'subtract' ? bodyVolume - volume : scene.operation === 'reverse' ? bVolume - volume
      : (bodyVolume + bVolume - volume) / (scene.operation === 'exclude' ? 2 : 1);
    return { ...readMesh(shaded), sources,
      volume, bodyVolume, overlapVolume: Math.max(0, overlapVolume), duration: performance.now() - start };

  } finally { owned.reverse().forEach(m => m.delete()); }
}
