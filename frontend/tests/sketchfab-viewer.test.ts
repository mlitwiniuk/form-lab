import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_MODEL, SketchfabReference, modelId, parseSketchfabSettings, settingsFromSearch, settingsUrl, type ViewerApi, type ViewerClient } from '../src/sketchfab-viewer';
function setup(autoReady = true) {
  const camera = { position: [10, -10, 10] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
  let fov = 45; const ready: (() => void)[] = [], fovRequests: number[] = [];
  const api: ViewerApi = {
    start: vi.fn(), addEventListener: (_event, callback) => { ready.push(callback); }, setBackground: vi.fn(),
    getCameraLookAt: callback => callback(null, structuredClone(camera)), getFov: callback => callback(null, fov),
    setFov: (value, callback) => { fovRequests.push(value); fov = value; callback(null, value); },
    setCameraLookAt: (position, target, _duration, callback) => { camera.position = [...position] as [number, number, number]; camera.target = [...target] as [number, number, number]; callback?.(null); },
    setUserInteraction: vi.fn(), getScreenShot: (_type, callback) => callback(null, 'data:image/png;base64,example'),
  };
  const client: ViewerClient = { init: vi.fn((_uid, options) => { options.success(api); if (autoReady) ready.at(-1)!(); }) };
  const reference = new SketchfabReference(client, vi.fn());
  return { reference, client, api, camera, fovRequests, ready, fov: () => fov, distance: () => Math.hypot(...camera.position.map((v, i) => v - camera.target[i])) };
}
describe('Sketchfab references', () => {
  it('disables animation autoplay for initial, saved and replacement models', async () => {
    const s = setup();
    await s.reference.load(DEFAULT_MODEL);
    const saved = await s.reference.capture();
    await s.reference.load(saved.uid, saved);
    await s.reference.load('AnotherModel');
    expect(s.client.init).toHaveBeenCalledTimes(3);
    for (const [, options] of vi.mocked(s.client.init).mock.calls) {
      expect(options.animation_autoplay).toBe(0);
    }
  });
  it('preserves the initial framing using the supported minimum FOV', async () => {
    const s = setup(), before = s.distance(); await s.reference.load(DEFAULT_MODEL);
    expect(s.fovRequests).toEqual([1]);
    expect(s.distance() * Math.tan(s.fov() * Math.PI / 360)).toBeCloseTo(before * Math.tan(45 * Math.PI / 360), 6);
  });
  it('switches between flat, original and wide while preserving target and framing', async () => {
    const s = setup(); await s.reference.load(DEFAULT_MODEL); const distance = s.distance();
    await s.reference.projection('original'); expect(s.fov()).toBe(45);
    expect(s.distance() * Math.tan(45 * Math.PI / 360)).toBeCloseTo(distance * Math.tan(Math.PI / 360), 6);
    await s.reference.projection('wide'); expect(s.fov()).toBe(85);
    await s.reference.projection('flat'); expect(s.distance()).toBeCloseTo(distance, 6);
  });
  it('restores a shared model and camera', async () => {
    const s = setup(), view = settingsFromSearch('?model=Abc123&projection=wide&position=12,-24,18&target=1,2,3&fov=92&step=15&locked=1')!;
    await s.reference.load(view.uid, view);
    expect(s.camera.position).toEqual([12, -24, 18]); expect(s.camera.target).toEqual([1, 2, 3]); expect(s.fov()).toBe(92);
    expect(s.reference.state.step).toBe(15); expect(s.reference.state.locked).toBe(true);
    expect(s.api.setUserInteraction).toHaveBeenLastCalledWith(false);
  });
  it('keeps legacy shared links and model-only saved entries usable', async () => {
    const s = setup(), view = settingsFromSearch('?model=Abc123&projection=wide&position=12,-24,18&target=1,2,3')!;
    await s.reference.load(view.uid, view); expect(s.fov()).toBe(85);
    await s.reference.load('Abc123', { version: 1, uid: 'Abc123' }); expect(s.reference.state.projection).toBe('flat');
  });
  it('captures the loaded model and round-trips exact camera settings without account data', async () => {
    const s = setup(); await s.reference.load(DEFAULT_MODEL); await s.reference.orbit('up'); s.reference.step(15);
    const saved = await s.reference.capture(), url = new URL(settingsUrl(saved, 'https://example.test'));
    expect(url.searchParams.get('model')).toBe(DEFAULT_MODEL); expect(url.searchParams.has('save')).toBe(false);
    const other = setup(); await other.reference.load(DEFAULT_MODEL, settingsFromSearch(url.search));
    expect(other.camera.position).toEqual(s.camera.position.map(n => Number(n.toPrecision(12))));
    expect(other.reference.state.step).toBe(15);
  });
  it('does not apply an initial shared camera to a later model', async () => {
    const s = setup(); await s.reference.load('Abc123', settingsFromSearch('?model=Abc123&projection=wide&position=12,-24,18&target=1,2,3'));
    await s.reference.load('AnotherModel'); expect(s.reference.state.projection).toBe('flat'); expect(s.fov()).toBe(1);
  });
  it('rejects malformed vectors, unsupported FOV, drawing settings and URLs', () => {
    const view = { version: 1, uid: 'abc', projection: 'wide', fov: 85, position: [1, 2, 3], target: [0, 0, 0] };
    for (const data of [{ ...view, position: [NaN, 2, 3] }, { ...view, position: [1e10, 2, 3] }, { ...view, fov: .01 }, { ...view, fov: Infinity }, { ...view, target: [1, 2, 3] }, { ...view, step: 12 }, { ...view, locked: 'yes' }]) expect(() => parseSketchfabSettings(data)).toThrow();
    expect(settingsFromSearch('?model=abc&position=,,&target=0,0,0')).toEqual({ version: 1, uid: 'abc' });
    expect(modelId('https://sketchfab.com/3d-models/a-b-c-Abc123')).toBe('Abc123');
    expect(modelId('https://evil.example/models/abc')).toBe(null); expect(modelId('javascript:abc')).toBe(null);
  });
  it('rejects delayed captures after the loaded model changes', async () => {
    const s = setup(); await s.reference.load('FirstModel'); let delayed!: Parameters<ViewerApi['getCameraLookAt']>[0];
    const get = s.api.getCameraLookAt; s.api.getCameraLookAt = cb => { delayed = cb; };
    const capture = s.reference.capture(); const result = expect(capture).rejects.toThrow('model changed');
    s.api.getCameraLookAt = get; await s.reference.load('AnotherModel'); delayed(null, structuredClone(s.camera)); await result;
  });
  it('cancels a capture when a model changes between already-resolved SDK calls', async () => {
    const s = setup(); await s.reference.load('FirstModel');
    const capture = s.reference.capture(); const result = expect(capture).rejects.toThrow('model changed');
    await s.reference.load('SecondModel'); await result;
    expect(s.reference.state.uid).toBe('SecondModel');
  });
  it('ignores viewerready from a replaced initialization', async () => {
    const s = setup(false), first = s.reference.load('FirstModel'), second = s.reference.load('SecondModel');
    s.ready[0](); await first; expect(s.fovRequests).toEqual([]);
    s.ready[1](); await second; expect(s.reference.state.uid).toBe('SecondModel');
  });
  it('does not combine an old camera capture with a concurrent projection change', async () => {
    const s = setup(); await s.reference.load(DEFAULT_MODEL); let delayed!: Parameters<ViewerApi['getCameraLookAt']>[0];
    const get = s.api.getCameraLookAt; s.api.getCameraLookAt = cb => { delayed = cb; };
    const capture = s.reference.capture(); await expect(s.reference.projection('wide')).rejects.toThrow('Wait');
    s.api.getCameraLookAt = get; delayed(null, structuredClone(s.camera)); expect((await capture).projection).toBe('flat');
  });
  it('rotates horizontally at fixed elevation and radius, vertically at fixed azimuth', async () => {
    const s = setup(); await s.reference.load(DEFAULT_MODEL); const before = [...s.camera.position], distance = s.distance();
    await s.reference.orbit('left'); expect(s.camera.position[2]).toBeCloseTo(before[2], 5); expect(s.distance()).toBeCloseTo(distance, 6);
    const azimuth = Math.atan2(s.camera.position[1], s.camera.position[0]);
    await s.reference.orbit('up'); expect(Math.atan2(s.camera.position[1], s.camera.position[0])).toBeCloseTo(azimuth, 6);
    expect(s.camera.position[2]).not.toBeCloseTo(before[2], 3);
  });
  it('exports PNG and respects drawing lock without losing saved camera settings', async () => {
    const s = setup(); await s.reference.load(DEFAULT_MODEL); const position = [...s.camera.position];
    s.reference.lock(); await s.reference.orbit('left'); expect(s.camera.position).toEqual(position);
    expect((await s.reference.capture()).locked).toBe(true); expect(await s.reference.image()).toMatch(/^data:image\/png/);
  });
});
