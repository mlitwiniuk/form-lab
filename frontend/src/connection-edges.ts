import type { Manifold } from 'manifold-3d';
import { Vector3 } from 'three';
import { extractEdges, packEdges } from './edges';
import type { MeshData, Vec3 } from './scene';

/** The union clips buried intersections, irrespective of the study's operation. */
export function exteriorConnectionEdges(mesh: MeshData, originals: ReadonlyMap<number, Manifold>): Float32Array {
  const sharedFaces = new Map<string, boolean>();
  const sharesFace = (triangle: number, normal: Vector3, otherOrigin: number) => {
    const key = `${triangle}:${otherOrigin}`, cached = sharedFaces.get(key);
    if (cached !== undefined) return cached;
    const center = new Vector3();
    for (let corner = 0; corner < 3; corner++) {
      center.add(new Vector3().fromArray(mesh.positions, mesh.indices[triangle * 3 + corner] * 3));
    }
    center.multiplyScalar(1 / 3);
    // Float32 output can sit slightly off the original double-precision surface.
    // Probe a triangle interior, not the edge itself (which both forms share).
    const tolerance = Math.max(1, Math.abs(center.x), Math.abs(center.y), Math.abs(center.z)) * 1e-6;
    const start = center.clone().addScaledVector(normal, tolerance * 10).toArray() as Vec3;
    const end = center.clone().addScaledVector(normal, -tolerance * 10).toArray() as Vec3;
    const shared = originals.get(otherOrigin)!.rayCast(start, end)
      .some(hit => center.distanceToSquared(new Vector3(...hit.position)) <= tolerance ** 2);
    sharedFaces.set(key, shared);
    return shared;
  };
  return packEdges(extractEdges(mesh).filter(edge => {
    if (!edge.seam || edge.normals.length !== 2) return false;
    // A crossing creates a concave join. Flat/convex ownership changes along
    // coincident faces are existing outlines, not new connections.
    const turn = new Vector3().subVectors(edge.b, edge.a).normalize()
      .dot(new Vector3().crossVectors(edge.normals[0], edge.normals[1]));
    if (turn >= -1e-7) return false;
    // Coincident bent forms can also have concave edges. Both retained faces
    // must actually extend outside the other source, rather than share its skin.
    return !sharesFace(edge.triangles[0], edge.normals[0], edge.origins[1])
      && !sharesFace(edge.triangles[1], edge.normals[1], edge.origins[0]);
  }));
}
