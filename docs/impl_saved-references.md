# Accounts and saved references in both tools

Form studies (`/`) and the Sketchfab viewer (`/sketchfab/`) use the same React header, paper/green theme, navigation, native modal account dialogs and reference library. Sign-in cookies belong to the whole origin, so signing in on one page also signs in on the other. No deployment or browser automation was performed for this work.

## Account flow

Use **Sign in** in either header. If registration is enabled, the dialog has separate **Sign in** and **Create account** modes. Creating an account requires a username, password and confirmation, plus the host's account creation key. Both password fields must match; passwords require at least 12 characters. A successful registration signs in immediately. Choosing Save or Library while signed out opens authentication, then resumes the requested action. When registration is disabled, existing users can still sign in.

The account button shows the username after sign-in. It opens password-change and sign-out controls. Password changes require the current password and matching new passwords, revoke all existing sessions, and issue a fresh session for the current browser. Password verification and session insertion guard against an old password verification finishing after a concurrent password change. Signing out normally affects only the current device. Other tabs recheck account state when focused; expired sessions request sign-in again. Network/static-hosting errors have an explicit unavailable state.

There is no email-based password recovery, account deletion, or administrator UI. The sign-in dialog states the recovery limit and directs users to the host. This remains a self-hosted account implementation without an independent security audit.

## Save, overwrite and reopen

**Save** opens the same dialog in either tool. Give the reference a name and use **Save as new**. After creating or opening a save, the dialog defaults to **Overwrite** that save, with an explicit **Save as new** alternative. Names can be changed while overwriting. Identical names and several views of the same Sketchfab model are allowed; saves have independent IDs.

Form-study saves include the validated versioned `SharedStudy`: forms, sizes, transformations, deformations and centerlines, appearances/display mode, guide reveals, camera projection/zoom/orbit constraints, drawing lock and focus setting. Undo history and transient selection/editor tools are not part of a saved study.

Sketchfab saves include the successfully loaded model UID, camera position/target and actual field of view, selected projection, rotation step and drawing lock. Typing a different URL without loading it does not change the saved model. Saved models still require Sketchfab availability and embedding permission; no geometry or textures are stored. Old model-only entries open at default camera framing.

**Library** lists both types, with All / Form studies / Sketchfab filters and an empty state. Opening a save for the other tool navigates to that tool and restores it after account verification. Deleting a save asks for confirmation and removes only that account's entry. The selected save ID stays in the page's `?save=` query so refresh can reopen it; this is an account-only link. **Share link** creates a public view snapshot and strips the private save ID. Public snapshots keep working without sign-in, subject to Sketchfab availability for external models.

Overwriting sends the revision returned when the save was opened or last saved. The server updates only the authenticated user's matching ID, kind and revision. A stale revision returns HTTP 409 and leaves the newer save intact. Open the latest version from Library to continue from it, or choose Save as new to keep the local work. There is no automatic merge or silent force-overwrite.

## Persistence and compatibility

SQLite's `configurations` table stores user ID, random save ID, kind, title, settings JSON, revision and update timestamp. Listing returns metadata; payloads are fetched only when a reference is opened. Each account can keep 1000 saves. Requests are limited to 64 KiB and settings JSON to 48 KiB. Frontend loaders validate recognized fields before restoring a reference. The deployment proxy body limit is also 64 KiB; keep upstream ingress limits compatible.

Startup applies an additive transaction that copies the old `models` table into model-only configurations once. It preserves names, ownership and the original table. A migration marker prevents duplicates and prevents deleted migrated saves from reappearing on restart. Legacy `/api/models` endpoints remain compatible but do not synchronize subsequent writes into the new library; use `/api/configurations` for new clients. Rolling back the frontend leaves the new table intact but hides configuration saves from the older UI.

Back up before upgrading an existing installation. The existing SQLite backup command includes configuration records; the integration suite restores both form and model settings from a snapshot. See [hosting and recovery](impl_sketchfab-viewer.md) for volume and deployment details. No deployment or real database migration was run against a user's library during development; migration tests use disposable databases.

## Local acceptance checks

Follow the [README quick start](../README.md#test-locally-with-accounts-and-the-sketchfab-library), then:

1. Sign in from Form studies. Switch to Sketchfab and confirm the same username; check the reverse direction as well.
2. In Form studies, change a shape, guides, projection and view. Save as new, edit it, overwrite it, refresh and reopen it from Library. Then save a second copy and confirm both entries remain.
3. In Sketchfab, load a model and choose a camera/projection/rotation step. Save it. Change the angle, overwrite, then save another angle as new. Reopen each view and inspect the restored camera and drawing lock.
4. Open the same save in two browser profiles. Overwrite it in the first, then try overwriting the older revision in the second. Confirm the conflict message and verify Save as new keeps the second version.
5. Open references across tools from Library; refresh account-only `?save=` URLs. Copy a public Share link and open it while signed out, confirming it contains no `save=` identifier.
6. Check password confirmation, incorrect credentials, disabled registration, wrong current password, password change and sign-out. Confirm a password change signs out another browser session. Verify a second account cannot see the first account's saves.
7. Check keyboard navigation, Escape/focus behavior, long names, phone-width wrapping, scrollable dialogs, error states and image export.

Automated checks cover camera save/restore and single-axis math, settings validation, HTTP authentication/isolation, create/read/update/delete and stale overwrites, migration idempotency, password rotation, session behavior, and backup/restore. Visual styling, browser interaction/focus, real Sketchfab rendering/export and actual multi-machine use remain manual checks. Docker and reverse-proxy runtime verification remain separate from the passing local build and configuration checks.
