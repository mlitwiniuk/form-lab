import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { packedEdgeLines, sourceEdgeLines } from './edges';
import { referenceAppearance } from './appearance';
import type { RenderGeometry } from './render-geometry';
import { SHAPE_IDS, shapeEntries, getShape, cloneScene, constrainBend, constrainCurvePoint, shapeMatrix, radians, type DisplayMode, type Reveals, type SceneState, type ShapeId, type ShapeMap, type Tool, type Vec3 } from './scene';
import { constructionLines, createSectionSampler, type GeometryQuality } from './forms';
import type { CameraState } from './share-state';

type LinePair = { visible: LineSegments2; hidden: LineSegments2 };
interface Callbacks {
  edit: (scene: SceneState) => void; commit: () => void; select: (id: ShapeId) => void;
  drag: (active: boolean) => void;
  point: (index: number) => void;
  view: (finished: boolean) => void;
}
const PAPER = '#f6f5f0';

export class Viewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(34, 1, .05, 120);
  readonly world = new THREE.Scene();
  readonly orbit: OrbitControls;
  readonly transform: TransformControls;
  private solid: THREE.Mesh;
  private formSurfaces = {} as Record<ShapeId, THREE.Mesh>;
  private proxies = SHAPE_IDS.reduce((proxies, id) => { proxies[id] = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)); return proxies; }, {} as Record<ShapeId, THREE.Mesh>);
  private lines: Record<'contour' | 'wireForms' | 'seam' | 'primaryGuide' | 'otherGuides' | 'crossA' | 'crossOthers' | 'axis', LinePair>;
  private featureEdges: Float32Array = new Float32Array();
  private renderedScene: SceneState | null = null;
  private quality: GeometryQuality = 'final';
  private guideCacheKey = '';
  private guideCache: Partial<Record<ShapeId, ReturnType<typeof constructionLines>>> = {};
  private paintStartedAt: number | null = null;
  private renderedFrames = 0;
  private latencySamples: { quality: GeometryQuality; ms: number }[] = [];
  private state!: SceneState;
  private selection: ShapeId = 'a';
  private sourceEdges: ShapeMap<Float32Array> = { a: new Float32Array(), b: new Float32Array() };
  private display: DisplayMode = 'solid';
  private locked = false;
  private editingEnabled = false;
  private reveals: Reveals = { cutter: true, construction: false, hidden: false, seam: true };
  private observer: ResizeObserver;
  private pointerStart = { x: 0, y: 0 };
  private onCleanup: (() => void)[] = [];
  private frame = 0;
  private dirty = true;
  private disposed = false;
  private guideDirty = true;
  private dimensions = [1, 1];
  private bookmark: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private suppressEvents = false;
  private curveEditing = false;
  private curvePoint = 2;
  private currentTool: Tool = 'scale';
  private curveHandles: THREE.Object3D[] = [];
  private curveButtons: HTMLButtonElement[] = [];
  private curveLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#42856c', depthTest: false, transparent: true, opacity: .65 }));

  constructor(private container: HTMLElement, private callbacks: Callbacks) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(PAPER);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D reference: editable, deformable forms. Use the shape controls to edit, or drag the background to orbit.');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

    this.world.add(new THREE.AmbientLight(0xffffff, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 2.8);
    light.position.set(-3, 8, 5); this.world.add(light);
    this.solid = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
      color: '#eeeae0', roughness: 1, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }));
    this.world.add(this.solid);
    for (const id of SHAPE_IDS) {
      const surface = new THREE.Mesh(new THREE.BufferGeometry(), (this.solid.material as THREE.MeshStandardMaterial).clone());
      surface.visible = false; surface.matrixAutoUpdate = false;
      this.formSurfaces[id] = surface; this.world.add(surface);
    }
    for (const [id, proxy] of Object.entries(this.proxies)) {
      proxy.userData.shapeId = id;
      proxy.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
      this.world.add(proxy);
    }
    this.lines = {
      contour: this.makeLinePair('#34413e', 1.8),
      wireForms: this.makeLinePair('#34413e', 1.8),
      seam: this.makeLinePair('#156f64', 2.5),
      primaryGuide: this.makeLinePair('#969c95', 1),
      otherGuides: this.makeLinePair('#bc8062', 1.25),
      axis: this.makeLinePair('#78938c', 1, true),
      crossA: this.makeLinePair('#517e71', 1.4),
      crossOthers: this.makeLinePair('#bc8062', 1.2),
    };
    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = false;
    this.orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.orbit.minDistance = 5; this.orbit.maxDistance = 45;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.addEventListener('change', () => {
      this.guideDirty = true; this.dirty = true; this.callbacks.view(false);
    });
    this.orbit.addEventListener('end', () => this.callbacks.view(true));

    this.transform = new TransformControls(this.camera, this.renderer.domElement);
    this.transform.setSize(.7);
    this.transform.setColors('#ba785e', '#80966e', '#7595a7', '#d0a56b');
    this.transform.setSpace('world');
    this.world.add(this.transform.getHelper());
    this.curveLine.renderOrder = 5; this.curveLine.visible = false; this.world.add(this.curveLine);
    for (let i = 0; i < 7; i++) {
      const handle = new THREE.Object3D(); this.world.add(handle); this.curveHandles.push(handle);
      const button = document.createElement('button');
      button.className = 'curve-point'; button.textContent = String(i + 1); button.style.display = 'none';
      button.setAttribute('aria-label', `Select curve point ${i + 1}`);
      button.addEventListener('pointerdown', event => event.stopPropagation());
      button.addEventListener('click', () => { if (!this.locked) this.callbacks.point(i); });
      container.appendChild(button); this.curveButtons.push(button);
    }
    this.transform.addEventListener('dragging-changed', event => {
      this.orbit.enabled = !event.value && !this.locked;
      this.callbacks.drag(Boolean(event.value));
      if (!event.value && !this.suppressEvents) this.callbacks.commit();
      this.dirty = true;
    });
    this.transform.addEventListener('objectChange', () => {
      if (this.suppressEvents || !this.state) return;
      if (this.editingCurve()) {
        const next = cloneScene(this.state), shape = getShape(next, this.selection), index = this.activePoint();
        const local = this.curveHandles[index].position.clone().applyMatrix4(shapeMatrix(shape).invert());
        const position = local.toArray().map((v, axis) => v / shape.size[axis]) as Vec3;
        shape.spine![index].position = constrainCurvePoint(shape, index, position);
        this.state = next; this.callbacks.edit(next); this.updateCurveControls(); this.guideDirty = this.dirty = true;
        return;
      }
      const object = this.proxies[this.selection];
      const next = cloneScene(this.state);
      getShape(next, this.selection).position = object.position.toArray().map(v => THREE.MathUtils.clamp(v, -8, 8)) as Vec3;
      getShape(next, this.selection).rotation = [object.rotation.x, object.rotation.y, object.rotation.z].map(v => v * 180 / Math.PI) as Vec3;
      getShape(next, this.selection).size = object.scale.toArray().map(v => THREE.MathUtils.clamp(v, .4, 12)) as Vec3;
      constrainBend(getShape(next, this.selection));
      this.state = next;
      this.callbacks.edit(next); this.guideDirty = true; this.dirty = true;
    });
    this.transform.addEventListener('change', () => { this.dirty = true; });

    const down = (event: PointerEvent) => { this.pointerStart = { x: event.clientX, y: event.clientY }; };
    const up = (event: PointerEvent) => {
      if (this.locked || this.editingCurve() || event.button !== 0 || this.transform.axis || Math.hypot(event.clientX - this.pointerStart.x, event.clientY - this.pointerStart.y) > 4) return;
      const rect = this.renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(pointer, this.camera);
      const hit = ray.intersectObjects(shapeEntries(this.state).map(([id]) => this.proxies[id]))[0];
      if (hit) this.callbacks.select(hit.object.userData.shapeId as ShapeId);
    };
    this.renderer.domElement.addEventListener('pointerdown', down);
    this.renderer.domElement.addEventListener('pointerup', up);
    this.onCleanup.push(() => this.renderer.domElement.removeEventListener('pointerdown', down), () => this.renderer.domElement.removeEventListener('pointerup', up));
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(container);
    this.setView('perspective'); this.resize(); this.animate();
  }

  private makeLinePair(color: string, width: number, dashed = false): LinePair {
    const create = (hidden: boolean) => {
      const material = new LineMaterial({ color, linewidth: width, transparent: hidden || dashed, opacity: hidden ? .45 : 1,
        depthTest: true, depthWrite: false, depthFunc: hidden ? THREE.GreaterDepth : THREE.LessEqualDepth,
        dashed: hidden || dashed, dashSize: .09, gapSize: .07 });
      const line = new LineSegments2(new LineSegmentsGeometry(), material);
      line.renderOrder = hidden ? 4 : 3; line.frustumCulled = false; line.visible = false;
      this.world.add(line); return line;
    };
    const visible = create(false), hidden = create(true);
    hidden.geometry.dispose(); hidden.geometry = visible.geometry;
    return { visible, hidden };
  }

  private setLine(pair: LinePair, points: number[], show: boolean, hidden = this.display !== 'wireframe' && this.reveals.hidden) {
    pair.visible.visible = show && points.length > 0;
    pair.hidden.visible = show && hidden && points.length > 0;
    if (!show || !points.length) return;
    const count = points.length / 6;
    let geometry = pair.visible.geometry;
    let start = geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute | undefined;
    if (!start || start.count < count) {
      geometry.dispose(); geometry = new LineSegmentsGeometry();
      const capacity = 2 ** Math.ceil(Math.log2(Math.max(16, count)));
      geometry.setPositions(new Float32Array(capacity * 6));
      pair.visible.geometry = pair.hidden.geometry = geometry;
      pair.visible.computeLineDistances();
      start = geometry.getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
      start.data.setUsage(THREE.DynamicDrawUsage);
      (geometry.getAttribute('instanceDistanceStart') as THREE.InterleavedBufferAttribute).data.setUsage(THREE.DynamicDrawUsage);
    }
    (start.data.array as Float32Array).set(points); start.data.needsUpdate = true;
    geometry.instanceCount = count;
    const distances = (geometry.getAttribute('instanceDistanceStart') as THREE.InterleavedBufferAttribute).data;
    let distance = 0;
    for (let i = 0; i < count; i++) {
      const j = i * 6; distances.array[i * 2] = distance;
      distance += Math.hypot(points[j + 3] - points[j], points[j + 4] - points[j + 1], points[j + 5] - points[j + 2]);
      distances.array[i * 2 + 1] = distance;
    }
    distances.needsUpdate = true;
    // Line objects are not frustum-culled; stale capacity bounds are never used for visibility.
  }

  setScene(scene: SceneState) {
    this.state = scene;
    if (!shapeEntries(scene).some(([id]) => id === this.selection)) this.selection = 'a';
    if (this.renderedScene) this.renderedScene = { ...this.renderedScene, contours: scene.contours };
    for (const [id, shape] of shapeEntries(scene)) {
      const proxy = this.proxies[id];
      proxy.position.fromArray(shape.position);
      proxy.rotation.set(...shape.rotation.map(radians) as Vec3, 'XYZ');
      proxy.scale.fromArray(shape.size);
      proxy.updateMatrixWorld(true);
    }
    this.updateCurveControls(); this.attachControls();
    this.guideDirty = true; this.dirty = true;
  }

  setGeometry(result: RenderGeometry, scene: SceneState, startedAt: number) {
    this.renderedScene = { ...scene, contours: this.state.contours };
    this.quality = result.quality; this.paintStartedAt = startedAt;
    this.solid.geometry.dispose();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(result.indices, 1));
    geometry.setAttribute('normal', new THREE.BufferAttribute(result.normals, 3));
    this.solid.geometry = geometry;
    for (const [id, shape] of shapeEntries(scene)) {
      const proxy = this.proxies[id], source = result.sources[id]!, normalized = new Float32Array(source.positions);
      for (let i = 0; i < normalized.length; i++) normalized[i] /= shape.size[i % 3];
      proxy.geometry.dispose();
      proxy.geometry = new THREE.BufferGeometry();
      proxy.geometry.setAttribute('position', new THREE.BufferAttribute(normalized, 3));
      proxy.geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
      const surface = this.formSurfaces[id];
      surface.geometry.dispose();
      surface.geometry = new THREE.BufferGeometry();
      surface.geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
      surface.geometry.setIndex(new THREE.BufferAttribute(source.indices, 1));
      surface.geometry.setAttribute('normal', new THREE.BufferAttribute(source.normals!, 3));
      surface.matrix.copy(shapeMatrix(shape)); surface.matrixWorldNeedsUpdate = true;
    }
    this.featureEdges = result.featureEdges;
    this.sourceEdges = result.sourceEdges;
    this.guideDirty = true; this.dirty = true;
  }

  setOptions(selection: ShapeId, tool: Tool, reveals: Reveals, locked: boolean, snap: boolean, editingEnabled = true, display: DisplayMode = 'solid') {
    this.selection = shapeEntries(this.state).some(([id]) => id === selection) ? selection : 'a'; this.reveals = reveals; this.editingEnabled = editingEnabled;
    this.display = display;
    this.lines.contour.visible.material.depthTest = true;
    this.lines.wireForms.visible.material.depthTest = false;
    for (const key of ['seam', 'primaryGuide', 'otherGuides', 'crossA', 'crossOthers', 'axis'] as const) this.lines[key].visible.material.depthTest = display === 'solid';
    if (locked && !this.locked) this.bookmark = { position: this.camera.position.clone(), target: this.orbit.target.clone() };
    this.locked = locked; this.orbit.enabled = !locked;
    this.currentTool = tool;
    this.transform.setTranslationSnap(snap ? .25 : null);
    this.transform.setRotationSnap(snap ? Math.PI / 12 : null);
    this.transform.setScaleSnap(snap ? .1 : null);
    this.updateCurveControls(); this.attachControls();
    this.guideDirty = true; this.dirty = true;
  }

  private editingCurve() { return this.editingEnabled && this.curveEditing && !!(this.state && getShape(this.state, this.selection).spine); }
  private activePoint() { return Math.min(this.curvePoint, (getShape(this.state, this.selection).spine?.length ?? 1) - 1); }
  setCurveEditor(active: boolean, point: number) {
    this.curveEditing = active; this.curvePoint = point;
    this.updateCurveControls(); this.attachControls(); this.dirty = true;
  }
  private attachControls() {
    if (this.locked || !this.editingEnabled) { this.transform.detach(); return; }
    const curve = this.editingCurve(), index = this.activePoint();
    this.transform.setMode(curve ? 'translate' : this.currentTool);
    this.transform.setSpace(curve || this.currentTool === 'scale' ? 'local' : 'world');
    this.transform.showZ = !curve || (index > 0 && index < getShape(this.state, this.selection).spine!.length - 1);
    const object = curve ? this.curveHandles[index] : this.proxies[this.selection];
    if (this.transform.object !== object) this.transform.attach(object);
  }
  private updateCurveControls() {
    if (!this.state) return;
    const shape = getShape(this.state, this.selection), visible = this.editingCurve() && !this.locked;
    this.curveLine.visible = visible;
    for (const [index, handle] of this.curveHandles.entries()) {
      const point = shape.spine?.[index], button = this.curveButtons[index];
      button.style.display = visible && point ? '' : 'none';
      button.classList.toggle('active', index === this.activePoint());
      button.setAttribute('aria-pressed', String(index === this.activePoint()));
      if (!point) continue;
      handle.position.set(...point.position).multiply(new THREE.Vector3(...shape.size)).applyMatrix4(shapeMatrix(shape));
      handle.rotation.set(...shape.rotation.map(radians) as Vec3, 'XYZ'); handle.updateMatrixWorld(true);
    }
    if (visible) {
      const sample = createSectionSampler(shape), matrix = shapeMatrix(shape), points: THREE.Vector3[] = [];
      for (let i = 0; i <= 48; i++) points.push(new THREE.Vector3(...sample(i / 48 - .5, 0, true)).applyMatrix4(matrix));
      this.curveLine.geometry.dispose(); this.curveLine.geometry = new THREE.BufferGeometry().setFromPoints(points);
    }
  }
  private positionCurveLabels() {
    if (!this.editingCurve() || this.locked) return;
    const [width, height] = this.dimensions;
    this.curveHandles.forEach((handle, i) => {
      if (!getShape(this.state, this.selection).spine?.[i]) return;
      const projected = handle.position.clone().project(this.camera), button = this.curveButtons[i];
      button.style.display = Math.abs(projected.z) < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 ? '' : 'none';
      button.style.left = `${(projected.x + 1) * width / 2}px`; button.style.top = `${(1 - projected.y) * height / 2}px`;
    });
  }

  setView(view: 'perspective' | 'front' | 'side' | 'top') {
    const positions = { perspective: [7.2, 5.5, 9.8], front: [0, 0, 16], side: [16, 0, 0], top: [0, 16, .001] };
    this.camera.position.fromArray(positions[view]);
    this.orbit.target.set(0, 0, 0); this.orbit.update();
    this.guideDirty = true; this.dirty = true;
    this.callbacks.view(true);
  }

  fitView() {
    if (this.locked || !this.state) return;
    const bounds = new THREE.Box3();
    for (const [id] of shapeEntries(this.state)) bounds.expandByObject(this.proxies[id], true);
    if (bounds.isEmpty()) return;
    const center = bounds.getCenter(new THREE.Vector3());
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const verticalTangent = Math.tan(radians(this.camera.fov) / 2);
    // Fit within the shorter dimension so rotating a device keeps the whole form visible.
    const tangentY = verticalTangent * Math.min(1, this.camera.aspect), tangentX = tangentY;
    const point = new THREE.Vector3();
    let distance = this.orbit.minDistance;
    // Fit the projected vertices, so foreshortened forms still fill a small screen.
    for (const mesh of shapeEntries(this.state).map(([id]) => this.proxies[id])) {
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).sub(center);
        distance = Math.max(distance, point.dot(direction) + 1.2 * Math.max(Math.abs(point.dot(right)) / tangentX, Math.abs(point.dot(up)) / tangentY));
      }
    }
    distance = Math.min(distance, this.orbit.maxDistance);
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.orbit.update(); this.guideDirty = this.dirty = true;
    this.callbacks.view(true);
  }

  getCameraState(): CameraState {
    return { position: this.camera.position.toArray(), target: this.orbit.target.toArray() };
  }

  setCameraState(view: CameraState) {
    this.camera.position.fromArray(view.position); this.orbit.target.fromArray(view.target);
    this.orbit.update();
    this.bookmark = { position: this.camera.position.clone(), target: this.orbit.target.clone() };
    this.guideDirty = this.dirty = true;
  }

  restoreView() {
    if (!this.bookmark) { this.setView('perspective'); return; }
    this.camera.position.copy(this.bookmark.position); this.orbit.target.copy(this.bookmark.target); this.orbit.update();
    this.guideDirty = true; this.dirty = true;
    this.callbacks.view(true);
  }

  cancelDrag() {
    if (this.transform.dragging) this.transform.reset();
  }

  private updateLines() {
    const edges = packedEdgeLines(this.featureEdges, this.camera.position, this.reveals.seam);
    if (!this.state) return;
    const appearance = referenceAppearance(this.state, this.display), originalForms = !appearance.result;
    const outlines = (ids: ShapeId[]) => sourceEdgeLines(this.sourceEdges, this.camera.position, ids);
    this.solid.visible = appearance.result;
    for (const id of SHAPE_IDS) this.formSurfaces[id].visible = appearance.solidForms.includes(id);
    this.setLine(this.lines.contour, appearance.result ? edges.contour : outlines(appearance.solidForms), true);
    this.setLine(this.lines.wireForms, outlines(appearance.wireForms), originalForms, false);
    this.setLine(this.lines.seam, edges.seam, this.reveals.seam, appearance.result && this.reveals.hidden);
    if (!this.renderedScene) return;
    const study = this.renderedScene, entries = shapeEntries(study), single = entries.length === 1;
    const key = JSON.stringify([entries, study.contours, this.quality]);
    if (this.reveals.construction && key !== this.guideCacheKey) {
      this.guideCacheKey = key;
      this.guideCache = Object.fromEntries(entries.map(([id, shape]) => [id, constructionLines(shape, study.contours, this.quality)]));
    }
    const a = this.guideCache.a ?? { sections: [], axis: [] };
    const others = entries.slice(1).map(([id]) => this.guideCache[id] ?? { sections: [], axis: [] });
    this.setLine(this.lines.primaryGuide, !originalForms && this.reveals.construction && !single ? packedEdgeLines(this.sourceEdges.a, this.camera.position).contour : [], !originalForms && this.reveals.construction && !single);
    const sourceOutlines = !originalForms && !single && this.reveals.cutter ? entries.slice(1).flatMap(([id]) => packedEdgeLines(this.sourceEdges[id] ?? new Float32Array(), this.camera.position).contour) : [];
    this.setLine(this.lines.otherGuides, sourceOutlines, !originalForms && !single && this.reveals.cutter);
    this.setLine(this.lines.crossA, a.sections, this.reveals.construction);
    this.setLine(this.lines.crossOthers, others.flatMap(guide => guide.sections), this.reveals.construction && !single && (originalForms || this.reveals.cutter));
    this.setLine(this.lines.axis, [...a.axis, ...(!single && (originalForms || this.reveals.cutter) ? others.flatMap(guide => guide.axis) : [])], this.reveals.construction);
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth), height = Math.max(1, this.container.clientHeight);
    this.dimensions = [width, height]; this.renderer.setSize(width, height);
    this.camera.aspect = width / height;
    // Keep the complete study framed even in a tall, narrow browser panel.
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(radians(34) / 2) / Math.min(1, this.camera.aspect)));
    this.camera.updateProjectionMatrix();
    for (const pair of Object.values(this.lines)) for (const line of [pair.visible, pair.hidden]) line.material.resolution.set(width, height);
    this.guideDirty = true; this.dirty = true;
  }

  private animate = () => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.animate);
    if (this.guideDirty) { this.updateLines(); this.guideDirty = false; }
    if (this.dirty) {
      this.renderer.render(this.world, this.camera); this.dirty = false;
      this.positionCurveLabels();
      if (this.paintStartedAt !== null) {
        const elapsed = Math.round(performance.now() - this.paintStartedAt);
        this.latencySamples.push({ quality: this.quality, ms: elapsed });
        this.latencySamples = this.latencySamples.slice(-30);
        Object.assign(this.renderer.domElement.dataset, { renderQuality: this.quality, updateMs: String(elapsed),
          renderedTwist: String(this.renderedScene?.a.deform.twist), renderCount: String(++this.renderedFrames),
          latencySamples: JSON.stringify(this.latencySamples) });
        this.paintStartedAt = null;
      }
    }
  };

  exportImage() {
    if (this.guideDirty) { this.updateLines(); this.guideDirty = false; }
    const helper = this.transform.getHelper(), previous = helper.visible;
    const curveVisible = this.curveLine.visible; this.curveLine.visible = false;
    helper.visible = false;
    const [width, height] = this.dimensions;
    this.renderer.setPixelRatio(2);
    this.renderer.setSize(width, height, false);
    this.renderer.render(this.world, this.camera);
    const url = this.renderer.domElement.toDataURL('image/png');
    helper.visible = previous;
    this.curveLine.visible = curveVisible;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); this.resize();
    return url;
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.frame); this.observer.disconnect();
    this.onCleanup.forEach(fn => fn()); this.orbit.dispose(); this.transform.dispose();
    this.world.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        object.geometry?.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(material => material.dispose());
      }
    });
    this.renderer.dispose(); this.renderer.domElement.remove();
    this.curveButtons.forEach(button => button.remove());
  }
}
