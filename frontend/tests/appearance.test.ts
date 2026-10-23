import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { formAppearance, referenceAppearance, setFormAppearance } from '../src/appearance';
import { addShape, cloneScene, CUT_SCENE, DEFAULT_SCENE, getShape, removeShape, shapeEntries } from '../src/scene';
import { geometryKey } from '../src/geometry-pipeline';
import { evaluateScene } from '../src/geometry';
import { decodeStudy, DEFAULT_CAMERA, encodeStudy, parseSharedStudy, type SharedStudy } from '../src/share-state';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
function study(): SharedStudy {
  const scene = cloneScene(CUT_SCENE);
  for (let i = 0; i < 4; i++) addShape(scene, 'box');
  return { version: 4, scene, display: 'forms', camera: structuredClone(DEFAULT_CAMERA),
    reveals: { cutter: true, construction: false, hidden: true, seam: true }, locked: false, focus: false };
}

describe('individual form appearance', () => {
  it('makes Form A completely transparent in a legacy cut view while keeping every cutter as wireframe', () => {
    const scene = study().scene;
    expect(referenceAppearance(scene, 'solid').result).toBe(true);
    setFormAppearance(scene, 'a', 'wireframe', 'solid');
    expect(referenceAppearance(scene, 'forms')).toEqual({ result: false, solidForms: [], wireForms: ['a', 'b', 'c', 'd', 'e', 'f'], allWireframe: true });
  });
  it('fills only the selected original form, with all other forms staying transparent', () => {
    const scene = study().scene;
    setFormAppearance(scene, 'b', 'solid', 'wireframe');
    expect(referenceAppearance(scene, 'forms')).toEqual({ result: false, solidForms: ['b'], wireForms: ['a', 'c', 'd', 'e', 'f'], allWireframe: false });
    setFormAppearance(scene, 'a', 'solid', 'forms');
    expect(referenceAppearance(scene, 'forms').solidForms).toEqual(['a', 'b']);
    expect(referenceAppearance(scene, 'wireframe')).toEqual({ result: false, solidForms: [], wireForms: ['a', 'b', 'c', 'd', 'e', 'f'], allWireframe: true });
    expect(referenceAppearance(scene, 'forms').solidForms).toEqual(['a', 'b']);
  });
  it('keeps settings on their forms when another form is removed, and restores them from a snapshot', () => {
    const scene = study().scene;
    setFormAppearance(scene, 'c', 'solid', 'wireframe');
    const snapshot = cloneScene(scene);
    removeShape(scene, 'a');
    expect(getShape(scene, 'b').appearance).toBe('solid');
    expect(referenceAppearance(scene, 'forms').solidForms).toEqual(['b']);
    expect(referenceAppearance(snapshot, 'forms').solidForms).toEqual(['c']);
    scene.operation = 'single';
    expect(referenceAppearance(scene, 'forms').wireForms).toEqual(['a']);
    expect(referenceAppearance(scene, 'forms').solidForms).toEqual([]);
  });
  it('does not invalidate geometry when changing individual appearances', () => {
    const scene = study().scene, key = geometryKey(scene);
    setFormAppearance(scene, 'a', 'wireframe', 'solid');
    expect(geometryKey(scene)).toBe(key);
    setFormAppearance(scene, 'f', 'solid', 'forms');
    expect(geometryKey(scene)).toBe(key);
    scene.extraShapes![3].size[0] += .5;
    expect(geometryKey(scene)).not.toBe(key);
  });
  it('keeps shaded source surfaces available, including cutters excluded from the result', () => {
    const scene = cloneScene(CUT_SCENE), result = evaluateScene(wasm, scene, 'preview');
    for (const [id] of shapeEntries(scene)) {
      const source = result.sources[id]!;
      expect(source.normals?.length).toBe(source.positions.length);
      expect(source.normals?.every(Number.isFinite)).toBe(true);
      expect(source.indices.length).toBeGreaterThan(0);
    }
    expect(result.volume).toBeLessThan(result.bodyVolume);
  });
  it('always includes the first form in all-wireframe, even when it has a solid preference', () => {
    const scene = cloneScene(DEFAULT_SCENE); scene.a.appearance = 'solid';
    expect(referenceAppearance(scene, 'wireframe')).toEqual({ result: false, solidForms: [], wireForms: ['a'], allWireframe: true });
    expect(formAppearance(scene, 'a', 'wireframe')).toBe('wireframe');
  });
});

describe('appearance in shared studies', () => {
  it('preserves six independent appearances and the mixed view', () => {
    const original = study();
    setFormAppearance(original.scene, 'a', 'wireframe', 'solid');
    setFormAppearance(original.scene, 'd', 'solid', 'forms');
    setFormAppearance(original.scene, 'f', 'solid', 'forms');
    expect(decodeStudy(encodeStudy(original))).toEqual(original);
    expect(referenceAppearance(decodeStudy(encodeStudy(original))!.scene, 'forms').solidForms).toEqual(['d', 'f']);
  });
  it.each(['solid', 'wireframe'] as const)('reads legacy v3 %s links and upgrades customized studies', display => {
    const original: SharedStudy = { ...study(), version: 3, display };
    expect(decodeStudy(encodeStudy(original))).toEqual(original);
    setFormAppearance(original.scene, 'a', 'wireframe', display);
    original.display = 'forms';
    expect(decodeStudy(encodeStudy(original))).toEqual({ ...original, version: 4 });
  });
  it.each([null, 1, {}, 'glass'])('rejects invalid per-form appearances (%#)', appearance => {
    const original = study();
    expect(() => parseSharedStudy({ ...original, scene: { ...original.scene, a: { ...original.scene.a, appearance } } })).toThrow(/damaged/);
  });
  it('does not accept per-form mode or fields in legacy versions', () => {
    expect(() => parseSharedStudy({ ...study(), version: 3 })).toThrow(/damaged/);
    const original = study(); original.scene.a.appearance = 'wireframe';
    expect(() => parseSharedStudy({ ...original, display: 'solid', version: 3 })).toThrow(/damaged/);
  });
});
