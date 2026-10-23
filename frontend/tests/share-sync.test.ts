import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneScene, PRESETS } from '../src/scene';
import { decodeStudy, DEFAULT_CAMERA, type SharedStudy } from '../src/share-state';
import { ShareSync } from '../src/share-sync';

describe('URL synchronization', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  function fixture() {
    const state: SharedStudy = { version: 1, scene: cloneScene(PRESETS[9].scene), camera: structuredClone(DEFAULT_CAMERA),
      reveals: { hidden: false, cutter: true, construction: true, seam: true }, locked: false, focus: false };
    const write = vi.fn(), error = vi.fn();
    return { state, write, error, sync: new ShareSync(() => state, write, error) };
  }
  it('coalesces rapid edits and writes the newest forms and camera', () => {
    const { state, write, sync } = fixture();
    for (let i = 0; i < 20; i++) { state.scene.a.deform.twist = i; sync.schedule(); vi.advanceTimersByTime(10); }
    state.camera.target[0] = 2; state.reveals.hidden = true;
    expect(write).not.toHaveBeenCalled(); vi.advanceTimersByTime(200);
    expect(write).toHaveBeenCalledTimes(1); expect(decodeStudy(write.mock.calls[0][0])).toEqual(state);
  });
  it('updates during continuous edits without waiting for a pause', () => {
    const { state, write, sync } = fixture();
    for (let i = 0; i < 100; i++) { state.scene.a.deform.twist = i; sync.schedule(); vi.advanceTimersByTime(10); }
    expect(write).toHaveBeenCalledTimes(2);
    sync.flush(); expect(decodeStudy(write.mock.calls.at(-1)![0])).toEqual(state);
  });
  it('flushes an immediate copy or release and cancels the older pending write', () => {
    const { state, write, sync } = fixture();
    sync.schedule(); state.scene.a.spine![2].radius = .4;
    expect(decodeStudy(sync.flush())).toEqual(state);
    vi.runAllTimers(); expect(write).toHaveBeenCalledTimes(1);
  });
  it('reads undo/redo results instead of caching the previous edit', () => {
    const { state, write, sync } = fixture();
    state.scene.a.deform.twist = 90; sync.schedule(); state.scene = cloneScene(PRESETS[0].scene);
    vi.runAllTimers(); expect(decodeStudy(write.mock.calls[0][0])?.scene).toEqual(PRESETS[0].scene);
  });
  it('cancels pending writes before navigation or disposal', () => {
    const { sync, write } = fixture(); sync.schedule(); sync.cancel(); vi.runAllTimers(); expect(write).not.toHaveBeenCalled();
  });
  it('reports scheduled errors and can recover on a subsequent edit', () => {
    const { state, sync, write, error } = fixture();
    state.scene.contours = 99; sync.schedule(); vi.runAllTimers(); expect(error).toHaveBeenCalledOnce(); expect(write).not.toHaveBeenCalled();
    state.scene.contours = 5; sync.schedule(); vi.runAllTimers(); expect(write).toHaveBeenCalledOnce();
  });
});
