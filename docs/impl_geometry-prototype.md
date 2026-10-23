# Box and cylinder geometry prototype

Historical baseline, implemented 23 October 2026. The subsequent [form studies expansion](impl_form-studies.md) supersedes the shape limits and current test counts below. This completes the specifically requested box/cylinder prototype. It does not complete every investigation in the broader phase-1 plan or the application MVP.

## Delivered behavior

- True box/cylinder difference, union, shared volume, and reverse difference using Manifold 3.5.4.
- Independent position/rotation controls for both shapes, box dimensions and circular cylinder radius/length.
- Direct manipulation handles, numeric fields, sliders, optional snapping, undo/redo and reset.
- Original source shapes retained after operations; the cylinder can remain visible as a construction guide.
- Clean hard edges and operand-intersection boundaries, plus view-dependent cylinder silhouettes. Internal mesh triangulation is omitted.
- Depth-tested hidden edges, displayed as muted dashes. Intersection highlighting is independently switchable.
- Sparse cylinder sections and an axis; optional original box construction lines.
- Observe/Construct/Reveal presets, four curated arrangements, drawing lock, camera presets and focus mode.
- PNG preview/export at twice the canvas CSS resolution, with editing handles removed.
- Production assets bundled locally, including the geometry worker and WASM.

## Main implementation files

| File | Responsibility |
| --- | --- |
| `frontend/src/scene.ts` | Typed scene parameters, input bounds, transformation convention and preset fixtures |
| `frontend/src/geometry.ts` | Actual Manifold operations; source IDs, mesh/volume extraction and explicit WASM object disposal |
| `frontend/src/geometry.worker.ts` | Browser worker initialization and geometry computation |
| `frontend/src/edges.ts` | Welded edge adjacency, operand-provenance seams, hard edges and view-dependent silhouettes |
| `frontend/src/viewport.ts` | Camera/transform controls, smooth cylinder normals, line-depth passes and image export |
| `frontend/src/App.tsx` | Practice UI, edit history, drawing lock, worker revision handling and recovery |
| `frontend/tests/geometry.test.ts` | Geometry invariants and representative edge cases |

The cylinder's native axis is Z. Transform matrices use Three.js XYZ Euler rotations, with degrees in the document and radians at the rendering boundary. The same matrices go to Manifold, avoiding differences between displayed handles and calculated solids.

Intersection boundaries come from adjacent output triangles with different original solid IDs. Curved shading uses analytic cylinder-wall normals; box faces retain flat normals. Silhouettes are recomputed when the camera moves. Visible and hidden line passes use opposite depth tests against the final solid, with a small surface-depth offset.

Construction guides describe the original operands. They are intentionally not clipped away when part of an original shape has been subtracted. The cutter itself is a wire construction guide, not an additional opaque solid occluding the result.

Each gesture commits one undo step. Numeric fields support intermediate editing text and clamp on commit. Geometry requests are debounced and revision-tagged; older responses are ignored. A timed-out worker is terminated, and the UI offers retry/reset while preserving shape parameters. Disposal covers intermediate Manifold objects, replaced line/mesh geometry, and renderer teardown.

## Verification performed

`npm test`: **16 passing tests**. Coverage includes:

- Expected volumes for all four operations, compared with the exact regular 128-gon cylinder area.
- Two expected circular boundary loops for a centered through-hole; boundary vertices lie at the correct radius and box faces.
- Closed topology (two adjacent faces per welded edge) for the operation fixtures.
- Disjoint cylinder, exact tangency, complete removal and enclosed cavity.
- Equivalent results when both operands receive the same rotation and translation.
- All four supplied arrangements and 100 successive transformed cuts.
- Rejection of invalid/nonfinite dimensions.

`npm run build`: passes TypeScript checking and production bundling. Vite reports a large main chunk and externalizes Manifold's Node-only `node:module` branch. The actual browser WASM path was verified in the production build; no browser error/warning was observed during that check. Bundle splitting remains an optimization opportunity.

Manual browser checks in the Codex in-app browser on the development Mac:

- Loaded both development and production builds successfully.
- Served production from a plain Python static server; root responded HTTP 200, and the worker/WASM loaded.
- Rotated the cylinder through a numeric field, observed the cut update, and undid the change.
- Dragged the X handle and observed the cylinder position and result change together; undo restored the prior parameters.
- Verified negative numeric input.
- Switched to union and the open-channel arrangement; inspected the actual solid result.
- Enabled construction and hidden-line reveals; inspected dashed far-side curves and edges.
- Locked the drawing view, attempted camera drag and undo shortcut, and confirmed editing remained disabled and parameters unchanged.
- Generated and visually inspected a PNG preview without handles; extracted the displayed PNG as an artifact. The in-app browser's OS download destination was not established, so filesystem delivery through its Download PNG link is not claimed as verified.
- Fixed the initial clipping in tall/narrow viewports by preserving field of view on the smaller canvas dimension.

Observed solid-computation durations were approximately **4–17 ms** in these browser interactions. This excludes worker startup, rendering, and the 60 ms edit debounce; it is not an end-to-end latency or frame-rate benchmark.

Evidence: [hidden-line view](../artifacts/hidden-lines.jpg), [exported reference](../artifacts/reference.png). The reference PNG is generated by the production renderer, not an illustrative mockup.

## Remaining validation and known boundaries

- Browser validation was in the in-app browser. Standalone Safari, Chromium, Firefox, tablets and stylus behavior are not yet signed off.
- No long-duration memory benchmark or GPU frame-time benchmark has been completed. Explicit disposal and a repeated-operation test are useful evidence, not proof of a flat memory profile.
- The 128-sided cylinder approximates a smooth surface. Silhouettes and intersection curves have finite sampling resolution; near-tangent numerical cases beyond the tested fixtures can still need attention.
- Guides use depth-buffer visibility and can exhibit minor antialiasing/depth-bias differences on other GPUs.
- No deformed solids, arbitrary imported meshes, persistent scene storage or automatic generator is included in this milestone.
- Focus mode changes the viewport layout. Camera framing is responsive; cross-device identical-aspect drawing-frame persistence is part of the later saved-scene work.

Next useful step: practice with these arrangements and refine guide clarity and manipulation before expanding to bent/tapered forms or starting the Loco persistence phase.
