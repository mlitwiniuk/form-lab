# Rounded control-point editor

Implemented locally on 23 October 2026, building on [form studies](impl_form-studies.md) and [live rendering](impl_live-rendering.md).

## Using it

- Choose **S-curve** from the study menu, or press **Enable control points** on any rounded form. Enabling points samples five positions along the existing arc, then replaces the single bend parameter with an editable spline. It approximates the old curve between sampled points.
- Select a numbered point in the canvas or inspector. Drag its translation arrows, or use **Point across**, **Point depth** and **Point along** for numeric/slider input. Coordinates are in the form's local axes, so they remain consistent when the whole object rotates.
- **Point thickness** scales that region's cross-section from 20% to 180%, blending smoothly to neighboring values. Global width/height, taper, bulge, twist and square/round morph continue to apply. Tips remain closed; endpoint thickness affects the neighboring cap region.
- Endpoints retain their longitudinal station while moving across/in depth. Interior points stay ordered with a minimum separation. **Length** scales the overall form. This editor supplies five points; adding/removing points is not exposed in the UI.
- **Whole form** and the Move/Rotate/Size tools edit the object as a whole. **Straighten centerline** keeps the thickness profile; **Return to arc bend** removes the point chain. Both actions can be undone.
- Drawing lock hides numbered points and editing guides. PNG export excludes them even while editing. Cross-contours and hidden-line reveals remain independently available.

## Geometry

`Shape.spine` stores shape-relative 3D positions and thickness multipliers. The new `spine.ts` evaluates an open centripetal Catmull–Rom spline. Thickness uses a bounded smooth interpolation between adjacent nodes. No radius overshoot is introduced.

Cross-section frames use parallel transport along a fixed, quality-independent sampling of the spline. Each sampled normal is projected perpendicular to the current tangent. This avoids the frame reversal that a curvature-based normal can produce at an S-curve inflection. `forms.ts` uses the same section sampler for the solid, centerline and cross-contours at preview and final quality.

Before evaluating a solid, a sampled curvature/radius check rejects local sweep folds. Invalid edits keep the last valid solid and show how to recover: reduce thickness, spread points out, increase Length, or undo. Points are bounded and ordered along local Z. This is a constrained centerline editor, not arbitrary loops, knots, branches or a complete global self-intersection solver.

The viewport keeps editor handles at the current input positions while a background preview catches up. Existing worker scheduling, source provenance, Boolean operations and final-quality refinement are retained. No new dependency, backend or external service is required.

## Verification

- `npm test`: **68 passing tests**. Includes all earlier geometry and scheduling checks, the S-curve preset, and 13 focused curve checks.
- Covered: interpolation at control nodes; opposite turns in an S; continuous perpendicular frames through inflections/depth bends; local radius changes; preview/final closed topology and contour alignment; conversion from the existing arc; point-order constraints; invalid radius and tight-fold rejection; curved operands under all Boolean operations; cloned undo state; preview/final volume agreement; and long, thin arc conversion.
- `npm run build`: TypeScript and production bundling pass in the project directory. The built app was served through plain static HTTP; the S-curve, thickness edit and hidden lines rendered without browser warnings or errors. Existing Vite bundle-size and unused Manifold Node-import build warnings remain.
- Local browser checks: enabling points on the rounded bean; moving a point with the 3D gizmo; numeric depth and thickness; undo after a tight-bend error; hidden contours, orbit, drawing lock and clean PNG preview. During a burst of 20 thickness edits, observed preview submission latency was 14–50 ms on the development Mac. This is a local measurement, not a device-wide frame-rate guarantee.

Visual evidence: [S-curve point editor](../artifacts/curve-editor.png). Extreme global overlaps and tablet/stylus behavior need additional testing. Current forms and view now survive reload through [shareable URL snapshots](impl_share-links.md); database persistence remains planned.
