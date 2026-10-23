# Share links

Date: 23 October 2026. Status: implemented locally; Cloudflare deployment remains deferred.

## Behavior

The address contains `#s=<compressed-snapshot>`. It updates as forms or the view change. Copy share link captures the latest input parameters even while the preview/refinement workers are busy. Opening a link or refreshing restores the reference before requesting its geometry. No account, database, Rust service or external API is required.

The snapshot contains both operands (including inactive B in a single-form study), shape kinds, dimensions, positions, rotations, deformations, curve points and local radii, operation, contour count, camera position and target, all four reveal toggles, drawing lock and focus mode. Generated studies store actual parameters, preserving their random result. Links are immutable snapshots: editing one produces a new URL; previously copied links retain the earlier study.

Undo history, the selected object/tool, selected curve point, editing handles, open dialogs and cached meshes are not saved. The camera keeps the same pose and target, while framing still adapts to the recipient's viewport aspect ratio. This is not a fixed-aspect drawing frame. Reset forms in an opened custom study returns to that link's initial forms.

Copy shows an accessible confirmation. If clipboard access fails or is unavailable, a dialog provides the selected link for manual copy. Malformed or unsupported links display an explanation and retain the current usable study (the default study on a fresh visit). They are not silently overwritten; Keep this study or Copy share link replaces them explicitly. Same-tab hash navigation loads a new snapshot and clears undo history.

## Format and synchronization

- `share-state.ts` owns the version-1 schema and pure codec. JSON is compressed with zlib through pinned `fflate` 0.8.3, then encoded as unpadded base64url. JavaScript numbers are serialized without rounding. The format is independent of host/path and uses the fragment, so it can be served by any ordinary static host.
- Decoding accepts only recognized fields with explicit types. It checks operations, shape/range constraints, point counts and ordering, reveal flags and camera distance. Unknown versions are rejected with an update hint; future schema changes must retain a v1 reader or migration.
- Input is capped at 12,000 encoded characters and 16 KiB decoded JSON. A fixed decompression output buffer bounds allocation, one extra byte detects overflow, and the zlib checksum is verified before parsing. JSON cannot refer to external assets or execute code.
- `share-sync.ts` batches updates over 400 ms, reading the newest state when writing. It never queues old snapshots. Committed form edits, completed camera gestures, Copy and page exit flush immediately. `history.replaceState` preserves path/query and does not create an entry for each drag. Restoring a link cancels pending writes.
- `viewport.ts` exposes camera snapshots and reports orbit/pan/zoom and preset changes. Geometry remains on the existing preview/refinement pipeline; encoding does not wait for meshes.
- Undo/redo now capture the outgoing scene before queuing React state updates, preventing a delayed updater from reading the already-replaced scene reference.

## Verification

`npm test`: 118 tests pass. The 50 added checks cover all presets and operations, both rounded operands with custom curve points, generated references, exact numeric round trips, malformed/truncated inputs, checksums, expansion limits, missing fields, invalid parameters, unsupported versions, continuous-edit coalescing, latest-state flushes, cancellation and recovery.

`npm run build` passes. Existing non-fatal warnings concern the large main bundle and Manifold's unused Node import.

Browser checks passed against the dev server and built assets served by a plain static HTTP server:

- Copied a custom S-curve with point 3 at 50% thickness, six contours, hidden lines, a top camera and drawing lock; a fresh tab restored those parameters. Editing the restored form remained possible.
- Changed thickness to 65%, then copied after undo and redo: decoded links contained 50% and 65% respectively.
- A malformed same-tab link retained the current study and remained unchanged until Keep this study. Opening another valid hash restored its snapshot and cleared history.
- Generated a rounded reference, copied it before refinement completed, then refreshed the production page. The decoded form parameters were identical. The tested link was 551 characters including the local origin.
- Orbit/zoom changed the encoded camera. Reload restored the same pose (within floating-point arithmetic precision).
- Served production assets with clipboard writes restricted by Permissions-Policy. Copy opened the manual dialog with the entire link selected; Escape closed it and restored focus. Normal copying succeeded on the ordinary dev server.
- No warning/error logs were present at the final production reload or project-server check.

Visual evidence: [Share link confirmation](../artifacts/share-links.png).

 Short URLs backed by server storage, named scenes, accounts, native-app links and deployment are outside this milestone.
