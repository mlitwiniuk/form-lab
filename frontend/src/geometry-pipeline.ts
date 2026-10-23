import { cloneScene, shapeEntries, type SceneState } from './scene';
import type { GeometryQuality } from './forms';
import type { RenderGeometry } from './render-geometry';

export interface GeometryRequest { revision: number; scene: SceneState; quality: GeometryQuality; startedAt: number }
export interface GeometryResponse { revision: number; result?: RenderGeometry; error?: string }
export interface GeometryWorkerPort {
  postMessage(message: GeometryRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<GeometryResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}
export const geometryKey = (scene: SceneState) => JSON.stringify([scene.operation, shapeEntries(scene)]);
export const REFINEMENT_DELAY = 220;

/** One in-flight computation, at most one replaceable pending request. */
class LatestWorker {
  private active: GeometryRequest | null = null;
  private pending: GeometryRequest | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  constructor(private port: GeometryWorkerPort, private result: (request: GeometryRequest, response: GeometryResponse) => void, private failed: (message: string) => void) {
    port.onmessage = ({ data }) => {
      if (this.stopped || !this.active || data.revision !== this.active.revision) return;
      const active = this.active; this.active = null;
      if (this.timeout) clearTimeout(this.timeout);
      this.timeout = null;
      this.result(active, data);
      const pending = this.pending; this.pending = null;
      if (pending && !this.stopped) this.send(pending);
    };
    port.onerror = () => this.fail('The geometry worker stopped. Retry to reload it; your shape settings are preserved.');
  }
  request(request: GeometryRequest) {
    if (this.stopped) return;
    if (this.active) this.pending = request;
    else this.send(request);
  }
  clearPending() { this.pending = null; }
  private send(request: GeometryRequest) {
    this.active = request;
    this.timeout = setTimeout(() => this.fail('This edit took too long. Retry the engine or reset the forms.'), 12000);
    try { this.port.postMessage(request); } catch { this.fail('The geometry worker could not accept this edit. Retry to reload it.'); }
  }
  private fail(message: string) { this.dispose(); this.failed(message); }
  dispose() {
    this.stopped = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.active = this.pending = null; this.port.onmessage = this.port.onerror = null; this.port.terminate();
  }
}

/** Dedicated preview lane prevents a detailed Boolean from blocking the next drag. */
export class GeometryPipeline {
  private preview: LatestWorker;
  private final: LatestWorker;
  private refinement: ReturnType<typeof setTimeout> | null = null;
  private current: GeometryRequest | null = null;
  private key = '';
  private revision = 0;
  private displayed = { revision: -1, quality: 'preview' as GeometryQuality };
  private disposed = false;
  constructor(createWorker: () => GeometryWorkerPort, private callbacks: {
    pending: () => void;
    result: (result: RenderGeometry, scene: SceneState, current: boolean, startedAt: number) => void;
    error: (message: string) => void;
  }) {
    const receive = (job: GeometryRequest, response: GeometryResponse) => {
      if (this.disposed) return;
      const current = job.revision === this.current?.revision;
      if (response.error) { if (current) callbacks.error(response.error); return; }
      if (!response.result || (!current && job.quality === 'final')) return;
      if (job.revision < this.displayed.revision || (job.revision === this.displayed.revision && this.displayed.quality === 'final')) return;
      this.displayed = { revision: job.revision, quality: job.quality };
      callbacks.result(response.result, job.scene, current, job.startedAt);
    };
    const fail = (message: string) => { if (!this.disposed) callbacks.error(message); };
    this.preview = new LatestWorker(createWorker(), receive, fail);
    this.final = new LatestWorker(createWorker(), receive, fail);
  }
  update(scene: SceneState) {
    const key = geometryKey(scene);
    if (this.disposed || key === this.key) return;
    this.key = key;
    const job: GeometryRequest = { revision: ++this.revision, scene: cloneScene(scene), quality: 'preview', startedAt: performance.now() };
    this.current = job; this.callbacks.pending();
    this.final.clearPending();
    if (this.refinement) clearTimeout(this.refinement);
    this.preview.request(job);
    this.refinement = setTimeout(() => {
      this.refinement = null;
      if (!this.disposed && this.current === job) this.final.request({ ...job, quality: 'final' });
    }, REFINEMENT_DELAY);
  }
  dispose() {
    this.disposed = true;
    if (this.refinement) clearTimeout(this.refinement);
    this.preview.dispose(); this.final.dispose();
  }
}
