import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { addShape, cloneScene, generateRounded, PRESETS, type SceneState } from '../src/scene';
import { decodeStudy, DEFAULT_CAMERA, encodeStudy, MAX_SHARE_BYTES, type SharedStudy } from '../src/share-state';
import { StudyCamera } from '../src/study-camera';

const study = (scene: SceneState = PRESETS.find(p => p.name === 'S-curve')!.scene): SharedStudy => ({ version: 1, scene: cloneScene(scene),
  camera: structuredClone(DEFAULT_CAMERA), reveals: { construction: true, hidden: true, cutter: false, seam: false },
  locked: true, focus: true });
function rawLink(value: unknown) {
  const bytes = zlibSync(new TextEncoder().encode(JSON.stringify(value)));
  return '#s=' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

describe('share link format', () => {
  it.each(['turn', 'tilt'] as const)('restores the %s drag constraint together with a precise view angle', mode => {
    const view = new StudyCamera(); view.setProjection('orthographic');
    view.setAngle('turn', 75); view.setAngle('tilt', 0); view.orbitMode = mode;
    const original: SharedStudy = { ...study(), version: 5, display: 'wireframe', camera: view.getState() };
    const restored = decodeStudy(encodeStudy(original))!;
    expect(restored).toEqual(original);
    const camera = new StudyCamera(); camera.setState(restored.camera);
    expect(camera.orbitMode).toBe(mode);
    expect(camera.getAngles().turn).toBeCloseTo(75, 10); expect(camera.getAngles().tilt).toBeCloseTo(0, 10);
  });
  it('opens previous v5 links with unrestricted orbiting', () => {
    const view = new StudyCamera(); view.orbitMode = 'turn';
    const previous = decodeStudy(rawLink({ ...study(), version: 5, display: 'wireframe', camera: { ...DEFAULT_CAMERA, projection: 'orthographic', orthographicSpan: 10 } }))!;
    view.setState(previous.camera); expect(view.orbitMode).toBe('free');
    expect(view.getState().orbitMode).toBeUndefined();
  });
  it('upgrades a legacy camera when only an axis constraint is chosen', () => {
    const original = study(); original.camera.orbitMode = 'turn';
    const updated = decodeStudy(encodeStudy(original))!;
    expect(updated.version).toBe(5);
    expect(updated.camera).toEqual({ ...original.camera, projection: 'perspective' });
  });
  it.each([null, 'roll', false, 1, {}])('rejects malformed camera axis constraints (%#)', orbitMode => {
    expect(() => decodeStudy(rawLink({ ...study(), version: 5, display: 'wireframe', camera: { ...DEFAULT_CAMERA, projection: 'perspective', orbitMode } }))).toThrow(/damaged/);
  });
  it.each(['perspective', 'orthographic'] as const)('restores v5 %s with all six appearances, zoom, and camera position', projection => {
    const original = study(PRESETS[0].scene), view = new StudyCamera();
    for (let i = 0; i < 5; i++) addShape(original.scene, 'box');
    original.scene.a.appearance = 'wireframe'; original.scene.b.appearance = 'solid';
    view.setProjection(projection);
    if (projection === 'orthographic') { view.camera.zoom *= 1.3; view.camera.updateProjectionMatrix(); }
    original.version = 5; original.display = 'forms'; original.camera = view.getState();
    const restored = decodeStudy(encodeStudy(original))!;
    expect(restored).toEqual(original);
    const restoredView = new StudyCamera(); restoredView.resize(390, 600); restoredView.setState(restored.camera);
    expect(restoredView.getState()).toEqual(original.camera);
  });
  it.each([1, 2, 3, 4] as const)('opens legacy v%s cameras in perspective and upgrades an orthographic edit', version => {
    const original: SharedStudy = { ...study(), version, ...(version >= 3 ? { display: 'solid' } : {}) };
    const decoded = decodeStudy(encodeStudy(original))!;
    const view = new StudyCamera(); view.setProjection('orthographic'); view.setState(decoded.camera);
    expect(view.projection).toBe('perspective');
    view.setProjection('orthographic'); decoded.camera = view.getState();
    const updated = decodeStudy(encodeStudy(decoded))!;
    expect(updated.version).toBe(5); expect(updated.camera).toEqual(view.getState());
  });
  it.each([undefined, null, 0, -.1, 200.01, Infinity, '10'])('rejects missing or unsafe orthographic spans (%#)', orthographicSpan => {
    expect(() => decodeStudy(rawLink({ ...study(), version: 5, display: 'wireframe',
      camera: { ...DEFAULT_CAMERA, projection: 'orthographic', orthographicSpan } }))).toThrow(/damaged/);
  });
  it.each([undefined, null, 'parallel', 1, {}])('rejects missing or invalid v5 projections (%#)', projection => {
    expect(() => decodeStudy(rawLink({ ...study(), version: 5, display: 'wireframe', camera: { ...DEFAULT_CAMERA, projection } }))).toThrow(/damaged/);
  });
  it.each(PRESETS)('restores $name with its complete view', preset => {
    const original = study(preset.scene), link = encodeStudy(original);
    expect(link).toMatch(/^#s=[A-Za-z0-9_-]+$/);
    expect(link.length).toBeLessThan(1800);
    expect(decodeStudy(link)).toEqual(original);
    expect(encodeStudy(decodeStudy(link)!)).toBe(link);
  });
  it('preserves generated parameters and floating point precision, without a seed', () => {
    let seed = 42;
    for (let i = 0; i < 40; i++) {
      const original = study(generateRounded(() => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)));
      expect(decodeStudy(encodeStudy(original))).toEqual(original);
    }
  });
  it.each(['single', 'subtract', 'union', 'intersect', 'reverse', 'exclude'] as const)('retains both operands for %s', operation => {
    const original = study(); original.scene.operation = operation;
    original.scene.b = cloneScene(PRESETS.find(p => p.name === 'S-curve')!.scene).a;
    original.scene.b.spine![2] = { position: [.123456789012345, -.2, .02], radius: .456789012345 };
    original.scene.a.deform.twist = 147; original.scene.a.rotation = [12, -34, 56];
    original.camera = { position: [12.4, -7.8, 3.9], target: [2.5, 1.5, -.9] };
    expect(decodeStudy(encodeStudy(original))).toEqual(original);
  });
  it.each(['solid', 'wireframe'] as const)('restores the %s view with all six forms and reveal preferences', display => {
    const original: SharedStudy = { ...study(PRESETS[0].scene), version: 3, display };
    for (let i = 0; i < 5; i++) addShape(original.scene, 'box');
    expect(decodeStudy(encodeStudy(original))).toEqual(original);
  });
  it.each([1, 2] as const)('keeps legacy v%s links readable and upgrades them when a display mode is chosen', version => {
    const original: SharedStudy = { ...study(), version };
    expect(decodeStudy(encodeStudy(original))).toEqual(original);
    expect(decodeStudy(encodeStudy({ ...original, display: 'wireframe' }))).toEqual({ ...original, version: 3, display: 'wireframe' });
  });
  it.each([undefined, null, 'transparent', 1, {}])('rejects missing or invalid v3 display modes (%#)', display => {
    expect(() => decodeStudy(rawLink({ ...study(), version: 3, display }))).toThrow(/damaged/);
  });
  it('accepts no snapshot as a fresh visit', () => { expect(decodeStudy('')).toBeNull(); expect(decodeStudy('#')).toBeNull(); });
  it.each(['#unrecognized', '#s=', '#s=++++', '#s=a', '#s=truncated', '#s=' + 'a'.repeat(12001)])('rejects malformed or oversized hashes (%#)', hash => {
    expect(() => decodeStudy(hash)).toThrow();
  });
  it('rejects future versions with a useful explanation', () => {
    expect(() => decodeStudy(rawLink({ ...study(), version: 6 }))).toThrow(/newer or unsupported/);
  });
  it('checks the checksum, even when the compressed content is otherwise valid', () => {
    const bytes = zlibSync(new TextEncoder().encode(JSON.stringify(study()))); bytes[bytes.length - 1] ^= 1;
    const token = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    expect(() => decodeStudy('#s=' + token)).toThrow(/damaged/);
  });
  it('bounds decompressed data independently of compressed size', () => {
    const link = rawLink({ ...study(), extra: 'x'.repeat(MAX_SHARE_BYTES * 50) });
    expect(link.length).toBeLessThan(12000);
    expect(() => decodeStudy(link)).toThrow(/damaged/);
  });
  it.each([
    (s: SharedStudy) => { s.scene.a.size[0] = 0; },
    (s: SharedStudy) => { s.scene.a.position[0] = Infinity; },
    (s: SharedStudy) => { s.scene.a.spine![2].radius = 2; },
    (s: SharedStudy) => { s.scene.a.spine![2].position[2] = -.5; },
    (s: SharedStudy) => { s.scene.a.spine = Array(8).fill(s.scene.a.spine![0]); },
    (s: SharedStudy) => { s.scene.a.deform.twist = 181; },
    (s: SharedStudy) => { s.scene.contours = 1.5; },
    (s: SharedStudy) => { s.camera.position = [...s.camera.target]; },
    (s: SharedStudy) => { s.camera.target = [1e100, 0, 0]; },
  ])('rejects unsafe geometry or camera parameters (%#)', change => {
    const original = study(); change(original);
    expect(() => decodeStudy(rawLink(original))).toThrow();
  });
  it.each([{}, null, [], { version: 1 }, { ...study(), scene: [] }, { ...study(), reveals: { hidden: 'true' } }, { ...study(), locked: 1 }])('rejects missing or mistyped state (%#)', value => {
    expect(() => decodeStudy(rawLink(value))).toThrow();
  });
  it('ignores unknown fields rather than copying them into application state', () => {
    const original = study();
    expect(decodeStudy(rawLink({ ...original, extra: 'ignored' }))).toEqual(original);
  });
});
