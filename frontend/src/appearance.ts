import { getShape, shapeEntries, type DisplayMode, type FormAppearance, type SceneState, type ShapeId } from './scene';

/** Before customization, cutters are outlines and the retained operands are solid. */
function defaultAppearance(scene: SceneState, id: ShapeId): FormAppearance {
  if (scene.operation === 'subtract') return id === 'a' ? 'solid' : 'wireframe';
  if (scene.operation === 'reverse') return id === 'a' ? 'wireframe' : 'solid';
  return 'solid';
}
export function formAppearance(scene: SceneState, id: ShapeId, display: DisplayMode): FormAppearance {
  if (display === 'wireframe') return 'wireframe';
  if (display === 'solid') return defaultAppearance(scene, id);
  return getShape(scene, id).appearance ?? defaultAppearance(scene, id);
}
/** Capture the currently visible styles when moving from a whole-study view to individual forms. */
export function setFormAppearance(scene: SceneState, id: ShapeId, appearance: FormAppearance, display: DisplayMode) {
  if (display !== 'forms') for (const [key, shape] of shapeEntries(scene, true)) shape.appearance = formAppearance(scene, key, display);
  getShape(scene, id).appearance = appearance;
}
export function referenceAppearance(scene: SceneState, display: DisplayMode) {
  const entries = shapeEntries(scene);
  const solidForms = display === 'forms' ? entries.filter(([id]) => formAppearance(scene, id, display) === 'solid').map(([id]) => id) : [];
  const wireForms = display === 'solid' ? [] : entries.filter(([id]) => formAppearance(scene, id, display) === 'wireframe').map(([id]) => id);
  return { result: display === 'solid', solidForms, wireForms, allWireframe: wireForms.length === entries.length };
}
