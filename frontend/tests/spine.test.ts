import { beforeAll, describe, expect, it } from 'vitest';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { Vector3 } from 'three';
import { cloneScene, constrainCurvePoint, curveOffsetLimit, makeShape, PRESETS, validateScene, type Vec3 } from '../src/scene';
import { createSpineSampler } from '../src/spine';
import { constructionLines, createSectionSampler, curveFromShape, shapeMesh, validateSpineSweep } from '../src/forms';
import { evaluateScene } from '../src/geometry';
import { extractEdges } from '../src/edges';
import { geometryKey } from '../src/geometry-pipeline';
let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await Module(); wasm.setup(); });
const study = () => cloneScene(PRESETS.find(p => p.name === 'S-curve')!.scene);

describe('editable rounded centerlines', () => {
  it('interpolates all five point centers and their thicknesses, including both ends', () => {
    const shape = study().a, sample = createSpineSampler(shape);
    for (const [i, point] of shape.spine!.entries()) {
      const section = sample(i / 4);
      section.center.toArray().forEach((v, axis) => expect(v).toBeCloseTo(point.position[axis] * shape.size[axis], 6));
      expect(section.radius).toBeCloseTo(point.radius, 6);
    }
  });
  it('turns in opposite directions on the two halves of the S', () => {
    const sample = createSpineSampler(study().a);
    const turn = (u: number) => sample(u - .02).tangent.clone().cross(sample(u + .02).tangent).y;
    expect(turn(.25) * turn(.75)).toBeLessThan(0);
  });
  it('keeps perpendicular frames continuous through an inflection and depth bends', () => {
    const shape = study().a; shape.spine![1].position[1] = .12; shape.spine![3].position[1] = -.12;
    const sample = createSpineSampler(shape);
    let previous = sample(0);
    for (let i = 1; i <= 200; i++) {
      const frame = sample(i / 200);
      expect(frame.normal.dot(frame.tangent)).toBeCloseTo(0, 6);
      expect(frame.binormal.dot(frame.tangent)).toBeCloseTo(0, 6);
      expect(frame.normal.dot(previous.normal)).toBeGreaterThan(.98);
      expect(frame.normal.clone().cross(frame.binormal).dot(frame.tangent)).toBeCloseTo(1, 6);
      previous = frame;
    }
  });
  it('changes local thickness without moving the centerline or distant endpoint thickness', () => {
    const shape = study().a, before = createSectionSampler(shape), u = 0;
    const oldCenter = new Vector3(...before(u, 0, true));
    const oldRadius = new Vector3(...before(u, 0)).distanceTo(oldCenter);
    const endRadius = createSpineSampler(shape)(1).radius;
    shape.spine![2].radius *= .5;
    const after = createSectionSampler(shape), center = new Vector3(...after(u, 0, true));
    expect(center.distanceTo(oldCenter)).toBe(0);
    expect(new Vector3(...after(u, 0)).distanceTo(center) / oldRadius).toBeCloseTo(.5, 6);
    expect(createSpineSampler(shape)(1).radius).toBe(endRadius);
  });
  it.each(['preview', 'final'] as const)('%s mesh is closed and every contour vertex lies on its surface mesh', quality => {
    const scene = study(), shape = scene.a; shape.deform.twist = 95; shape.spine![1].position[1] = .08;
    const result = evaluateScene(wasm, scene, quality), mesh = shapeMesh(shape, quality), lines = constructionLines(shape, 9, quality);
    expect(result.volume).toBeGreaterThan(0);
    expect(extractEdges(result).every(edge => edge.normals.length === 2)).toBe(true);
    const key = (values: ArrayLike<number>) => Array.from(values).map(n => Math.round(Math.fround(n) * 1e5)).join(',');
    const vertices = new Set(Array.from({length: mesh.positions.length / 3}, (_, i) => key(mesh.positions.slice(i*3,i*3+3))));
    for (let i = 0; i < lines.sections.length; i += 3) expect(vertices.has(key(lines.sections.slice(i,i+3)))).toBe(true);
  });
  it('preserves a rounded arc’s point positions when enabling the editor', () => {
    const shape = cloneScene(PRESETS[5].scene).a, before = createSectionSampler(structuredClone(shape));
    shape.spine = curveFromShape(shape); shape.deform.bend = 0;
    const after = createSectionSampler(shape);
    for (let i = 0; i < 5; i++) {
      const expected = new Vector3(...before(i / 4 - .5, 0, true));
      expect(new Vector3(...after(i / 4 - .5, 0, true)).distanceTo(expected)).toBeLessThan(1e-6);
    }
    expect(() => validateSpineSweep(shape)).not.toThrow();
  });
  it('keeps point order, fixed end stations and lateral bounds during a drag', () => {
    const shape = study().a;
    const constrained = constrainCurvePoint(shape, 2, [9,-9,9]);
    expect(constrained.slice(0,2)).toEqual([curveOffsetLimit(shape, 0), -curveOffsetLimit(shape, 1)]); expect(constrained[2]).toBeCloseTo(.17, 6);
    expect(constrainCurvePoint(shape, 0, [0,0,1])[2]).toBe(-.5);
    expect(constrainCurvePoint(shape, 4, [0,0,-1])[2]).toBe(.5);
  });
  it('rejects invalid radii, coincident points and a locally folded sweep', () => {
    const scene = study(); scene.a.spine![2].radius = NaN;
    expect(() => validateScene(scene)).toThrow('thickness');
    scene.a.spine![2].radius = 1;
    scene.a.spine![2].position = [...scene.a.spine![1].position] as Vec3;
    expect(() => validateScene(scene)).toThrow('ordered');
    const folded = study().a; folded.spine![2].position[0] = 1.5;
    expect(() => validateSpineSweep(folded)).toThrow('too tight');
  });
  it('supports a curved form as either operand in all solid operations', () => {
    const scene = study(); scene.b = makeShape('sphere', [2.8,2.8,2.8]); scene.b.position = [.6,0,0];
    for (const operation of ['subtract','union','intersect','reverse','exclude'] as const) {
      scene.operation = operation; const result = evaluateScene(wasm,scene,'preview');
      expect(result.volume).toBeGreaterThan(0); expect(result.overlapVolume).toBeGreaterThan(0);
      expect(extractEdges(result).some(edge => edge.seam)).toBe(true);
    }
    [scene.a,scene.b] = [scene.b,scene.a];
    expect(evaluateScene(wasm,scene,'preview').volume).toBeGreaterThan(0);
  });
  it('includes point movement and thickness in geometry scheduling and undo snapshots', () => {
    const scene = study(), saved = cloneScene(scene), key = geometryKey(scene);
    scene.a.spine![2].radius = .4; expect(geometryKey(scene)).not.toBe(key);
    scene.a.spine![2].position[1] = .1; expect(saved.a.spine![2].position[1]).toBe(0);
    expect(saved.a.spine![2].radius).toBe(.7);
  });
  it('keeps preview volume close to the refined S-curve with a pinched waist', () => {
    const scene = study(); scene.a.spine![2].radius = .4; scene.a.spine![2].position[1] = .1;
    const preview = evaluateScene(wasm, scene, 'preview'), final = evaluateScene(wasm, scene);
    expect(preview.volume / final.volume).toBeGreaterThan(.96);
    expect(preview.volume / final.volume).toBeLessThan(1.04);
  });
  it('can enable points on a long, thin bent form without clipping the original centerline', () => {
    const scene = study(); scene.a = makeShape('rounded', [.4,.4,12]); scene.a.deform.bend = 120;
    scene.a.spine = curveFromShape(scene.a); scene.a.deform.bend = 0;
    expect(() => validateScene(scene)).not.toThrow();
    expect(evaluateScene(wasm, scene, 'preview').volume).toBeGreaterThan(0);
  });
});
