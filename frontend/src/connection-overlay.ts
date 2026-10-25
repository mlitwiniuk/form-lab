import { Group, Mesh, MeshBasicMaterial, Scene, type Camera, type WebGLRenderer } from 'three';
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js';

/** Connection visibility is independent of whether the original forms have filled faces. */
export class ConnectionOverlay {
  readonly scene = new Scene();
  private readonly forms = new Group();
  private readonly depthMaterial = new MeshBasicMaterial({
    colorWrite: false, depthWrite: true,
    // Let a connection on a surface pass the depth test without z-fighting.
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
  });

  constructor(private readonly lines: { visible: LineSegments2; hidden: LineSegments2 }) {
    this.scene.add(this.forms, lines.visible, lines.hidden);
    lines.visible.material.depthTest = lines.hidden.material.depthTest = true;
    lines.hidden.material.linewidth = 1.25;
    lines.hidden.material.opacity = .28;
  }

  /** Borrow the completed geometry snapshot, never the live editing proxies. */
  setForms(surfaces: readonly Mesh[]) {
    this.forms.clear();
    for (const surface of surfaces) {
      surface.updateWorldMatrix(true, false, true);
      const depth = new Mesh(surface.geometry, this.depthMaterial);
      depth.matrixAutoUpdate = false;
      depth.matrix.copy(surface.matrixWorld);
      this.forms.add(depth);
    }
  }

  render(renderer: WebGLRenderer, camera: Camera, originalForms: boolean) {
    if (!this.lines.visible.visible && !this.lines.hidden.visible) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    try {
      this.forms.visible = originalForms;
      // The main scene is already painted. Replacing only depth leaves its full
      // wireframe outlines intact while even transparent forms occlude connections.
      // Solid-result mode instead uses the actual Boolean result's existing depth.
      if (originalForms) renderer.clearDepth();
      renderer.render(this.scene, camera);
    } finally {
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    // Form geometry belongs to the viewport; no copied vertex buffers to release.
    this.forms.clear();
    this.depthMaterial.dispose();
    this.lines.visible.geometry.dispose();
    this.lines.visible.material.dispose();
    this.lines.hidden.material.dispose();
    this.scene.clear();
  }
}
