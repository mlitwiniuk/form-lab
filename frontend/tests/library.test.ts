import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, configurationUrl, request, studyFromSave, type SavedConfiguration } from '../src/library';
import { DEFAULT_CAMERA, type SharedStudy } from '../src/share-state';
import { cloneScene, PRESETS } from '../src/scene';
afterEach(() => vi.unstubAllGlobals());
describe('account library boundary', () => {
  it('restores every study setting through the same validated format as sharing', () => {
    const original: SharedStudy = { version: 5, display: 'forms', scene: cloneScene(PRESETS.find(p => p.name === 'S-curve')!.scene), camera: { ...structuredClone(DEFAULT_CAMERA), projection: 'orthographic', orthographicSpan: 9, orbitMode: 'tilt' }, reveals: { construction: true, hidden: true, cutter: false, seam: false }, locked: true, focus: true };
    original.scene.a.appearance = 'wireframe'; original.scene.b.appearance = 'solid';
    const restored = studyFromSave(JSON.parse(JSON.stringify(original))); expect(restored).toEqual(original);
    restored.scene.a.size[0] = 6; expect(original.scene.a.size[0]).not.toBe(6);
    expect(() => studyFromSave({ ...original, camera: { ...original.camera, orthographicSpan: Infinity } })).toThrow();
  });
  it('opens private saves in the matching tool with an encoded identifier', () => {
    const save: SavedConfiguration = { id: 'id&other=1', kind: 'study', title: 'Name', settings: {}, revision: 1, updated_at: 1 };
    expect(configurationUrl(save)).toBe('/?save=id%26other%3D1');
    expect(configurationUrl({ ...save, kind: 'sketchfab' })).toBe('/sketchfab/?save=id%26other%3D1');
  });
  it('uses same-origin cookies, disables caching and sends revision-protected overwrites', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: 2 }), { headers: { 'Content-Type': 'application/json' } })); vi.stubGlobal('fetch', fetch);
    await expect(request('configurations/id', 'PUT', { expected_revision: 1, title: 'Updated' })).resolves.toEqual({ revision: 2 });
    expect(fetch).toHaveBeenCalledWith('/api/configurations/id', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', method: 'PUT', body: JSON.stringify({ expected_revision: 1, title: 'Updated' }) }));
  });
  it('preserves actionable overwrite conflicts and recognizes expired sessions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('This save changed on another device.', { status: 409 })));
    await expect(request('configurations/id')).rejects.toMatchObject({ status: 409, message: 'This save changed on another device.' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Please sign in.', { status: 401 })));
    const expired = request('me');
    await expect(expired).rejects.toBeInstanceOf(ApiError);
    await expect(expired).rejects.toMatchObject({ status: 401 });
  });
  it('handles static hosting fallback and network failure without treating them as accounts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } })));
    await expect(request('me')).rejects.toThrow('Accounts are unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(request('me')).rejects.toThrow('Could not connect');
  });
});
