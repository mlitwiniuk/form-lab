# Form Lab

A self-hosted drawing practice tool for understanding three-dimensional forms.

**Current state:** interactive form studies with shareable URL snapshots, five shape families, editable S-curve centerlines and thickness, deformations, solid operations, and visible/hidden cross-contours. The integrated `/sketchfab/` viewer adds model references, camera links and image export. An optional Rust/Axum server provides SQLite-backed accounts and a saved model library across devices. “Form Lab” is a working name.

## Test locally with accounts and the Sketchfab library

Requires Node.js 22.12+ with npm and Rust/Cargo (verified with Rust 1.96). Docker is not needed. From this checkout:

```sh
cd /Users/mlitwiniuk/Sites/rust/form-lab
npm run setup
npm run build
export FORM_LAB_SIGNUP_KEY="$(openssl rand -hex 32)"
printf 'Local account creation key: %s\n' "$FORM_LAB_SIGNUP_KEY"
cargo run --locked --manifest-path server/Cargo.toml
```

Leave that terminal running. Open [Form Lab](http://127.0.0.1:3000/) or [the Sketchfab viewer](http://127.0.0.1:3000/sketchfab/). The server binds to loopback and serves both the built frontend and `/api` from port 3000. Internet access is required for Sketchfab. First-time Cargo builds download dependencies.

In your browser:

1. Open **My model library & account**. Enter a username, a password of at least 12 characters, and the account creation key printed in the terminal; click **Create account**. Registration also signs you in.
2. Paste an embeddable Sketchfab model link or ID and click **Load model**. Try the three projections, view presets, rotation arrows, step sizes and zoom. Near-orthographic is a narrow perspective approximation; perfectly parallel lines are not guaranteed.
3. Enter a model name and click **Save current model**. Refresh and confirm it remains in the library. Edit the input without loading it and confirm saving/sharing still uses the loaded model.
4. Click **Copy link** and open it in another tab or private window. Confirm the model, framing and projection match; the public view link does not require your account. Try **Save image** and inspect the PNG.
5. Sign in with the same account in another browser profile; the same saved list should appear. Create another account and confirm its library is separate. Signing out affects the current session; other devices stay signed in.
6. Stop the server with Ctrl+C, restart with the same command and confirm the library remains. The database is `form-lab.sqlite3` in the checkout root, with SQLite WAL/SHM sidecars; these are ignored by Git. Do not delete them to restart the server.

To disable new accounts locally, stop the server, run `unset FORM_LAB_SIGNUP_KEY`, then restart it. Existing accounts still sign in without an account creation key. No password reset or account administration UI is implemented.

These are manual checks for you to perform; the integrated Sketchfab page has not been visually/browser-tested during this review. Testing on three physical machines requires hosting the same server at one reachable HTTPS origin. The loopback URLs above are accessible only on the development machine.

## Frontend development

For hot reload with accounts, use two terminals from the repository root. In the first, run the API server with Vite's browser origin:

```sh
FORM_LAB_ORIGIN=http://127.0.0.1:5173 cargo run --locked --manifest-path server/Cargo.toml
```

In the second:

```sh
npm run dev
```

Open [the Vite application](http://127.0.0.1:5173/) or [its Sketchfab page](http://127.0.0.1:5173/sketchfab/). Vite proxies `/api` to port 3000. Use `127.0.0.1` consistently; changing the browser to `localhost` changes the Origin and cookies. To create accounts in this mode, export a signup key in the API terminal before starting it, as above. Stop both processes with Ctrl+C.

For form studies or the viewer without accounts, `npm run dev` alone is sufficient. For a static production preview use `npm run build && npm run preview`, then open the URL Vite prints. Static hosting cannot provide the SQLite library. Always open through HTTP, rather than double-clicking `index.html`.

## Automated verification

```sh
npm test
npm run build
cargo test --locked --manifest-path server/Cargo.toml
cargo build --locked --manifest-path server/Cargo.toml
cargo clippy --locked --manifest-path server/Cargo.toml -- -D warnings
python3 server/tests/integration.py
```

The Python check needs Python 3, the debug binary built by `cargo build`, built frontend assets, and permission to bind a temporary loopback port. It launches/stops its own server and uses temporary databases; it does not use your local library. It checks accounts, separate-account libraries, multiple sessions, request-origin protection, session cookie flags and revocation/expiry, throttling, restart persistence, and online backup/restore. Camera tests mock Sketchfab's API and cannot prove live rendering or image downloads.

Verified on 2026-11-07: **254 frontend tests**, production build, Rust test/build/Clippy, backend HTTP integration, Compose configuration, Kamal 2.12 configuration using placeholder host values, and strict docs index validation. npm and RustSec lockfile audits report no known vulnerabilities. Build output retains non-fatal Manifold browser-externalization and bundle-size warnings. This account implementation has not had an independent security audit.

## Self-hosting

For your homelab, start with [Kamal setup, SQLite backups and recovery](docs/impl_sketchfab-viewer.md#kamal-on-a-homelab). [config/deploy.yml](config/deploy.yml) prepares one Linux host, GHCR, a persistent SQLite volume, HTTPS via kamal-proxy and a database health endpoint at `/up`. Supply your own host, domain, SSH user, image name and registry credential. Run `kamal config` with those parameters to validate locally before authorizing hosting. Review and commit changes in your own terminal before Kamal builds the Git revision.

[Docker Compose instructions](docs/impl_sketchfab-viewer.md#self-host-with-docker) are also available. Compose binds port 3000 to host loopback and requires your own HTTPS reverse proxy. Docker's daemon was unavailable during review: image build/run, volume ownership inside containers, TLS/ingress, Kamal deployment and off-host recovery still require target-host checks. Choose one deployment method; Compose and Kamal do not automatically share the same volume. Scheduled, encrypted off-host backups remain your responsibility.

The existing [Cloudflare static deployment](docs/impl_cloudflare-deployment.md) remains available for the frontend, but does not run the Rust API or provide synced accounts. The separate [public Sketchfab viewer](https://sketchfab-white-viewer.mlitwiniuk.chatgpt.site) is independent and was not modified or live-verified here. Models require Sketchfab availability and embedding permission; the saved library stores IDs and names, not geometry or textures.

All current changes remain uncommitted and undeployed. No push or deployment was performed during this review.

## Try the prototype

1. Start with **Rounded bean**, **Twisted box**, **Pinched form**, **Bent cone**, or **Ellipsoid**, or press **New rounded form** for a generated reference.
2. Open **Deform the volume**: twist, bend, taper, bulge/pinch, and morph between square and round cross-sections. Bend limits adjust to the shape's width and length.
3. Toggle **Cross-contours** and **Hidden lines**. Set **Cross-contour count** from 1 to 9; start with 3–5. The centerline follows the bend and hidden parts appear as dashes when revealed.
4. Choose **Combine forms** to edit forms A and B independently. Each can be a box, cylinder, sphere/ellipsoid, cone, or rounded form. Try **Cut**, **Join**, **Shared**, **Reverse cut**, or **Exclude** (remove the shared volume from both).
5. Use **Move**, **Rotate**, or **Size**, handles, numeric fields, and undo/redo. **Start drawing** locks the forms and camera while reveals remain available.
6. **Copy share link** copies the current forms, camera and reveal settings. Open the link or refresh to continue the study. The address updates as you edit.
7. **Save image** previews/downloads a PNG without editing handles.

The original four box/cylinder arrangements remain in the study menu. The rounded generator varies bounded dimensions and deformations; it is an initial reference generator, not the planned difficulty-aware exercise catalog.

For control points, choose **S-curve**, or select any rounded form and press **Enable control points**. Select one of the five numbered points in the view or inspector, then drag its arrows or adjust **Point across / depth / along**. **Point thickness** pinches or widens that region (20–180%). End stations stay fixed along the length; **Length** stretches the entire form. Use **Whole form** for object transforms, **Straighten centerline** to keep thickness but remove the curve, or **Return to arc bend** to remove the point chain. All shape edits support undo. Drawing lock and PNG export hide the point editor.

Drag empty space to orbit, scroll to zoom, and right-drag to pan. Keyboard shortcuts: `W` move, `E` rotate, `R` size, `H` hidden lines, Space drawing lock, and Cmd/Ctrl+Z undo (Shift for redo). Escape closes overlays or cancels an active transform. Camera presets and return-to-drawing-view are above the canvas. Form studies support true orthographic and perspective projection, with free, Turn-only and Tilt-only orbit modes. The Sketchfab page uses its separate perspective camera API.

## Implementation and limits

The prototype uses React/TypeScript, Three.js, and Manifold WASM in dedicated preview and refinement workers. An optional Rust service now supports accounts and saved Sketchfab model references; form-study persistence, the full exercise system, and native drawing remain planned. The URL stores the current study as a compressed, versioned snapshot. It works on static hosting without a database. Undo history and editing-tool selection stay in the current visit. Saved Sketchfab models use an account-backed library; form-study libraries and short links remain future work.

Edits show a lighter live preview immediately, then refine to full detail after a 220 ms pause. Each worker keeps only the newest pending edit. Full-detail deformed solids use 128 perimeter samples and 48 longitudinal intervals; previews use 32 and 24. Guides share the displayed solid's parameterization and sampled rings. Feature lines omit triangle wireframes; hidden lines are depth-tested. In combined studies, construction guides describe original operands, including removed regions. Image export waits for the current full-detail result.

The current test results and limits are recorded above. The implementation notes below describe individual milestones and may contain historical test counts or earlier architecture boundaries.

- [Share links and URL format](docs/impl_share-links.md)
- [Control points and local thickness](docs/impl_curve-editor.md)
- [Live rendering and performance verification](docs/impl_live-rendering.md)
- [Current form studies and verification](docs/impl_form-studies.md)
- [Original prototype implementation](docs/impl_geometry-prototype.md)
- [Requirements](docs/prd_form-lab.md)
- [Architecture](docs/spec_form-lab-architecture.md)
- [Implementation plan](docs/plan_form-lab.md)
- [Documentation index](docs/README.md)
- [Hidden-line screenshot](artifacts/hidden-lines.jpg)
- [Exported reference image](artifacts/reference.png)
