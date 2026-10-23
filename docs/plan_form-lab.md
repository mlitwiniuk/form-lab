# Form Lab implementation plan

Date: 23 October 2026. Status: the original prototype and the requested [form studies expansion](impl_form-studies.md) are implemented locally. The expansion brings bounded deformations, five shape families and initial rounded generation forward from phases 3–4. The [share-link milestone](impl_share-links.md) also persists the current study and view in a portable URL without a backend. Cloudflare deployment is deferred. Phase 2 Rust persistence, the remaining validation gates and the full exercise catalog remain planned.

The first release is complete only when guided practice, the shape editor, the generator, save/load and a verified self-hosted deployment work together. An isolated 3D demo is a milestone, not the requested product.

## Milestones and dependencies

| Phase | Deliverable | Exit gate | Indicative effort |
| --- | --- | --- | --- |
| 0 | Confirm defaults and define fixtures | Target browser/hardware and a small representative scene set are recorded | 0.5–1 day |
| 1 | Geometry and drawing-renderer prototype | Clean readable contours and reliable basic cuts; engine choice recorded | 3–6 days |
| 2 | Loco foundation plus one usable practice exercise | Generate/open one box-cut reference, manipulate, lock, reveal, save and reload | 3–5 days |
| 3 | Shape editor and supported form families | Primitive editing, bounded deformations, reversible operations and undo work | 5–8 days |
| 4 | Guided exercise catalog and generator | Three families, difficulty constraints, reproducibility and useful fallbacks | 4–7 days |
| 5 | Personal library, deployment and real practice validation | Packaged release passes restore and paper-drawing usability checks | 3–5 days |

Rough total: **19–32 focused developer-days before learning/uncertainty allowance**. These are planning estimates, not commitments. Add time for learning Rust and graphics work; calendar duration depends on availability. Re-estimate after phase 1 because contour extraction and boolean edge cases dominate uncertainty.

Phase 1 gates the final geometry choice. Phase 2 establishes the complete workflow before broadening features. Phase 5 finishes production behavior; persistence and local deployment begin earlier, not at the end.

## Phase 0 — establish a testable target

Use the current assumptions: one owner, English interface, desktop/trackpad editing, tablet reference viewing, paper drawing first. Record an actual reference laptop and tablet/browser before performance sign-off. Confirm the intended host before producing the release deployment configuration.

Create original reference fixtures based on the learning goals, not copied class artwork: two offset boxes; cylinder through a box; corner subtraction; sphere/cylinder; a tapered cylinder; a bent tube; and a bent rectangular sweep. Each fixture stores a stable camera and the expected visible/hidden relationships.

At implementation start, pin compatible Rust/Loco and frontend dependencies. Preserve these planning files when generating the Loco application; if the generator requires an empty directory, scaffold in a sibling temporary directory and merge the application files deliberately.

## Phase 1 — retire the largest technical risks

Build a disposable browser prototype with Three.js and a geometry worker. Compare Manifold first, then the alternative only if needed. Prove union, A−B, B−A and intersection for the initial supported pairs. Exercise containment, disjoint solids, coplanar faces, near-tangent curved surfaces and extreme but allowed dimensions.

Independently demonstrate clean silhouettes, hard edges, sparse cross-contours and hidden-line styles. Render box/cylinder intersection curves from several views. Verify curved centerlines and cross-sections stay coherent through bends. Measure line stability and export appearance, not merely whether a mesh renders.

Proposed budgets, to measure rather than assume: aim for 60 fps camera/handle interaction on the agreed laptop and at least 30 fps on the target tablet for representative scenes; target common two-primitive final boolean updates within 500 ms. Expensive updates remain off the UI thread and visibly report progress. Record mesh density and hardware with results.

Exit evidence: fixture screenshots, timings, a memory/disposal check after repeated operations, supported shape pairs and known exclusions. If the renderer or seam extraction fails, narrow the supported geometry and rerun this gate. Retain genuine addition/subtraction in the release scope.

## Phase 2 — build one complete practice loop

Create the Loco project at `/Users/mlitwiniuk/Sites/rust/form-lab`, with SQLite and the frontend inside the repository. Add Rust scene DTOs and validation, a migration, basic save/read endpoints, and request tests. Introduce the same-origin production asset path early.

Implement one exercise: predict and draw a cylinder cutting a box. The user can adjust the two primitives, choose the operation, lock the view, reveal source shapes and intersection lines, perform a self-check and save the exact reference. Add a constrained “another variation” action now, before building a general generator.

Exit gate: restart the service, reload the scene, and recover identical parameters and camera. Complete an actual paper-drawing session. Check whether the interface supports drawing without frequent configuration interruptions. This phase should already be personally useful.

## Phase 3 — editor and form manipulation

Implement R3–R8 from the PRD: all five primitives, selection, on-object manipulation, snapping, dimensions, duplicate/hide/isolate, ordered boolean operations, operand visibility, view presets, camera lock and reset. Add bounded bent/tapered circular and rectangular forms and a small number of pinch/bulge controls.

Introduce a command-based undo stack. Group pointer drags into one command. Undo must restore source parameters, operation order and selection coherently. Save state on meaningful edits; show failed saves and recover local drafts. Worker results carry revisions so rapid edits and undo cannot restore stale geometry.

Exit gate: a new user creates a cylindrical box cut within two minutes using visible controls; repeats the edit with numeric controls; undoes it; restores the drawing view; and returns to Practice without losing the scene. Test mouse and trackpad. Touch reference controls work before advanced touch editing is accepted.

## Phase 4 — lessons and constrained generation

Ship roughly 12 original templates distributed across the three exercise families. Templates define prompts, reveal stages, constraints and self-checks. Include untimed practice, optional timing and a simple observe/hide/recall variation.

Build seeded generation with difficulty parameters and lockable dimensions/camera. Validate both 3D geometry and the projected view. Use a bounded candidate search and curated fallback. Save resolved snapshots and generator versions so history stays stable after updates.

Exit gate: a deterministic corpus of at least 100 seeds per family passes structural validation; visually inspect a representative sample at each difficulty. Check for empty results, hidden seams, excessive occlusion, tiny features and accidental tangencies. Identical seed/settings/version produce equivalent scene parameters; loading a saved snapshot does not regenerate it.

A learner should be able to explain what a reveal shows. Avoid content that simply says “compare your drawing” without directing attention to a relevant feature. Improving drawing skill remains a product hypothesis to evaluate through use, not a claim established by geometry tests.

## Phase 5 — finish the self-hosted product

Complete scene naming/favorites, recent sessions, preferences, autosave conflict handling, JSON import/export and consistent PNG export. Add owner authentication for network deployment, disable public registration, and validate CSRF/session behavior if cookie authentication is used.

Build the release container with all frontend and WASM assets, a local data volume, readiness checks and explicit migrations. Verify no required external asset/API traffic. Document configuration, fresh installation, updates, consistent backup and restore. Test that restart preserves data and that a backup can restore on a clean installation.

Run at least five real paper-practice sessions across the exercise families. Use the PRD's time-to-exercise and editability gates. Review whether controls obscure the form, whether camera lock is dependable, and whether reveals explain the right geometry. Test current Safari and Chromium on the agreed devices; add Firefox or other targets to the release matrix if required.

Exit gate: all R1–R11 either pass or have an explicitly recorded, agreed scope change. Deliver a usable self-hosted release, its source, operating instructions, known limitations and the measured browser/device matrix.

## Verification strategy

| Layer | Meaningful checks |
| --- | --- |
| Geometry | Solid validity; simple known-volume cases; empty/disjoint/contained operations; deformation boundaries; transformations and operand order |
| Rendering | Fixed-camera fixtures for occlusion, curved silhouettes, seams and contour visibility; tolerate minor antialiasing differences across GPUs |
| State | Undo/redo, cancellation, stale worker results, camera bookmark restoration, scene migrations and exact snapshot persistence |
| Generator | Determinism, lock preservation, bounded retries, useful fallback, geometry validity and projected legibility |
| Backend | Scene validation, save/load, revisions/conflicts, auth boundaries, import limits, migrations and persistence after restart |
| End to end | Start → adjust → lock → draw/reveal → save → reload; JSON round trip; PNG matches view; install/backup/restore |

Tests should target invariants and visible behavior, not every slider's implementation. Manual artistic/usability review complements automated correctness checks.

## Risks and decision points

| Risk | Mitigation / decision |
| --- | --- |
| Mesh edges look like noisy wireframes | Treat drawing-line extraction as its own phase-1 deliverable; never equate mesh wireframe with cross-contours |
| Boolean output is valid but teaching seams are unclear | Validate operand provenance and seam extraction; constrain primitive pairs or implement dedicated intersections |
| Strong deformations create self-intersections | Bounded parametric forms; reject invalid edits; defer arbitrary sculpting and deformed boolean combinations |
| Random scenes are mathematically valid but unhelpful | Template constraints plus view checks, curated fallbacks and human sampling |
| UI becomes a small CAD program | Practice-first defaults, selected-object controls, limited scene size, clear language and paper-practice testing |
| Rust learning delays the drawing feature | Use the backend for CRUD/validation/deployment learning; keep the first geometry engine in its supported browser environment |
| Native ambitions complicate the initial release | Portable documents and isolated persistence now; native packaging and sync only when a concrete need is validated |

## Later releases

Next, expand form studies with more flexible section editing, branching and broader validation of boolean/deformation combinations. Twist and representative deformed combinations are already included in the local form studies expansion. Add printable exercise sheets and vector export if line extraction supports them.

Then add in-app drawing against a locked reference: pen strokes, pressure, undo, layers and reveal overlays. Validate input latency and gesture separation before introducing many brushes. Optional locally processed photo alignment can support paper comparison, with no automatic grading claim.

Evaluate a Tauri app after the drawing interaction and offline requirements are clearer. Decide whether it connects to the self-hosted service or uses local storage. Mobile/native stylus support and cross-device synchronization require their own acceptance plan.

## First implementation task

The first task has been implemented: manipulate both operands, switch operations, display clean silhouettes and the actual intersection boundary, reveal hidden portions, and reset to a drawing view. Manifold WASM is the current geometry engine. Use the prototype to evaluate guide clarity and manipulation; extend the geometry/device/performance investigation before considering the full phase-1 gate closed.
