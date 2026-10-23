import { CatmullRomCurve3, Quaternion, Vector3 } from 'three';
import type { Shape } from './scene';

const FRAME_STEPS = 192;
/** Parallel transport keeps sections stable through S-curve inflections. */
export function createSpineSampler(shape: Shape) {
  const points = shape.spine!;
  const curve = new CatmullRomCurve3(points.map(p => new Vector3(...p.position).multiply(new Vector3(...shape.size))), false, 'centripetal');
  const normals: Vector3[] = [], tangents: Vector3[] = [];
  const rotation = new Quaternion();
  for (let i = 0; i <= FRAME_STEPS; i++) {
    const tangent = curve.getTangent(i / FRAME_STEPS).normalize(); tangents.push(tangent);
    if (i === 0) {
      const normal = new Vector3(1, 0, 0).addScaledVector(tangent, -tangent.x);
      if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0).addScaledVector(tangent, -tangent.y);
      normals.push(normal.normalize());
    } else normals.push(normals[i - 1].clone().applyQuaternion(rotation.setFromUnitVectors(tangents[i - 1], tangent)).normalize());
  }
  return (u: number) => {
    u = Math.max(0, Math.min(1, u));
    const sample = u * FRAME_STEPS, index = Math.min(FRAME_STEPS - 1, Math.floor(sample));
    const tangent = curve.getTangent(u).normalize();
    const normal = normals[index].clone().lerp(normals[index + 1], sample - index);
    normal.addScaledVector(tangent, -normal.dot(tangent)).normalize();
    const binormal = new Vector3().crossVectors(tangent, normal).normalize();
    const segment = u * (points.length - 1), from = Math.min(points.length - 2, Math.floor(segment)), t = segment - from;
    // Smooth, bounded interpolation: no negative radii or thickness overshoot.
    const blend = t * t * (3 - 2 * t);
    const radius = points[from].radius + (points[from + 1].radius - points[from].radius) * blend;
    return { center: curve.getPoint(u), tangent, normal, binormal, radius };
  };
}
