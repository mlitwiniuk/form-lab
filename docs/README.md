# Documentation index

Status: local form studies implemented, including shareable URL snapshots, editable S-curves, local thickness, live previews, deformations, rounded references and cross-contours; both tools share account dialogs and a SQLite-backed saved-settings library; the broader application remains planned.

Types: `prd` = product requirements; `spec` = technical design; `plan` = implementation sequence; `impl` = implemented behavior and verification.

## Fast Paths

- Save, reopen or overwrite references: [Accounts and saved references](impl_saved-references.md)

- Run the Sketchfab viewer and synced library: [Sketchfab viewer](impl_sketchfab-viewer.md)

- Deploy to your Cloudflare account: [Cloudflare deployment](impl_cloudflare-deployment.md)

- Share and reopen a study: [Share links](impl_share-links.md)

- Run or assess the current prototype: [Form studies and verification](impl_form-studies.md)
- Edit rounded centerlines and thickness: [Control-point editor](impl_curve-editor.md)
- Understand editing performance: [Live rendering](impl_live-rendering.md)
- Understand the product: [Requirements](prd_form-lab.md)
- Choose the implementation approach: [Architecture](spec_form-lab-architecture.md)
- Start implementation: [Delivery plan](plan_form-lab.md)

## Product

- `prd` [Form Lab requirements](prd_form-lab.md): User goals, reference analysis, exercise design, scope, and measurable usability requirements.

## Engineering

- `impl` [Accounts and saved references](impl_saved-references.md): Shared account flow and styling, saved study/model settings, revision-protected overwrites, migrations and local acceptance checks.

- `impl` [Sketchfab viewer](impl_sketchfab-viewer.md): Perspective controls, share links, account-backed model references, Kamal/Compose hosting, backup recovery and verification.

- `impl` [Cloudflare deployment](impl_cloudflare-deployment.md): Validated static-assets configuration for form-lab.app, terminal deployment, custom domain setup, verification and status.

- `impl` [Share links](impl_share-links.md): Versioned compressed URL snapshots, restored forms and camera, clipboard fallback, validation, synchronization and verification.

- `impl` [Control-point editor](impl_curve-editor.md): Five editable 3D curve points, local thickness, transported section frames, S-curve study, bounds and verification.
- `impl` [Live rendering](impl_live-rendering.md): Immediate previews, background refinement, bounded worker queues, cached drawing lines, measured latency and verification.
- `impl` [Form studies expansion](impl_form-studies.md): Five shape families, bounded deformations, rounded generator, cross-contour geometry, combined operations, checks and limits.

- `impl` [Geometry prototype](impl_geometry-prototype.md): Implemented box/cylinder operations, interaction controls, line rendering, checks and known limits.
- `spec` [Form Lab architecture](spec_form-lab-architecture.md): Rust/Loco backend, browser geometry and rendering, scene format, storage, self-hosting, and native evolution.
- `plan` [Form Lab implementation plan](plan_form-lab.md): Ordered milestones, technical investigations, acceptance gates, verification, and deferred work.
