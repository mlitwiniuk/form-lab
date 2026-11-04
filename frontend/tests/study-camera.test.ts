import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Raycaster, Vector2, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StudyCamera, DEFAULT_CAMERA, MAX_CAMERA_DISTANCE, MIN_CAMERA_DISTANCE, type Projection, type OrbitMode } from '../src/study-camera';
import { edgeLines, packedEdgeLines, packEdges, sourceEdgeLines, type FeatureEdge } from '../src/edges';

const cube = Array.from({ length: 8 }, (_, i) => new Vector3(i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1));
function direction(view: StudyCamera, a: Vector3, b: Vector3) {
  view.camera.updateMatrixWorld(true);
  const first = a.clone().project(view.camera), second = b.clone().project(view.camera);
  return new Vector2(second.x - first.x, second.y - first.y).normalize();
}

describe('independent view rotation', () => {
  const controlled = (projection: Projection, mode: OrbitMode) => {
    const view = new StudyCamera(); view.setProjection(projection); view.orbitMode = mode;
    const orbit = new OrbitControls(view.camera); orbit.target = view.target;
    const sync = () => { orbit.object = view.camera; Object.assign(orbit, view.getOrbitLimits()); orbit.update(); };
    sync(); return { view, orbit, sync };
  };

  it.each<Projection>(['perspective', 'orthographic'])('changes one angle while preserving the target, distance, and zoom in %s', projection => {
    const { view } = controlled(projection, 'free');
    const offset = new Vector3(2, -3, 1); view.camera.position.add(offset); view.target.add(offset);
    const target = view.target.clone(), distance = view.camera.position.distanceTo(view.target), zoom = view.camera.zoom;
    const before = view.getAngles();
    view.setAngle('turn', 72.5);
    expect(view.getAngles().turn).toBeCloseTo(72.5, 10); expect(view.getAngles().tilt).toBeCloseTo(before.tilt, 10);
    view.setAngle('tilt', -12.5);
    expect(view.getAngles().turn).toBeCloseTo(72.5, 10); expect(view.getAngles().tilt).toBeCloseTo(-12.5, 10);
    expect(view.camera.position.distanceTo(view.target)).toBeCloseTo(distance, 10);
    expect(view.camera.zoom).toBe(zoom); expect(view.target).toEqual(target);
  });

  it.each<Projection>(['perspective', 'orthographic'])('blocks tilt during horizontal dragging and turn during vertical dragging in %s', projection => {
    const { view, orbit, sync } = controlled(projection, 'turn');
    const before = view.getAngles();
    orbit.rotateUp(.3); orbit.rotateLeft(.4);
    expect(view.getAngles().tilt).toBeCloseTo(before.tilt, 8);
    expect(Math.abs(view.getAngles().turn - before.turn)).toBeGreaterThan(10);
    view.orbitMode = 'tilt'; sync();
    const turned = view.getAngles();
    orbit.rotateLeft(.3); orbit.rotateUp(.2);
    expect(view.getAngles().turn).toBeCloseTo(turned.turn, 8);
    expect(Math.abs(view.getAngles().tilt - turned.tilt)).toBeGreaterThan(5);
    view.orbitMode = 'free'; sync();
    const tilted = view.getAngles();
    orbit.rotateLeft(.2); orbit.rotateUp(.2);
    expect(Math.abs(view.getAngles().turn - tilted.turn)).toBeGreaterThan(5);
    expect(Math.abs(view.getAngles().tilt - tilted.tilt)).toBeGreaterThan(5);
  });

  it('creates a level shallow side view, with vertical edges upright during one-axis dragging', () => {
    const { view, orbit, sync } = controlled('orthographic', 'free');
    view.setView('side'); view.levelView(); view.setAngle('turn', 75); sync();
    expect(view.orbitMode).toBe('turn'); expect(view.getAngles().tilt).toBeCloseTo(0, 10);
    const zoom = view.camera.zoom;
    for (const angle of [.2, -.4, 1]) {
      orbit.rotateLeft(angle); orbit.rotateUp(.1);
      const vertical = direction(view, cube[0], cube[2]);
      expect(vertical.x).toBeCloseTo(0, 10); expect(vertical.y).toBeCloseTo(1, 10);
      expect(view.getAngles().tilt).toBeCloseTo(0, 10);
    }
    expect(view.camera.zoom).toBe(zoom);
  });

  it('retargets the axis constraint after using presets or explicitly editing the other angle', () => {
    const { view, orbit, sync } = controlled('perspective', 'turn');
    view.setView('side'); sync();
    expect(view.getAngles().tilt).toBeCloseTo(0, 10);
    view.setAngle('tilt', 12); sync(); orbit.rotateUp(.4);
    expect(view.getAngles().tilt).toBeCloseTo(12, 8);
    view.orbitMode = 'tilt'; view.setAngle('turn', -175); sync(); orbit.rotateLeft(.5);
    expect(view.getAngles().turn).toBeCloseTo(-175, 8);
  });

  it('allows panning and zooming with a constrained axis and survives a projection change', () => {
    const { view, orbit, sync } = controlled('orthographic', 'turn');
    const before = view.getAngles(), offset = new Vector3(2, -1, .5);
    view.camera.position.add(offset); view.target.add(offset);
    view.camera.zoom *= 1.25; view.camera.updateProjectionMatrix(); orbit.update();
    expect(view.getAngles().turn).toBeCloseTo(before.turn, 8); expect(view.getAngles().tilt).toBeCloseTo(before.tilt, 8);
    view.setProjection('perspective'); sync(); orbit.rotateUp(.3);
    expect(view.orbitMode).toBe('turn'); expect(view.getAngles().tilt).toBeCloseTo(before.tilt, 8);
  });

  it('handles both poles and the rear view without NaNs or an inverted reference', () => {
    const { view, orbit, sync } = controlled('orthographic', 'tilt');
    for (const turn of [-180, 180]) for (const tilt of [-90, 90]) {
      view.setAngle('turn', turn); view.setAngle('tilt', tilt); sync(); orbit.rotateLeft(.1);
      expect(view.camera.matrixWorld.elements.every(Number.isFinite)).toBe(true);
      expect(Math.abs(view.getAngles().turn)).toBeCloseTo(180, 6);
      expect(view.getAngles().tilt).toBeCloseTo(tilt, 3);
    }
    view.levelView(); sync();
    expect(view.getAngles().tilt).toBeCloseTo(0, 8);
  });
});

describe('orthographic drawing reference', () => {
  it('keeps all three families of cube edges parallel, with genuine perspective when switched back', () => {
    const view = new StudyCamera(); view.setProjection('orthographic');
    expect(view.camera).toBeInstanceOf(OrthographicCamera);
    for (const axis of [1, 2, 4]) {
      const directions = cube.flatMap((point, i) => i & axis ? [] : [direction(view, point, cube[i | axis])]);
      for (const vector of directions) expect(vector.distanceTo(directions[0])).toBeLessThan(1e-10);
    }
    view.setProjection('perspective');
    expect(view.camera).toBeInstanceOf(PerspectiveCamera);
    expect(direction(view, cube[0], cube[1]).distanceTo(direction(view, cube[6], cube[7]))).toBeGreaterThan(.01);
  });

  it.each([[1400, 800], [390, 600], [1024, 768]])('matches scale at the orbit target when switching on a %s×%s viewport', (width, height) => {
    const view = new StudyCamera(); view.resize(width, height);
    const right = new Vector3(1, 0, 0).applyQuaternion(view.camera.quaternion);
    const before = right.clone().project(view.camera);
    const position = view.camera.position.clone(), orientation = view.camera.quaternion.clone();
    view.setProjection('orthographic');
    const after = right.clone().project(view.camera);
    expect(after.x).toBeCloseTo(before.x, 10); expect(after.y).toBeCloseTo(before.y, 10);
    expect(view.camera.position.distanceTo(position)).toBeLessThan(1e-10);
    expect(view.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    view.setProjection('perspective');
    expect(view.camera.position.distanceTo(position)).toBeLessThan(1e-10);
  });

  it('retains orthographic zoom after resizing and restoring a view on another device', () => {
    const view = new StudyCamera(); view.resize(1200, 800); view.setProjection('orthographic');
    view.camera.zoom *= 1.7; view.camera.updateProjectionMatrix();
    const state = view.getState();
    const restored = new StudyCamera(); restored.resize(390, 600); restored.setState(state);
    expect(restored.orthographicSpan).toBeCloseTo(state.orthographicSpan!, 10);
    expect(restored.camera.position).toEqual(view.camera.position);
    const pixelsPerUnit = (camera: OrthographicCamera, width: number) => width * camera.zoom / (camera.right - camera.left);
    expect(pixelsPerUnit(restored.camera as OrthographicCamera, 390) / 390).toBeCloseTo(pixelsPerUnit(view.camera as OrthographicCamera, 1200) / 800, 10);
    restored.resize(800, 1200);
    expect(restored.orthographicSpan).toBeCloseTo(state.orthographicSpan!, 10);
  });

  it.each<Projection>(['perspective', 'orthographic'])('fits all vertices with margins in %s on desktop, tablet, and phone', projection => {
    const points = cube.map(p => p.clone().multiply(new Vector3(5, 2, 3)).add(new Vector3(4, -2, 1)));
    for (const [width, height] of [[1400, 800], [1024, 768], [390, 600]]) {
      const view = new StudyCamera(); view.resize(width, height); view.setProjection(projection); view.fit(points);
      for (const point of points) {
        const ndc = point.clone().project(view.camera);
        expect(Math.abs(ndc.x)).toBeLessThan(.84); expect(Math.abs(ndc.y)).toBeLessThan(.84);
        expect(Math.abs(ndc.z)).toBeLessThan(1);
      }
    }
  });

  it('keeps parallel picking rays and editable screen positions after orbiting and panning', () => {
    const view = new StudyCamera(), orbit = new OrbitControls(view.camera);
    orbit.target = view.target;
    view.setProjection('orthographic'); orbit.object = view.camera;
    orbit.rotateLeft(.5); orbit.rotateUp(.2);
    const offset = new Vector3(2, -1, .5);
    view.camera.position.add(offset); view.target.add(offset); orbit.update();
    const rays = [new Vector2(-.4, -.2), new Vector2(.3, .6)].map(point => {
      const ray = new Raycaster(); ray.setFromCamera(point, view.camera); return ray;
    });
    expect(rays[0].ray.direction.distanceTo(rays[1].ray.direction)).toBeLessThan(1e-10);
    expect(rays[0].ray.origin.distanceTo(rays[1].ray.origin)).toBeGreaterThan(1);
    const point = new Vector3(1, 1, 1), projected = point.clone().project(view.camera);
    const ray = new Raycaster(); ray.setFromCamera(new Vector2(projected.x, projected.y), view.camera);
    expect(ray.ray.distanceToPoint(point)).toBeLessThan(1e-10);
  });

  it('keeps projection and zoom when selecting front, side, top, or 3D and restores the full saved view', () => {
    const view = new StudyCamera(); view.setProjection('orthographic');
    view.camera.zoom *= 2; view.camera.updateProjectionMatrix();
    const saved = view.getState();
    for (const preset of ['front', 'side', 'top', '3d'] as const) {
      view.setView(preset);
      expect(view.projection).toBe('orthographic'); expect(view.orthographicSpan).toBe(saved.orthographicSpan);
    }
    view.setProjection('perspective'); view.setState(saved);
    expect(view.getState()).toEqual(saved);
    view.setState(DEFAULT_CAMERA);
    expect(view.projection).toBe('perspective');
  });

  it('keeps perspective dolly limits when returning from extreme orthographic zoom', () => {
    for (const span of [.1, 200]) {
      const view = new StudyCamera(); view.setState({ ...DEFAULT_CAMERA, projection: 'orthographic', orthographicSpan: span });
      view.setProjection('perspective');
      expect(view.camera.position.distanceTo(view.target)).toBeGreaterThanOrEqual(MIN_CAMERA_DISTANCE - 1e-10);
      expect(view.camera.position.distanceTo(view.target)).toBeLessThanOrEqual(MAX_CAMERA_DISTANCE + 1e-10);
    }
  });
});

describe('orthographic curved-form silhouettes', () => {
  it('uses parallel sight lines even when a smooth contour is far off-center', () => {
    const camera = new Vector3(10, 0, 10), toViewer = new Vector3(0, 0, 1);
    const edge: FeatureEdge = { a: new Vector3(0, -1, 0), b: new Vector3(0, 1, 0),
      normals: [new Vector3(1, 0, .1).normalize(), new Vector3(1, 0, -.1).normalize()], origins: [0, 0], seam: false, crease: false };
    const packed = packEdges([edge]);
    expect(packedEdgeLines(packed, camera).contour).toEqual([]);
    const expected = [...edge.a.toArray(), ...edge.b.toArray()];
    expect(edgeLines([edge], camera, toViewer).contour).toEqual(expected);
    expect(packedEdgeLines(packed, camera, true, toViewer).contour).toEqual(expected);
    expect(sourceEdgeLines({ a: packed, b: new Float32Array() }, camera, ['a'], toViewer)).toEqual(expected);
    expect(packedEdgeLines(packed, new Vector3(-20, 2, 30), true, toViewer).contour).toEqual(expected);
  });
});
