# Live rendering

Implemented locally on 23 October 2026 after the [form studies expansion](impl_form-studies.md).

## Behavior

Shape edits start a lightweight geometry preview immediately, including while a slider or handle is moving. After 220 ms without a geometry change, a separate worker calculates the full-detail result. The status reads “Live preview · refining detail…” during refinement. PNG export remains disabled until the current final result is ready.

Each worker has at most one active computation and one replaceable pending scene. Intermediate previews can be shown while input continues, with construction lines matched to that preview's scene. Old detailed results cannot overwrite newer edits, and a late preview cannot replace an already displayed final result. A complex final calculation can finish in the background without blocking new previews.

Changing contour count, reveals or camera position does not recalculate solids. Construction lines, hidden-line reveals, source selection, undo/redo and drawing lock remain available.

## Implementation

- `geometry-pipeline.ts` owns the two workers, latest-pending queues, refinement timer, revision ordering, scene snapshots, errors and cleanup.
- `forms.ts` uses 32 perimeter samples / 24 axial intervals for previews and the existing 128 / 48 for final geometry. Construction guides use matching rings at both resolutions. Previews remain approximate; the detailed mesh is used for the settled drawing reference.
- `geometry.ts` skips the inactive operand in single-form mode. Shared volume is derived from the result and operand volumes, eliminating a separate intersection calculation used only for the status metric.
- `render-geometry.ts` welds/classifies feature edges in the workers. Packed edge buffers transfer to the viewport; single-form result/source edges share the same transferred buffer.
- `viewport.ts` caches construction guides, scans packed edge data for view-dependent silhouettes and reuses dynamic GPU line buffers. Visible and hidden lines share geometry. Mesh/guide snapshots stay aligned while editing handles follow the current input.
- Two independent WASM instances use more memory than the previous single worker. They are disposed on teardown or retry. Each active job has a 12-second watchdog. No new package or external service is required.

## Measurements

Local development Mac, Codex in-app browser. These are sampled interaction measurements, not cross-device guarantees or a sustained frame-rate benchmark.

The previous path delayed every edit by 60 ms and restarted that delay while input continued. Once queued, old worker jobs still had to run even when their results were discarded. A diagnostic Node/WASM run measured roughly 0.7–1.1 seconds of geometry work for deformed cuts, plus 40–80 ms of edge preparation on the UI thread.

The updated browser was exercised using repeated slider keyboard input without pauses:

| Study | Observed live update latency | Settled full detail |
| --- | --- | --- |
| Twisted box minus cylinder, 40 successive twist edits | 29–69 ms; 28 preview frames during/just after the burst | 528 ms after the last edit, including the refinement delay |
| Rounded bean, 30 successive bend edits | 14–31 ms during the burst | Approximately 0.3 seconds including the refinement delay |

The canvas exposes a small local diagnostic history in `data-latency-samples`, plus quality, render count and rendered twist. Timing runs from scheduling a scene to submission of its WebGL frame; it includes worker queues, computation, transfer and viewport preparation, but does not measure physical display scanout. It sends no data externally.

A separate updated Node/WASM diagnostic measured 18–24 ms for preview solid operations on the tested cuts, with 5–19 ms of worker-side edge preparation. Full-detail work still varies with the topology and can take longer than a preview. Those diagnostic timings are not directly interchangeable with browser timings.

## Verification

- `npm test`: **54 passing tests**. The existing 36 geometry checks remain, plus 9 scheduling checks and 9 preview/edge checks.
- Scheduling covers 100 rapid edits, latest-pending replacement, continuous preview delivery, stale final rejection, final-over-preview ordering, contour-only changes, errors, timeout and worker disposal.
- Geometry checks compare preview/final volumes, closed preview topology, all nine contour rings, packed silhouettes/seams, and transformed shared vertices.
- Browser checks cover continuous twisted-cut and rounded-bend editing, final refinement, hidden-line display, PNG preview, undo and contour-count changes.
- `npm run build` passes in the requested project directory. The built assets were served through a plain static HTTP server: both workers loaded, continuous twist editing produced previews, full detail settled, and hidden lines/drawing lock worked without browser warnings or errors. Production assets include the shared worker code and WASM binary.

See [the final browser view](../artifacts/live-rendering.png). Low-end/mobile devices, long-running memory usage and Safari/Firefox are not covered by these local measurements.
