import { beforeAll, describe, expect, it, vi } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { BoxGeometry, BufferAttribute, BufferGeometry, GreaterDepth, LessEqualDepth, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Vector3, type Scene, type WebGLRenderer } from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { ConnectionOverlay } from '../src/connection-overlay';
import { packedEdgeLines } from '../src/edges';
import { evaluateScene } from '../src/geometry';
import { makeShape, shapeEntries, shapeMatrix, type SceneState } from '../src/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });

function setup() {
  const geometry = new LineSegmentsGeometry();
  const visible = new LineSegments2(geometry, new LineMaterial({ linewidth: 2.5, depthWrite: false, depthFunc: LessEqualDepth }));
  const hidden = new LineSegments2(geometry, new LineMaterial({ linewidth: 2.5, depthWrite: false, depthFunc: GreaterDepth, transparent: true, dashed: true }));
  visible.renderOrder = 3; hidden.renderOrder = 4;
  const overlay = new ConnectionOverlay({ visible, hidden });
  const camera = new PerspectiveCamera(34, 1, .05, 120);
  camera.position.set(-7, 5, 10);
  let meshes: Mesh<BufferGeometry, MeshBasicMaterial>[] = [];
  const renderer = {
    autoClear: true,
    clearDepth: vi.fn(),
    render: vi.fn((scene: Scene) => {
      expect(renderer.autoClear).toBe(false); // Never erase the painted reference.
      // Inspect the actual surfaces submitted to the GPU, including visibility.
      scene.updateMatrixWorld(true);
      meshes = [];
      scene.traverseVisible(object => {
        if (object instanceof Mesh && object.material instanceof MeshBasicMaterial && !object.material.colorWrite) meshes.push(object);
      });
    }),
  };
  const render = (originalForms = true) => overlay.render(renderer as unknown as WebGLRenderer, camera, originalForms);
  const covered = (point: Vector3) => {
    const ray = new Raycaster(camera.position, point.clone().sub(camera.position).normalize(), 0, camera.position.distanceTo(point) - 1e-4);
    return ray.intersectObjects(meshes, false).length > 0;
  };
  return { overlay, visible, hidden, camera, renderer, render, covered, meshes: () => meshes };
}

function study(cylinder = false): SceneState {
  const a = makeShape('box', [4, 4, 4]);
  const b = makeShape(cylinder ? 'cylinder' : 'box', cylinder ? [2, 2, 8] : [4, 4, 4]);
  if (!cylinder) b.position = [2, 1, .7];
  return { a, b, operation: 'union', contours: 4 };
}

function reference(scene: SceneState, camera: Vector3) {
  const geometry = evaluateScene(wasm, scene);
  const surfaces = shapeEntries(scene).map(([id, shape]) => {
    const source = geometry.sources[id]!;
    const mesh = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    mesh.geometry.setAttribute('position', new BufferAttribute(source.positions, 3));
    mesh.geometry.setIndex(new BufferAttribute(source.indices, 1));
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(shapeMatrix(shape));
    mesh.visible = false; // All-wireframe means none of these walls are painted.
    return mesh;
  });
  const positions = packedEdgeLines(geometry.connectionEdges, camera).seam;
  const segments = Array.from({ length: positions.length / 6 }, (_, i) => ({
    a: new Vector3().fromArray(positions, i * 6), b: new Vector3().fromArray(positions, i * 6 + 3),
  }));
  return { surfaces, segments };
}

describe('connection occlusion without filled faces', () => {
  it.each([false, true])('distinguishes front and back joins and follows camera rotation (cylinder: %s)', cylinder => {
    const test = setup(), { surfaces, segments } = reference(study(cylinder), test.camera.position);
    test.overlay.setForms(surfaces); test.render();
    const midpoints = segments.map(({ a, b }) => a.clone().lerp(b, .5));
    const front = midpoints.map(test.covered);
    expect(front).toContain(true); expect(front).toContain(false);
    test.camera.position.negate(); test.render();
    const back = midpoints.map(test.covered);
    expect(back).toContain(true); expect(back).toContain(false);
    expect(back).not.toEqual(front);
    expect(surfaces.every(surface => !surface.visible)).toBe(true);
    test.overlay.dispose();
  });

  it('covers every concave box join when all adjacent front faces point away from the viewer', () => {
    const test = setup(); test.camera.position.set(7, 5, 10);
    const { surfaces, segments } = reference(study(), test.camera.position);
    test.overlay.setForms(surfaces); test.render();
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every(({ a, b }) => test.covered(a.clone().lerp(b, .5)))).toBe(true);
    test.overlay.dispose();
  });

  it('occludes only the covered portion of a connection behind a third wireframe form', () => {
    const test = setup(), { surfaces, segments } = reference(study(), test.camera.position);
    test.overlay.setForms(surfaces); test.render();
    const edge = segments.find(({ a, b }) => a.distanceTo(b) > 1 && [.05, .5, .95].every(t => !test.covered(a.clone().lerp(b, t))))!;
    expect(edge).toBeDefined();
    const points = [.05, .5, .95].map(t => edge.a.clone().lerp(edge.b, t));
    const cover = new Mesh(new BoxGeometry(.3, .3, .3), new MeshBasicMaterial());
    cover.position.copy(points[1]).addScaledVector(test.camera.position.clone().sub(points[1]).normalize(), 3);
    cover.visible = false;
    test.overlay.setForms([...surfaces, cover]); test.render();
    expect(points.map(test.covered)).toEqual([false, true, false]);
    test.overlay.dispose();
  });

  it('uses all source forms even when the cut result contains only a disjoint first form', () => {
    const test = setup(), scene = study();
    scene.extraShapes = [scene.b]; scene.b = scene.a;
    scene.a = makeShape('box', [1, 1, 1]); scene.a.position = [-6, 0, 0]; scene.operation = 'subtract';
    const { surfaces, segments } = reference(scene, test.camera.position);
    test.overlay.setForms(surfaces); test.render();
    expect(test.meshes()).toHaveLength(3);
    const visibility = segments.map(({ a, b }) => test.covered(a.clone().lerp(b, .5)));
    expect(visibility).toContain(true); expect(visibility).toContain(false);
    test.overlay.dispose();
  });

  it('preserves existing colors and outlines, paints only depth for the forms, and uses gentle hidden lines', () => {
    const test = setup(), { surfaces } = reference(study(), test.camera.position);
    test.overlay.setForms(surfaces); test.render();
    expect(test.renderer.clearDepth).toHaveBeenCalledOnce();
    const meshes = test.meshes();
    expect(meshes).toHaveLength(2);
    for (const mesh of meshes) {
      expect(mesh.material.colorWrite).toBe(false);
      expect(mesh.material.depthWrite).toBe(true);
      expect(mesh.material.polygonOffset).toBe(true);
      expect(mesh.renderOrder).toBeLessThan(test.visible.renderOrder);
    }
    expect(test.visible.material.depthTest).toBe(true);
    expect(test.hidden.material.depthTest).toBe(true);
    expect(test.hidden.material.opacity).toBeLessThan(test.visible.material.opacity);
    expect(test.hidden.material.linewidth).toBeLessThan(test.visible.material.linewidth);
    expect(test.renderer.autoClear).toBe(true);
    test.overlay.dispose();
  });

  it('retains Boolean-result depth in solid view and skips the pass when connections are off', () => {
    const test = setup(), { surfaces } = reference(study(), test.camera.position);
    test.overlay.setForms(surfaces);
    test.render(); test.renderer.clearDepth.mockClear(); test.render(false);
    expect(test.meshes()).toHaveLength(0);
    expect(test.renderer.clearDepth).not.toHaveBeenCalled();
    test.visible.visible = test.hidden.visible = false;
    test.renderer.render.mockClear(); test.render();
    expect(test.renderer.render).not.toHaveBeenCalled();
    expect(test.renderer.clearDepth).not.toHaveBeenCalled();
    test.overlay.dispose();
  });

  it('keeps depth aligned with the last completed geometry, removes stale forms, and borrows buffers safely', () => {
    const test = setup(), { surfaces } = reference(study(), test.camera.position);
    const dispose = surfaces.map(surface => vi.spyOn(surface.geometry, 'dispose'));
    test.overlay.setForms(surfaces); test.render();
    const before = test.meshes()[1].matrixWorld.clone();
    surfaces[1].matrix.makeTranslation(30, 0, 0);
    test.render();
    expect(test.meshes()[1].matrixWorld).toEqual(before);
    test.overlay.setForms([surfaces[1]]); test.render();
    expect(test.meshes()).toHaveLength(1);
    expect(test.meshes()[0].geometry).toBe(surfaces[1].geometry);
    expect(test.meshes()[0].matrixWorld.elements[12]).toBe(30);
    test.overlay.dispose();
    for (const spy of dispose) expect(spy).not.toHaveBeenCalled();
  });
});
