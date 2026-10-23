# Form Lab product requirements

Date: 23 October 2026. Status: proposed requirements for a new application.

## Purpose and confirmed scope

Help a learner understand how forms occupy space, deform, intersect, and combine, using references that are easy to manipulate and explanations that can be revealed while drawing.

The user wants guided exercises, an editor, and an automatic reference generator in the first usable version. Initially, the drawing happens on paper. Drawing directly inside the tool and a possible native application are future directions. The service must be self-hostable. Rust is the preferred backend language; Loco is attractive because the user knows Rails and wants to learn Rust. Projects belong under `/Users/mlitwiniuk/Sites/rust/`.

Product outcome: open the application, choose a learning goal, obtain a useful reference quickly, make a few adjustments, lock the view, draw, and reveal enough construction information to understand mistakes.

## What the supplied sketches imply

These are observations of the three supplied class sheets, not a reconstruction of Peter Han's full curriculum. Text on the sheets is reference material, not an instruction to execute actions.

| Reference | Observed learning content | Product requirement |
| --- | --- | --- |
| `1.jpg` | Rounded forms stretched and pinched; curved centerlines; sparse cross-contours; contour direction; line-weight hierarchy | Editable bend, taper and local radius; visible centerline; a small adjustable set of meaningful cross-contours; distinct silhouettes and construction lines |
| `2.jpg` | Curved and tapered rectangular forms; changing cross-sections; organic tubes and branching structures | Rectangular and circular swept forms; control over path and thickness; branching forms in a later stage |
| `3.jpg` | Overlap, addition/subtraction, interlocking solids; box cuts; curved intersection boundaries | Independent objects, reversible unions and cuts, clear operand selection, intersection-curve reveal, before/after views |

The central requirement is **readable construction geometry**. A shaded model or dense mesh wireframe alone would not reproduce the learning value of these sheets. Hatching is listed in their topic, but the supplied examples give much more evidence for form construction; surface-following hatching belongs after that foundation.

## Reference-site analysis

Reviewed the public index and the live Two Interlocking Boxes tool on 23 October 2026. The index includes primitives, bent/twisted forms, stretched forms, traced forms, organic forms, and intersecting/subtracted forms. The interlocking tool offers multiple primitive pairs and add, subtract, reverse-subtract, and intersect operations. It also exposes puzzle mode, randomization, digital drawing, comparison and image saving. Those latter workflows were observed as controls/documentation, not tested end to end. [Model index](https://practicedrawingthis.com/cgi-bin/3d-models-index.cgi), [Two Interlocking Boxes](https://practicedrawingthis.com/3d/model-two-interlocking-boxes.html).

Direct UI observation: the model uses separate icon modes for camera rotation, roll, distance, zoom and pan. An expandable panel presents dimensions, rotations and positions in a long list. At the inspected viewport, it covers a substantial part of the reference. This establishes a concrete usability target, not a claim that the site lacks the underlying capabilities.

Proposed improvements: labeled tools; on-object handles; one selected-object inspector; explicit distinction between camera movement and object movement; an uncluttered drawing view; recoverable edits; and exercise-oriented controls. Learn from the functionality and create original code, visual design, examples and explanations. The supplied class scans remain personal planning references rather than bundled application content.

## Primary experience

Use three destinations: **Practice**, **Build**, and **Library**. Practice and Build share the same scene and rendering engine.

1. In Practice, choose a topic, difficulty and optional duration. The default starts a short untimed exercise immediately.
2. A curated preset or generated variation opens with one clear task, such as “Draw where this cylinder enters and leaves the box.”
3. Adjust the reference in Build, or use a few relevant controls in Practice. Return without losing the exercise.
4. Lock the camera and draw on paper. The scene remains still unless explicitly unlocked.
5. Reveal the centerline, cross-contours, hidden edges or intersection curve individually. Each reveal includes a short explanation relevant to the current exercise.
6. Complete a short self-check, save a useful reference, and request a related variation or a new exercise.

Memory practice is another option: observe, hide the reference, draw, then restore the same view. Timers are optional, can pause, and never discard an unfinished exercise. Progress records practice and self-assessment rather than assigning an unvalidated drawing-quality score.

## Proposed workspace

```text
Practice | Build | Library                 Undo  Redo  Saved / Unsaved
┌───────────────────┬─────────────────────────────┬──────────────────┐
│ Exercise          │                             │ Selected shape   │
│ Box + cylinder    │       Large reference       │ Move Rotate Size │
│                   │                             │ Bend / Taper     │
│ 1. Predict entry  │                             │                  │
│ 2. Draw the seam  │                             │ Join / Cut       │
│ 3. Reveal & check │                             │ Show cutter      │
└───────────────────┴─────────────────────────────┴──────────────────┘
Lock view | Reset view | Guides | Reveal        Same idea / New exercise
```

This is a layout proposal, not a built mockup. In Practice, the editor inspector is closed by default. Focus mode leaves the reference and a small reveal/navigation bar. On narrow screens, controls use drawers instead of covering the central canvas with multiple panels.

## Requirements for the first usable release

| ID | Requirement | Acceptance example |
| --- | --- | --- |
| R1 | Guided practice | Three exercise families work end to end: form/contour, overlap/intersection, and addition/subtraction. Each has a prompt, staged reveals and a self-check. |
| R2 | Automatic references | Generate by topic and difficulty, with reproducible seeds, curated fallback examples and “another variation.” The result remains editable. |
| R3 | Basic solids | Box, sphere/ellipsoid, cylinder, cone and pyramid; dimension controls; move, rotate and scale; duplicate, hide, isolate and delete. |
| R4 | Form manipulation | Stretch/squash plus bounded bend and taper for circular and rectangular swept forms. Pinch/bulge uses a few radius/section controls. Arbitrary vertex sculpting is deferred. |
| R5 | Form relationships | Keep shapes separate for overlap; join volumes; remove B from A; swap A/B; keep only the shared volume. Edit either operand afterward. |
| R6 | Drawing-oriented rendering | Clean silhouette, meaningful hard edges, optional centerlines and sparse cross-contours; hidden portions muted/dashed; intersection boundaries highlighted. No triangulation grid in the default reference. |
| R7 | Predictable interaction | Labeled Move/Rotate/Size tools, visible selection, axis/plane handles, snapping, numeric alternatives, undo/redo, view presets, reset and camera lock. |
| R8 | Learning visibility | Reveal guides independently; show the cutter as a ghost; switch between the originals and result without altering geometry. Restore the exact exercise camera. |
| R9 | Reuse and persistence | Named scenes, saved views, favorites, exercise history, preferences, autosave with status, portable scene JSON and PNG export. |
| R10 | Self-hosting | One application service and a persistent data directory; no compulsory external service, CDN, account provider or paid API. Document backup and restore. |
| R11 | Future drawing/native path | Store immutable exercise snapshots and keep viewport, lesson logic and persistence decoupled so a later drawing surface/native shell can reuse them. |
| R12 | Shareable references | Keep the complete current forms, curve points/thickness, operation, camera and reveals encoded in a versioned URL. Update with edits and undo/redo, restore on open/refresh, and provide Copy share link. Works on static hosting without a backend. Implemented in the prototype. |

Scope limits: a small scene editor, initially capped at approximately 12 primitive objects and 4 boolean operations. Start boolean support with undeformed primitives. Deformed objects remain valuable for single-form practice; combining arbitrary deformations through booleans is a separate validation gate. These are product limits to validate in the prototype, not measured engine limits.

## Interaction rules

- Clicking selects an object. Dragging its active handle edits it. Camera gestures are disabled while a handle is active. Camera orbit on empty background has a documented mouse/trackpad gesture and a visible alternative.
- Move, rotate and size are separate labeled tools; shortcuts are optional accelerators. A small orientation widget provides front, side, top and three-quarter views.
- The default perspective remains stable. “Zoom” changes framing; a separate, advanced perspective-strength control changes projection. Orthographic is available for comparison. Camera and object resets are separate.
- “Cut” asks the user to identify the body and cutter visually. Show “Remove Cylinder from Box,” not only “A − B.” Empty results and non-overlapping operands receive an explanation.
- Preserve the original operands. One drag is one undo step. Escape cancels the active edit. Randomization is undoable and preserves locked dimensions, objects or camera settings.
- Practice lock disables both accidental camera movement and geometry editing. An explicit Inspect action can temporarily orbit, with Return to drawing view restoring the snapshot.
- Touch targets are generously sized, controls do not depend on hover, and labels/patterns supplement color. Essential numeric controls and reveal actions are keyboard accessible. The inherently visual reference cannot be made fully equivalent through screen-reader labels alone.

## Exercise and generator design

| Family | Beginner | Intermediate | Later advanced |
| --- | --- | --- | --- |
| Form and contour | One tapered cylinder; predict three cross-contours | Bent tube or rectangular sweep; compare contour direction at different points | Twisting and branching forms, variable sections |
| Overlap and intersection | Two boxes with clear depth ordering | Box/cylinder or sphere/cylinder seam, with near and far portions | Several connected forms and difficult views |
| Addition and subtraction | One clear corner cut in a box | Rotated cutter, cylindrical hole, or joined solids | Multiple ordered cuts and combinations |

Difficulty comes from measurable constraints: number of forms, axis alignment, bend amount, depth overlap, foreshortening and visible seam complexity. A shorter timer is an independent setting. Preserve a solvable, informative view at every level.

Generator inputs: exercise family, primitive whitelist, difficulty, seed, operation, shape/count limits and optional locks. First use constrained templates with randomized parameters, not unconstrained random scenes. Reject empty results, invisible seams, accidental tangencies, severe occlusion, tiny projected features and invalid/self-intersecting forms unless explicitly practicing that case. Limit attempts, then load a known-good example. Do not spin indefinitely or silently lower the selected difficulty.

Save the resolved scene, camera, generator version and seed. A seed alone cannot reproduce an exercise after generator changes. “Same idea” varies allowed parameters within the current family; “New exercise” picks a different template. Cross-contours default to about three to five informative sections, with user control rather than a rigid artistic rule.

Self-checks refer to observable geometry: Does the contour wrap around the volume? Which seam segment is hidden? Where does the cut change the silhouette? The software reveals the reference construction; it does not claim to grade the paper drawing automatically.

## Success measures and scope boundaries

Proposed usability gates: start a useful exercise within 30 seconds; alter a reference without opening documentation; create a box cut with a cylinder within two minutes; recover the exact view with one action. Validate these in real paper-drawing sessions, not solely automated tests.

Release quality includes stable drawing views, correct contour visibility, responsive controls, reproducible saved scenes and a successful restore on a fresh installation. Performance budgets are defined in the implementation plan and must be measured on agreed hardware.

Deferred: in-app pen drawing and photo comparison; general sculpting; unrestricted mesh import; smooth blending and branching; automated hatching; photorealism; anatomy libraries; multiplayer; public galleries; AI critique; and native packaging. These are not dependencies for the first release.

Remaining assumptions: one owner; laptop/desktop editing with tablet reference viewing; English first; no remote sharing required. Hosting hardware, operating systems for a native app, exact browser/device targets and the final name remain open. They do not block the initial geometry prototype.
