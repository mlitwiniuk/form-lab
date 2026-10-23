# Form Lab

A self-hosted drawing practice tool for understanding three-dimensional forms.

**Current milestone:** interactive form studies with shareable URL snapshots, five shape families, editable S-curve centerlines and local thickness, twist/bend/morph controls, rounded-reference generation, solid operations, and visible/hidden cross-contours. “Form Lab” is a working name.

## Run locally

Requires Node.js 22.12 or newer and npm. Dependencies are already installed in this checkout.

```sh
cd ~/Sites/rust/form-lab
npm run dev
```

Open [the local prototype](http://127.0.0.1:5173/). The server binds to loopback. Stop it with Ctrl+C.

On a fresh checkout, run `npm run setup` first. Exact dependency versions are recorded in `frontend/package-lock.json`.

```sh
npm test
npm run build
npm run preview
```

`npm run preview` serves the built application at the local URL printed by Vite. Alternatively, serve `frontend/dist/` with any static HTTP server, for example:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory frontend/dist
```

The production build includes JavaScript, the geometry worker, and its WASM binary. It does not load assets from a CDN or require an external API. Open it through HTTP, not by double-clicking `index.html`.

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

Drag empty space to orbit, scroll to zoom, and right-drag to pan. Keyboard shortcuts: `W` move, `E` rotate, `R` size, `H` hidden lines, Space drawing lock, and Cmd/Ctrl+Z undo (Shift for redo). Escape closes overlays or cancels an active transform. Camera presets and return-to-drawing-view are above the canvas.

## Implementation and limits

The prototype uses React/TypeScript, Three.js, and Manifold WASM in dedicated preview and refinement workers. There is **no Rust server yet**. Rust/Loco persistence, the full exercise system, and native drawing remain planned. The URL stores the current study as a compressed, versioned snapshot. It works on static hosting without a database. Undo history and editing-tool selection stay in the current visit. Named libraries and short links remain future work.

Edits show a lighter live preview immediately, then refine to full detail after a 220 ms pause. Each worker keeps only the newest pending edit. Full-detail deformed solids use 128 perimeter samples and 48 longitudinal intervals; previews use 32 and 24. Guides share the displayed solid's parameterization and sampled rings. Feature lines omit triangle wireframes; hidden lines are depth-tested. In combined studies, construction guides describe original operands, including removed regions. Image export waits for the current full-detail result.

The test suite passes 118 checks, including known volumes, boolean operations on deformed operands, S-curve frames and thickness, guide alignment, generated references, preview quality, rapid-edit scheduling, stale responses, worker cleanup, lossless share-link round trips, bounded decoding and URL synchronization. Browser measurements and remaining limits are recorded in the implementation notes.

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
