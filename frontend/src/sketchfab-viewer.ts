export type ProjectionMode = 'flat' | 'original' | 'wide';
type Vector = [number, number, number];
export interface SketchfabSettings {
  version: 1; uid: string; projection?: ProjectionMode; position?: Vector; target?: Vector;
  fov?: number; step?: number; locked?: boolean;
}
interface Camera { position: Vector; target: Vector }
type CameraCall = <T>(operation: (callback: Callback<T>) => void) => Promise<T>;
type Callback<T = undefined> = (error: unknown, result?: T) => void;
export interface ViewerApi {
  start(): void; addEventListener(event: string, callback: () => void): void;
  setBackground(options: { color: number[] }): void;
  getCameraLookAt(callback: Callback<Camera>): void; getFov(callback: Callback<number>): void;
  setFov(angle: number, callback: Callback<number>): void;
  setCameraLookAt(position: number[], target: number[], duration: number, callback?: Callback): void;
  getScreenShot(type: string, callback: Callback<string>): void;
  setUserInteraction?(enabled: boolean): void;
}
export interface ViewerClient { init(uid: string, options: { success: (api: ViewerApi) => void; error: () => void }): void }
declare global { interface Window { Sketchfab?: new (iframe: HTMLIFrameElement) => ViewerClient } }
export interface ViewerState { ready: boolean; busy: boolean; uid: string; projection: ProjectionMode; step: number; locked: boolean; message: string }
const radians = (fov: number) => Math.tan(fov * Math.PI / 360);
const radius = (camera: Camera) => Math.hypot(...camera.position.map((v, i) => v - camera.target[i]));
const validFov = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 179;
export const DEFAULT_MODEL = 'e7d6ce6350fc4039a58cafe6d05d1c09';
export function modelId(value: string): string | null {
  const text = value.trim(); if (text.length > 2048) return null;
  const valid = (id: string) => /^[A-Za-z0-9]{1,64}$/.test(id) ? id : null;
  if (!text.includes('/')) return valid(text);
  try {
    const url = new URL(text); if (!['https:', 'http:'].includes(url.protocol) || !/^(www\.)?sketchfab\.com$/i.test(url.hostname)) return null;
    const [kind, slug] = url.pathname.split('/').filter(Boolean);
    return slug && ['models', '3d-models'].includes(kind) ? valid(kind === 'models' ? slug : slug.split('-').pop()!) : null;
  } catch { return null; }
}
export function parseSketchfabSettings(value: unknown): SketchfabSettings {
  if (!value || typeof value !== 'object') throw new Error('This saved model view is incomplete.');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.uid !== 'string' || modelId(v.uid) !== v.uid) throw new Error('This saved model view is unsupported.');
  const settings: SketchfabSettings = { version: 1, uid: v.uid };
  // Older model-only library entries have no camera. Reopen them at the model's default framing.
  if (v.position === undefined && v.target === undefined && v.fov === undefined && v.projection === undefined) return settings;
  const vector = (value: unknown): value is Vector => Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e9);
  if (!vector(v.position) || !vector(v.target) || !validFov(v.fov) || !['flat', 'original', 'wide'].includes(String(v.projection))) throw new Error('This saved model camera is invalid.');
  if (radius({ position: v.position, target: v.target }) < 1e-9) throw new Error('This saved model camera has no viewing distance.');
  if (v.step !== undefined && ![1, 5, 15, 45].includes(v.step as number)) throw new Error('This saved rotation step is invalid.');
  if (v.locked !== undefined && typeof v.locked !== 'boolean') throw new Error('This saved drawing lock is invalid.');
  return { ...settings, projection: v.projection as ProjectionMode, position: [...v.position], target: [...v.target], fov: v.fov, step: v.step as number ?? 5, locked: v.locked as boolean ?? false };
}
export function settingsFromSearch(search: string): SketchfabSettings | null {
  const params = new URLSearchParams(search), uid = modelId(params.get('model') ?? ''); if (!uid) return null;
  const vector = (key: string) => (params.get(key) ?? '').split(',').map(v => v.trim() === '' ? NaN : Number(v));
  const projection = params.get('projection') ?? 'flat';
  const fov = params.has('fov') ? Number(params.get('fov')) : projection === 'flat' ? 1 : projection === 'wide' ? 85 : 45;
  try { return parseSketchfabSettings({ version: 1, uid, projection, fov, position: vector('position'), target: vector('target'), step: params.has('step') ? Number(params.get('step')) : 5, locked: params.get('locked') === '1' }); }
  catch { return { version: 1, uid }; }
}
export function settingsUrl(settings: SketchfabSettings, origin: string): string {
  const view = parseSketchfabSettings(settings), url = new URL('/sketchfab/', origin);
  url.searchParams.set('model', view.uid);
  if (view.position && view.target) {
    url.searchParams.set('projection', view.projection!); url.searchParams.set('fov', String(view.fov));
    url.searchParams.set('position', view.position.map(n => Number(n.toPrecision(12))).join(','));
    url.searchParams.set('target', view.target.map(n => Number(n.toPrecision(12))).join(','));
    url.searchParams.set('step', String(view.step ?? 5)); if (view.locked) url.searchParams.set('locked', '1');
  }
  return url.href;
}
export class SketchfabReference {
  state: ViewerState = { ready: false, busy: false, uid: '', projection: 'flat', step: 5, locked: false, message: 'Load a model to begin.' };
  private api: ViewerApi | null = null;
  private generation = 0;
  private originalFov = 45;
  private baseDistance = 1;
  private abortLoad?: () => void;
  constructor(private client: ViewerClient, private notify: (state: ViewerState) => void) {}
  private update(state: Partial<ViewerState>) { this.state = { ...this.state, ...state }; this.notify(this.state); }
  private call<T>(operation: (callback: Callback<T>) => void, generation = this.generation): Promise<T> {
    return new Promise((resolve, reject) => {
      if (generation !== this.generation) { reject(new Error('The model changed. Try again.')); return; }
      const timer = setTimeout(() => reject(new Error('Sketchfab did not respond. Try loading the model again.')), 15000);
      try { operation((error, result) => {
        clearTimeout(timer);
        if (generation !== this.generation) reject(new Error('The model changed. Try again.'));
        else if (error) reject(new Error('Sketchfab could not update this view. Please try again.'));
        else resolve(result as T);
      }); } catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  private async action<T>(operation: (api: ViewerApi, call: CameraCall, check: () => void) => Promise<T>): Promise<T> {
    if (!this.api || !this.state.ready || this.state.busy) throw new Error('Wait for the model to be ready.');
    const generation = this.generation; this.update({ busy: true });
    const check = () => { if (generation !== this.generation) throw new Error('The model changed. Try again.'); };
    const call: CameraCall = op => this.call(op, generation);
    try { const result = await operation(this.api, call, check); check(); return result; }
    finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  async load(value: string, saved?: unknown): Promise<void> {
    const uid = modelId(value); if (!uid) throw new Error('Enter a Sketchfab model link or ID.');
    const view = saved === undefined ? { version: 1 as const, uid } : parseSketchfabSettings(saved);
    if (view.uid !== uid) throw new Error('The saved view belongs to a different model.');
    this.abortLoad?.(); const generation = ++this.generation; this.api = null;
    const call: CameraCall = op => this.call(op, generation);
    this.update({ ready: false, busy: true, uid: '', locked: false, projection: 'flat', message: 'Loading model…' });
    try {
      const api = await new Promise<ViewerApi>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Model loading timed out. Check the link and embedding permissions.')), 45000);
        this.abortLoad = () => { clearTimeout(timer); reject(new Error('The model changed.')); };
        try { this.client.init(uid, { success: viewer => {
          if (generation !== this.generation) return;
          viewer.addEventListener('viewerready', () => { clearTimeout(timer); resolve(viewer); }); viewer.start();
        }, error: () => { clearTimeout(timer); reject(new Error('Could not load this model. Check its link and embedding permissions.')); } }); } catch (error) { clearTimeout(timer); reject(error); }
      });
      if (generation !== this.generation) return;
      api.setBackground({ color: [1, 1, 1] });
      const camera = await call<Camera>(cb => api.getCameraLookAt(cb));
      const original = await call<number>(cb => api.getFov(cb)); const originalFov = validFov(original) ? original : 45;
      const requested = view.fov ?? 1;
      const actual = await call<number>(cb => api.setFov(requested, cb)); const currentFov = validFov(actual) ? actual : requested;
      const factor = radians(view.position ? requested : originalFov) / radians(currentFov);
      const target = view.target ?? camera.target;
      const position = (view.position ?? camera.position).map((n, i) => target[i] + (n - target[i]) * factor);
      await call(cb => api.setCameraLookAt(position, target, 0, cb));
      if (generation !== this.generation) return;
      this.originalFov = originalFov;
      this.baseDistance = Math.hypot(...position.map((v, i) => v - target[i])); this.api = api;
      api.setUserInteraction?.(!view.locked);
      this.update({ ready: true, busy: false, uid, projection: view.projection ?? 'flat', step: view.step ?? 5, locked: view.locked ?? false, message: 'Ready' });
    } catch (error) {
      if (generation === this.generation) { this.update({ ready: false, busy: false, message: error instanceof Error ? error.message : 'Could not load the model.' }); throw error; }
    } finally { if (generation === this.generation) this.abortLoad = undefined; }
  }
  async capture(): Promise<SketchfabSettings> {
    return this.action(async (api, call) => {
      const camera = await call<Camera>(cb => api.getCameraLookAt(cb));
      const fov = await call<number>(cb => api.getFov(cb));
      return parseSketchfabSettings({ version: 1, uid: this.state.uid, projection: this.state.projection, position: camera.position, target: camera.target, fov, step: this.state.step, locked: this.state.locked });
    });
  }
  async projection(mode: ProjectionMode) {
    if (this.state.locked) return;
    await this.action(async (api, call, check) => {
      const camera = await call<Camera>(cb => api.getCameraLookAt(cb));
      const old = await call<number>(cb => api.getFov(cb));
      const requested = mode === 'flat' ? 1 : mode === 'original' ? this.originalFov : Math.min(150, Math.max(85, this.originalFov + 20));
      const actual = await call<number>(cb => api.setFov(requested, cb));
      const fov = validFov(actual) ? actual : requested, factor = radians(old) / radians(fov);
      await call(cb => api.setCameraLookAt(camera.position.map((n, i) => camera.target[i] + (n - camera.target[i]) * factor), camera.target, 0, cb));
      check(); this.baseDistance *= factor; this.update({ projection: mode });
    });
  }
  async orbit(direction: 'left' | 'right' | 'up' | 'down') {
    if (this.state.locked) return;
    await this.action(async (api, call) => {
      const camera = await call<Camera>(cb => api.getCameraLookAt(cb)), r = radius(camera); if (!r) return;
      const [x, y, z] = camera.position.map((v, i) => v - camera.target[i]), step = this.state.step * Math.PI / 180;
      const azimuth = Math.atan2(y, x) + (direction === 'left' ? step : direction === 'right' ? -step : 0);
      const elevation = Math.max(-Math.PI / 2 + .0001, Math.min(Math.PI / 2 - .0001, Math.asin(Math.max(-1, Math.min(1, z / r))) + (direction === 'up' ? step : direction === 'down' ? -step : 0)));
      const h = r * Math.cos(elevation), offset = [h * Math.cos(azimuth), h * Math.sin(azimuth), r * Math.sin(elevation)];
      await call(cb => api.setCameraLookAt(offset.map((v, i) => camera.target[i] + v), camera.target, 0, cb));
    });
  }
  async preset(view: string) {
    if (this.state.locked) return;
    await this.action(async (api, call) => {
      const camera = await call<Camera>(cb => api.getCameraLookAt(cb)), r = radius(camera), n = 1 / Math.sqrt(3);
      const directions: Record<string, number[]> = { top: [0, 0, 1], left: [1, 0, 0], right: [-1, 0, 0], front: [0, -1, 0], rear: [0, 1, 0], threequarter: [n, -n, n] };
      if (!directions[view]) return;
      await call(cb => api.setCameraLookAt(directions[view].map((v, i) => camera.target[i] + v * r), camera.target, 0, cb));
    });
  }
  async zoom(factor: number, reset = false) {
    if (this.state.locked) return;
    await this.action(async (api, call) => {
      const camera = await call<Camera>(cb => api.getCameraLookAt(cb)), r = radius(camera); if (!r) return;
      const ratio = reset ? this.baseDistance / r : factor;
      await call(cb => api.setCameraLookAt(camera.position.map((v, i) => camera.target[i] + (v - camera.target[i]) * ratio), camera.target, 0, cb));
    });
  }
  step(value: number) { if ([1, 5, 15, 45].includes(value)) this.update({ step: value }); }
  lock() { if (!this.api || this.state.busy) return; this.api.setUserInteraction?.(this.state.locked); this.update({ locked: !this.state.locked }); }
  async image() { return this.action((api, call) => call<string>(cb => api.getScreenShot('image/png', cb))); }
  dispose() { this.abortLoad?.(); this.generation++; this.api = null; }
}
