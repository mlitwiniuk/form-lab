import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GeometryPipeline, REFINEMENT_DELAY, type GeometryRequest, type GeometryResponse, type GeometryWorkerPort } from '../src/geometry-pipeline';
import { cloneScene, PRESETS } from '../src/scene';
import type { RenderGeometry } from '../src/render-geometry';

class FakeWorker implements GeometryWorkerPort {
  onmessage: GeometryWorkerPort['onmessage'] = null;
  onerror: GeometryWorkerPort['onerror'] = null;
  requests: GeometryRequest[] = [];
  terminated = false;
  postMessage(message: GeometryRequest) { this.requests.push(message); }
  terminate() { this.terminated = true; }
  reply(index = this.requests.length - 1, error?: string) {
    const job = this.requests[index];
    const data: GeometryResponse = { revision: job.revision, ...(error ? { error } : { result: { quality: job.quality } as RenderGeometry }) };
    this.onmessage?.({ data } as MessageEvent<GeometryResponse>);
  }
}
const scene = (twist: number) => { const value = cloneScene(PRESETS[4].scene); value.a.deform.twist = twist; return value; };
const pipelines: GeometryPipeline[] = [];
function setup() {
  const workers: FakeWorker[] = [];
  const callbacks = { pending: vi.fn(), result: vi.fn(), error: vi.fn() };
  const pipeline = new GeometryPipeline(() => { const worker = new FakeWorker(); workers.push(worker); return worker; }, callbacks);
  pipelines.push(pipeline);
  return { pipeline, preview: workers[0], final: workers[1], ...callbacks };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { pipelines.splice(0).forEach(p => p.dispose()); vi.useRealTimers(); });

describe('responsive geometry scheduling', () => {
  it('starts immediately and collapses a burst of 100 edits into the latest pending scene', () => {
    const { pipeline, preview, final } = setup();
    for (let twist = 0; twist < 100; twist++) pipeline.update(scene(twist));
    expect(preview.requests).toHaveLength(1);
    expect(final.requests).toHaveLength(0);
    preview.reply();
    expect(preview.requests).toHaveLength(2);
    expect(preview.requests[1].scene.a.deform.twist).toBe(99);
    vi.advanceTimersByTime(REFINEMENT_DELAY - 1); expect(final.requests).toHaveLength(0);
    vi.advanceTimersByTime(1); expect(final.requests).toHaveLength(1);
    expect(final.requests[0].scene.a.deform.twist).toBe(99);
  });
  it('displays intermediate previews during continuous input with their own scene snapshot', () => {
    const { pipeline, preview, result } = setup();
    const first = scene(20); pipeline.update(first); first.a.deform.twist = 100;
    pipeline.update(scene(40)); preview.reply();
    expect(result.mock.calls[0][1].a.deform.twist).toBe(20);
    expect(result.mock.calls[0][2]).toBe(false);
    preview.reply(); expect(result.mock.calls[1][1].a.deform.twist).toBe(40);
    expect(result.mock.calls[1][2]).toBe(true);
  });
  it('keeps previews moving while a previous detailed calculation is busy', () => {
    const { pipeline, preview, final, result } = setup();
    pipeline.update(scene(10)); preview.reply(); vi.advanceTimersByTime(REFINEMENT_DELAY);
    pipeline.update(scene(50)); preview.reply();
    expect(result.mock.calls.at(-1)?.[1].a.deform.twist).toBe(50);
    expect(final.requests).toHaveLength(1);
    const count = result.mock.calls.length; final.reply();
    expect(result).toHaveBeenCalledTimes(count);
    vi.advanceTimersByTime(REFINEMENT_DELAY); final.reply();
    expect(result.mock.calls.at(-1)?.[0].quality).toBe('final');
    expect(result.mock.calls.at(-1)?.[1].a.deform.twist).toBe(50);
  });
  it('cancels a queued refinement when editing resumes', () => {
    const { pipeline, final } = setup();
    pipeline.update(scene(10)); vi.advanceTimersByTime(REFINEMENT_DELAY);
    pipeline.update(scene(20)); vi.advanceTimersByTime(REFINEMENT_DELAY);
    pipeline.update(scene(30)); final.reply();
    expect(final.requests).toHaveLength(1);
    vi.advanceTimersByTime(REFINEMENT_DELAY);
    expect(final.requests).toHaveLength(2); expect(final.requests[1].scene.a.deform.twist).toBe(30);
  });
  it('never lets a preview downgrade an already finished final result', () => {
    const { pipeline, preview, final, result } = setup();
    pipeline.update(scene(70)); vi.advanceTimersByTime(REFINEMENT_DELAY); final.reply(); preview.reply();
    expect(result).toHaveBeenCalledTimes(1); expect(result.mock.calls[0][0].quality).toBe('final');
  });
  it('does not recalculate solids for contour count or an inactive second operand', () => {
    const { pipeline, preview, final } = setup();
    const study = scene(25); pipeline.update(study); preview.reply(); vi.advanceTimersByTime(REFINEMENT_DELAY); final.reply();
    study.contours = 8; study.b.deform.twist = 50; pipeline.update(study); vi.advanceTimersByTime(1000);
    expect(preview.requests).toHaveLength(1); expect(final.requests).toHaveLength(1);
  });
  it('ignores errors for superseded scenes but reports a current geometry failure', () => {
    const { pipeline, preview, error } = setup();
    pipeline.update(scene(1)); pipeline.update(scene(2)); preview.reply(0, 'obsolete');
    expect(error).not.toHaveBeenCalled(); preview.reply(1, 'current failure');
    expect(error).toHaveBeenCalledWith('current failure');
  });
  it('cleans up workers and delayed refinements on dispose', () => {
    const { pipeline, preview, final, result } = setup();
    pipeline.update(scene(1)); pipeline.dispose(); vi.advanceTimersByTime(20000);
    expect(preview.terminated).toBe(true); expect(final.terminated).toBe(true);
    expect(final.requests).toHaveLength(0); preview.reply(); expect(result).not.toHaveBeenCalled();
  });
  it('times out a stuck worker instead of building an unlimited queue', () => {
    const { pipeline, preview, error } = setup(); pipeline.update(scene(1));
    vi.advanceTimersByTime(12000);
    expect(preview.terminated).toBe(true); expect(error).toHaveBeenCalledWith(expect.stringContaining('too long'));
  });
});
