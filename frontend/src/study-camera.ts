import { Box3, MathUtils, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { Vec3 } from './scene';

export type Projection = 'perspective' | 'orthographic';
export type CameraView = '3d' | 'front' | 'side' | 'top';
export type OrbitMode = 'free' | 'turn' | 'tilt';
export interface ViewAngles { turn: number; tilt: number }
export interface CameraState {
  position: Vec3;
  target: Vec3;
  projection?: Projection;
  /** World units across the shorter viewport dimension, independent of device orientation. */
  orthographicSpan?: number;
  orbitMode?: OrbitMode;
}
export const DEFAULT_CAMERA: CameraState = { position: [7.2, 5.5, 9.8], target: [0, 0, 0] };
export const MIN_CAMERA_DISTANCE = 5, MAX_CAMERA_DISTANCE = 45;
export const MIN_ORTHOGRAPHIC_SPAN = .1, MAX_ORTHOGRAPHIC_SPAN = 200;
const BASE_SPAN = 10, TANGENT = Math.tan(MathUtils.degToRad(34) / 2);

export function viewAngles(view: Pick<CameraState, 'position' | 'target'>): ViewAngles {
  const [x, y, z] = view.position.map((value, axis) => value - view.target[axis]);
  return { turn: MathUtils.radToDeg(Math.atan2(x, z)), tilt: MathUtils.radToDeg(Math.atan2(y, Math.hypot(x, z))) };
}

/** Camera math is independent of the renderer, geometry worker, and input controls. */
export class StudyCamera {
  private readonly perspective = new PerspectiveCamera(34, 1, .05, 120);
  private readonly orthographic = new OrthographicCamera(-5, 5, 5, -5, .05, 120);
  readonly target = new Vector3();
  projection: Projection = 'perspective';
  orbitMode: OrbitMode = 'free';
  readonly minZoom = BASE_SPAN / MAX_ORTHOGRAPHIC_SPAN;
  readonly maxZoom = BASE_SPAN / MIN_ORTHOGRAPHIC_SPAN;

  constructor() { this.setState(DEFAULT_CAMERA); }

  get camera() { return this.projection === 'orthographic' ? this.orthographic : this.perspective; }
  get orthographicSpan() { return BASE_SPAN / this.orthographic.zoom; }

  resize(width: number, height: number) {
    const aspect = Math.max(1, width) / Math.max(1, height);
    this.perspective.aspect = aspect;
    this.perspective.fov = MathUtils.radToDeg(2 * Math.atan(TANGENT / Math.min(1, aspect)));
    this.perspective.updateProjectionMatrix();
    this.orthographic.right = BASE_SPAN / 2 * Math.max(1, aspect);
    this.orthographic.left = -this.orthographic.right;
    this.orthographic.top = BASE_SPAN / 2 / Math.min(1, aspect);
    this.orthographic.bottom = -this.orthographic.top;
    this.orthographic.updateProjectionMatrix();
  }

  setProjection(projection: Projection) {
    if (projection === this.projection) return;
    const previous = this.camera;
    const direction = previous.position.clone().sub(this.target).normalize();
    const distance = previous.position.distanceTo(this.target);
    this.projection = projection;
    this.camera.position.copy(previous.position);
    this.camera.up.copy(previous.up);
    if (projection === 'orthographic') {
      this.setSpan(2 * distance * TANGENT);
    } else {
      // Match the scale at the orbit target, within the existing dolly limits.
      const nextDistance = MathUtils.clamp(this.orthographicSpan / (2 * TANGENT), MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
      this.camera.position.copy(this.target).addScaledVector(direction, nextDistance);
    }
    this.orient();
  }

  setView(view: CameraView) {
    const directions: Record<CameraView, Vec3> = { '3d': [7.2, 5.5, 9.8], front: [0, 0, 1], side: [1, 0, 0], top: [0, 1, .00001] };
    const distance = this.camera.position.distanceTo(this.target);
    this.camera.position.copy(this.target).addScaledVector(new Vector3(...directions[view]).normalize(), distance);
    this.orient();
  }

  getAngles(): ViewAngles { return viewAngles({ position: this.camera.position.toArray(), target: this.target.toArray() }); }

  setAngle(axis: keyof ViewAngles, degrees: number) {
    if (!Number.isFinite(degrees)) return;
    const angles = this.getAngles(); angles[axis] = degrees;
    const turn = MathUtils.degToRad(MathUtils.clamp(angles.turn, -180, 180));
    // OrbitControls needs a tiny offset at the poles to keep the heading defined.
    const tilt = MathUtils.clamp(MathUtils.degToRad(angles.tilt), -Math.PI / 2 + 1e-6, Math.PI / 2 - 1e-6);
    const distance = this.camera.position.distanceTo(this.target), horizontal = distance * Math.cos(tilt);
    this.camera.position.copy(this.target).add(new Vector3(horizontal * Math.sin(turn), distance * Math.sin(tilt), horizontal * Math.cos(turn)));
    this.orient();
  }

  levelView() { this.setAngle('tilt', 0); this.orbitMode = 'turn'; }

  getOrbitLimits() {
    const angles = this.getAngles(), polar = MathUtils.degToRad(90 - angles.tilt), azimuth = MathUtils.degToRad(angles.turn);
    return {
      minPolarAngle: this.orbitMode === 'turn' ? polar : 0,
      maxPolarAngle: this.orbitMode === 'turn' ? polar : Math.PI,
      minAzimuthAngle: this.orbitMode === 'tilt' ? azimuth : -Infinity,
      maxAzimuthAngle: this.orbitMode === 'tilt' ? azimuth : Infinity,
    };
  }

  fit(points: Vector3[]) {
    if (!points.length) return;
    const center = new Box3().setFromPoints(points).getCenter(new Vector3());
    const direction = this.camera.position.clone().sub(this.target).normalize();
    const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    let radius = 0, distance = MIN_CAMERA_DISTANCE;
    for (const vertex of points) {
      const point = vertex.clone().sub(center);
      const extent = 1.2 * Math.max(Math.abs(point.dot(right)), Math.abs(point.dot(up)));
      radius = Math.max(radius, extent);
      distance = Math.max(distance, point.dot(direction) + (this.projection === 'orthographic' ? 1 : extent / TANGENT));
    }
    if (this.projection === 'orthographic') {
      this.setSpan(2 * radius);
      distance = Math.max(distance, this.camera.position.distanceTo(this.target));
    }
    this.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, Math.min(distance, MAX_CAMERA_DISTANCE));
    this.orient();
  }

  getState(): CameraState {
    return { position: this.camera.position.toArray(), target: this.target.toArray(), projection: this.projection,
      ...(this.projection === 'orthographic' ? { orthographicSpan: this.orthographicSpan } : {}),
      ...(this.orbitMode !== 'free' ? { orbitMode: this.orbitMode } : {}) };
  }

  setState(view: CameraState) {
    this.projection = view.projection ?? 'perspective';
    this.orbitMode = view.orbitMode ?? 'free';
    this.target.fromArray(view.target);
    this.camera.position.fromArray(view.position);
    if (this.projection === 'orthographic') this.setSpan(view.orthographicSpan ?? 2 * this.camera.position.distanceTo(this.target) * TANGENT);
    this.orient();
  }

  private setSpan(span: number) {
    this.orthographic.zoom = BASE_SPAN / MathUtils.clamp(span, MIN_ORTHOGRAPHIC_SPAN, MAX_ORTHOGRAPHIC_SPAN);
    this.orthographic.updateProjectionMatrix();
  }

  private orient() {
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld(true);
  }
}
