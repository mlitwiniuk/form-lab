import { Vector3 } from 'three';
import type { GeometryResult } from './scene';

export interface FeatureEdge { a: Vector3; b: Vector3; normals: Vector3[]; origins: number[]; seam: boolean; crease: boolean }

/** Weld position-equivalent vertices, then classify edges by surface provenance and angle. */
export function extractEdges(mesh: Pick<GeometryResult, 'positions' | 'indices' | 'origins'>): FeatureEdge[] {
  const { positions, indices, origins } = mesh;
  const vertices = Array.from({ length: positions.length / 3 }, (_, i) => new Vector3().fromArray(positions, i * 3));
  // Manifold duplicates exact positions for normal/property seams. Rounding here
  // collapses short Boolean edges and can invent boundaries on deformed solids.
  const keys = vertices.map(v => [v.x, v.y, v.z].join(','));
  const edges = new Map<string, FeatureEdge>();
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]];
    const [a, b, c] = ids.map(id => vertices[id]);
    const normal = new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a)).normalize();
    for (let j = 0; j < 3; j++) {
      const from = ids[j], to = ids[(j + 1) % 3];
      const key = [keys[from], keys[to]].sort().join('|');
      let edge = edges.get(key);
      if (!edge) { edge = { a: vertices[from], b: vertices[to], normals: [], origins: [], seam: false, crease: false }; edges.set(key, edge); }
      edge.normals.push(normal); edge.origins.push(origins[i / 3]);
    }
  }
  for (const edge of edges.values()) {
    edge.seam = new Set(edge.origins).size > 1;
    edge.crease = edge.normals.length === 1 || (edge.normals.length > 1 && edge.normals[0].dot(edge.normals[1]) < Math.cos(Math.PI / 6));
  }
  return [...edges.values()];
}

export function edgeLines(edges: FeatureEdge[], camera: Vector3): { contour: number[]; seam: number[] } {
  const contour: number[] = [], seam: number[] = [];
  const midpoint = new Vector3(), view = new Vector3();
  for (const edge of edges) {
    midpoint.addVectors(edge.a, edge.b).multiplyScalar(.5);
    view.subVectors(camera, midpoint);
    const facing = edge.normals.map(n => n.dot(view));
    const silhouette = facing.some(v => v > 1e-7) && facing.some(v => v < -1e-7);
    if (edge.seam) seam.push(...edge.a.toArray(), ...edge.b.toArray());
    else if (edge.crease || silhouette) contour.push(...edge.a.toArray(), ...edge.b.toArray());
  }
  return { contour, seam };
}


/** Flat transferable records: endpoints, flags, normal count, then adjacent normals. */
export function packEdges(edges: FeatureEdge[]): Float32Array {
  const length = edges.reduce((sum, edge) => sum + 8 + edge.normals.length * 3, 0);
  const packed = new Float32Array(length); let offset = 0;
  for (const edge of edges) {
    packed.set([...edge.a.toArray(), ...edge.b.toArray(), (edge.seam ? 1 : 0) | (edge.crease ? 2 : 0), edge.normals.length], offset);
    offset += 8;
    for (const normal of edge.normals) { packed.set(normal.toArray(), offset); offset += 3; }
  }
  return packed;
}

/** No vectors, strings, adjacency rebuilding, or per-edge arrays on the render thread. */
export function packedEdgeLines(edges: Float32Array, camera: Vector3, showConnections = true): { contour: number[]; seam: number[] } {
  const contour: number[] = [], seam: number[] = [];
  for (let i = 0; i < edges.length;) {
    const x = camera.x - (edges[i] + edges[i + 3]) / 2;
    const y = camera.y - (edges[i + 1] + edges[i + 4]) / 2;
    const z = camera.z - (edges[i + 2] + edges[i + 5]) / 2;
    const flags = edges[i + 6], count = edges[i + 7];
    let front = false, back = false;
    for (let n = 0; n < count; n++) {
      const k = i + 8 + n * 3, dot = edges[k] * x + edges[k + 1] * y + edges[k + 2] * z;
      front ||= dot > 1e-7; back ||= dot < -1e-7;
    }
    // A connection can also form the outer silhouette. Keep that outline for the exercise.
    const out = flags & 1 ? (showConnections ? seam : front && back ? contour : null) : flags & 2 || (front && back) ? contour : null;
    if (out) out.push(edges[i], edges[i + 1], edges[i + 2], edges[i + 3], edges[i + 4], edges[i + 5]);
    i += 8 + count * 3;
  }
  return { contour, seam };
}
