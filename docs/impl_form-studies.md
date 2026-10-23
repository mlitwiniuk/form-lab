# Form studies expansion

Implemented locally on 23 October 2026, extending the [original geometry prototype](impl_geometry-prototype.md).

Subsequent improvements add [live rendering](impl_live-rendering.md) and the [rounded control-point editor](impl_curve-editor.md). The current suite has 68 tests; verification below describes the original expansion.

## Delivered behavior

- Five interchangeable shape families: box, cylinder, sphere/ellipsoid, cone, rounded form.
- Single-form study or two independently editable operands. All families accept dimensions, transforms and deformations.
- Twist (up to ±180°), circular-arc bend, taper, bulge/pinch, and continuous square-to-round cross-section morphing. These are bounded parametric controls, not arbitrary sculpting or morphing between imported meshes.
- Bend limits depend on dimensions, taper and bulge. Resizing or widening a shape clamps its bend when needed to keep a positive inside sweep radius. The UI exposes the current allowed range.
- New presets: twisted box, rounded bean, pinched form, bent cone and ellipsoid. Original box/cylinder presets are preserved.
- **New rounded form** generates a bounded variation in proportions, orientation, bend, twist, taper and pinch/bulge. Generated parameters enter the undo history. Reset restores the latest generated baseline for a custom study.
- Cross-contour count of 1–9, with optional hidden dashed portions and the bent centerline. Observe hides construction; Construct reveals sections; Reveal adds hidden lines.
- Cut A−B, Join, Shared, Reverse cut B−A, and Exclude (symmetric difference). Sources remain independently editable, including after deformation.
- Existing undo/redo, handles, camera presets, drawing lock and PNG preview/export remain available.
- Presets and generation live in the inspector so they remain accessible when the lesson panel is hidden on smaller screens.

## Geometry and rendering

`frontend/src/scene.ts` uses generic A/B operands. `forms.ts` is the shared parameterization for both the closed input mesh and construction guides. `geometry.ts` constructs valid Manifold solids before applying booleans; output normals are calculated with a crease threshold. `viewport.ts` uses the actual deformed source meshes for selection and handles.

The local longitudinal axis is Z. Deformation order is profile and square/round morph → taper/bulge → twist → arc bend → rigid transform. Cross-sections remain perpendicular to the arc centerline. Round profiles close with single pole vertices; cones have one tip and one planar cap. Ellipsoids use an ellipsoidal profile; rounded forms use a softer longitudinal profile with additional pinch/bulge control.

Full-detail deformed surfaces use 128 perimeter samples and 48 longitudinal intervals; live previews use 32 and 24. Closed rounded tips receive denser axial sampling. Guide sections snap to the displayed quality's existing loft rings, avoiding unrelated ellipses floating above or sinking below the sampled solid. The original undeformed box and cylinder retain efficient kernel primitive paths.

Guide depth is tested against the final result. In a combined study, guides represent original operands and can extend through removed regions; they are not new edges of the boolean result. Hidden reveals show the occluded parts as muted dashes. No triangle wireframe is displayed.

Edge adjacency welds exact equal positions from the kernel, rather than rounding coordinates: rounding can collapse short edges in deformed cuts. Exclude can produce separate closed components touching at the same geometric edge, which presents four incident faces after position welding; the kernel's solid remains valid.

## Verification

`npm test`: **36 passing tests**. Includes the original boolean volume and topology cases, plus:

- Closed, nonempty preset solids with finite unit normals.
- Ellipsoid volume within 0.3% of the analytic value and cone volume against its polygonal approximation.
- Opposite twist at opposite ends; bent section directions perpendicular to the centerline.
- Every cross-contour vertex coinciding with a sampled loft vertex.
- Square-to-round volume progression.
- A twisted solid cut by a sphere, preserving the operand-intersection boundary.
- Every shape family, with combined deformations, tested against an angled cone under all five boolean operations.
- Repeatable generated parameters with an injected random source and 20 generated solid/topology checks.
- Bend clamping after size changes and invalid deformation rejection.

Browser checks in the Codex in-app browser on the development Mac: twisted-box visible/hidden lines, generated rounded forms, numeric twist editing and undo, a sphere cutting a twisted box, five-section pinched-form guides, drawing lock, and clean PNG preview. These are interaction and visual checks, not an automated screenshot regression suite.

Production verification: `npm run build` passes TypeScript checking and bundling in the requested project directory. The resulting `frontend/dist/` was served with a plain local static HTTP server; the worker and WASM loaded and the rounded study rendered without browser warnings/errors. Vite still reports the existing large-chunk warning and externalizes Manifold's unused Node-only import.

Visual evidence: [rounded form with hidden cross-contours](../artifacts/rounded-study.png).

## Boundaries

- This remains a browser-only prototype. Rust/Loco, database persistence and saved seeds are not implemented. The later [share-link milestone](impl_share-links.md) restores the current study from its URL, including the actual generated parameters.
- The initial generator is bounded and reproducible with an injected random source in tests; the UI does not yet expose seeds or save exact references. It does not yet score projected legibility, support difficulty levels, or generate branching forms.
- Shape morphing is a parameterized square/round section and width profile. Rounded forms now support [S-curve centerlines and local thickness](impl_curve-editor.md). Arbitrary mesh sculpting and branching forms remain future work.
- Boolean curves and silhouettes are tessellated approximations. Extreme near-tangencies outside tested fixtures still warrant checking.
- Camera/handle interaction frame rates, long-running GPU/WASM memory behavior, Safari/Firefox/tablet/stylus compatibility remain unverified.
- PNG preview is verified; the in-app browser's operating-system download destination is not claimed as verified.

The build remains static and self-hostable; there are no new dependencies or runtime external services.
