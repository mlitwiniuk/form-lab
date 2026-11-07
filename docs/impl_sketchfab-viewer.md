# Sketchfab viewer and synced model library

The `/sketchfab/` page embeds public, embeddable Sketchfab models. Paste a model URL or ID. Presets and arrow controls move the camera one axis at a time; the step selector controls the angle. Near-orthographic uses a narrow 1° field of view (the documented API minimum) to approximate parallel projection; Sketchfab's viewer is still perspective and is not mathematically orthographic. Original restores the model's initial field of view; Wide uses a wider angle. Changing projection adjusts camera distance to keep approximate framing. Zoom and image export remain available.

Copy link records the model ID, projection, camera position, target and actual field of view in the URL. Links require the model to remain available and embeddable on Sketchfab. Rotation presets follow each model's coordinate axes. Some models may need manual framing. Shared links do not include account credentials or private saved-library data.

The optional Rust service stores user accounts, sessions and named model IDs in SQLite. It does not download or cache model geometry or textures: an internet connection and Sketchfab availability are required. Signing in synchronizes the saved list when all devices use the same server. Users can add and remove entries. Models saved in the earlier separate hosted viewer are not automatically imported. No password recovery, account deletion, scheduled backups, or account administration UI is implemented.

## Run locally

```sh
npm run setup
npm run build
FORM_LAB_SIGNUP_KEY='a-long-random-local-setup-key' cargo run --manifest-path server/Cargo.toml
```

Open `http://127.0.0.1:3000/sketchfab/`. Create an account with the setup key, then sign in on each device. The default database is `form-lab.sqlite3` in the working directory. Keep it and its WAL files out of version control. For frontend development, start `npm run dev` with the server also running and set `FORM_LAB_ORIGIN=http://127.0.0.1:5173` for the server; Vite proxies `/api` to port 3000. Origin must match the browser address exactly.

## Self-host with Docker

1. Copy `.env.example` to `.env`, set `FORM_LAB_ORIGIN` to the exact browser-facing HTTPS origin without a trailing slash, and set a long random `FORM_LAB_SIGNUP_KEY`. Keep `.env` secret and outside version control.
2. Run `docker compose up -d --build`. The service listens on host loopback port 3000 and stores SQLite under the `form-lab-data` named volume.
3. Put an HTTPS reverse proxy in front of `127.0.0.1:3000` for that domain. Do not expose plain HTTP or change the binding to a public interface. Configure the proxy to rate-limit authentication and limit requests. This initial service has only process-local global and per-username authentication throttling; it is not a substitute for edge rate limiting.
4. Open the viewer, create your account using the setup key, then remove `FORM_LAB_SIGNUP_KEY` from `.env` and run `docker compose up -d`. This disables additional registration. Sign in with the same account on your devices.
5. Back up the named volume consistently while the service is stopped, or use SQLite's online backup API. Protect the backup and test restoration before relying on it. Database access gives access to stored model lists and password hashes.

Session tokens are random, stored hashed, expire after 30 days, and use HttpOnly, SameSite=Strict and (for HTTPS origins) Secure cookies with the __Host- prefix. Passwords use Argon2. State-changing API calls check the request Origin. Signup requires a server-configured key of at least 16 characters; when absent, registration is disabled. This is a new, small self-hosted account implementation and has not had an independent security audit. Do not deploy without reviewing your exposure and backup arrangements.

## Verification

The review fixes use the [documented Sketchfab FOV range](https://sketchfab.com/developers/viewer/functions) of 1–179 degrees, remove an initial 0.15 framing multiplier, and preserve framing across projections. Share links record the successfully loaded model rather than an edited input. Initialization and camera callbacks from replaced models are ignored; initial shared cameras are applied only to the initial load. Existing links without an explicit FOV still restore using the projection preset. Model names are rendered as text. Library writes and deletes always use the authenticated account ID. Private API responses carry `Cache-Control: no-store`; no account values are included in public view links. Libraries are limited to 1000 references per account.


Run `npm test`, `npm run build`, `cargo build --manifest-path server/Cargo.toml`, and `python3 server/tests/integration.py`. The integration check covers account creation and login, origin enforcement, user isolation, logout, and persistence after restarting the service. Viewer camera math is tested with a mocked Sketchfab API. These tests do not verify a live Sketchfab session or browser usability; Docker and reverse-proxy configuration require validation on the target host.

## Kamal on a homelab

`config/deploy.yml` targets Kamal 2.12+, one Linux host, GHCR and the persistent `form-lab-data:/data` Docker volume. `/up` checks SQLite. Do not scale this service to other hosts: this volume is local to one Docker host. Rolling releases on the same host may briefly share the database; schema changes must remain backward compatible. Vite's hashed assets use Kamal asset bridging. The image runs as UID 10001; a new named volume inherits `/data` ownership from the image. Existing or bind-mounted storage must be writable by that UID.

Set non-secret deployment parameters in your terminal (replace all example values):

```sh
export FORM_LAB_SERVER=192.0.2.10
export FORM_LAB_SSH_USER=deploy
export FORM_LAB_HOST=form-lab.example.com
export FORM_LAB_IMAGE=your-github-user/form-lab
export KAMAL_REGISTRY_USERNAME=your-github-user
export FORM_LAB_ARCH=amd64 # use arm64 for an ARM homelab host
```

Supply `KAMAL_REGISTRY_PASSWORD` (a GHCR credential allowed to push/pull this image) and an initial `FORM_LAB_SIGNUP_KEY` through your password manager or shell environment. `.kamal/secrets` contains references only. It does not load Compose's `.env`. Use a long random signup key, then export `FORM_LAB_SIGNUP_KEY=''` after creating accounts and redeploy to disable registration. Avoid printing secrets through `kamal secrets print` or shell tracing.

`kamal config` validates configuration locally without connecting to your homelab. Kamal normally builds the committed Git revision: review and commit this work in your terminal before deployment, or it will omit the uncommitted implementation. No commit, push, setup, server access or deployment was performed during this review. Once you authorize hosting in your terminal, `kamal setup` handles the initial deployment and `kamal deploy` handles later releases.

The supplied proxy uses direct Let's Encrypt HTTPS (`ssl: true`). Your public DNS must resolve to the homelab's public address, with TCP 80/443 routed to kamal-proxy; SSH must be reachable from your deployment machine. Check for CGNAT and existing services occupying those ports. If Caddy, a tunnel, or another ingress already owns them, adapt proxy routing and TLS termination before setup. For TLS termination upstream, change `ssl` to false and restrict the HTTP hop to trusted ingress, while retaining the public HTTPS `FORM_LAB_ORIGIN`. The server derives cookie security from that configured origin and does not trust client-supplied forwarded headers. Do not copy another application's hostname, secrets or storage volume.

Kamal's proxy limits request bodies to 16 KiB in this configuration. It does not add per-IP authentication rate limits; configure those at your chosen ingress. The application bounds simultaneous Argon2 work to two operations and limits authentication globally to 60 attempts/minute and per username to eight attempts/ten minutes. These limits reset on restart and apply per process, so they reduce resource abuse but do not provide a distributed rate limiter. A public attacker can still exhaust the login budget; ingress protection remains useful.

See [Kamal proxy configuration](https://kamal-deploy.org/docs/configuration/proxy/) and [Kamal configuration](https://kamal-deploy.org/docs/configuration/overview/) for the deployment contract. The old Cloudflare static deployment still serves the frontend only; it cannot host these SQLite accounts. All three machines must use the same self-hosted HTTPS origin to share the library.

## Consistent backups and recovery

The server binary supports `form-lab-server backup DESTINATION`, using SQLite's online backup API and an integrity check. It includes committed WAL data, creates a mode-0600 file, and refuses to overwrite an existing file or symlink. Run it as the service user. A failed command can leave an incomplete destination: only retain successful snapshots, and retry with a new filename. Do not copy the live main database alone.

For Compose, from the checkout:

```sh
docker compose exec -T form-lab mkdir -p /data/backups
docker compose exec -T form-lab form-lab-server backup /data/backups/snapshot-2026-11-07.sqlite3
```

For Kamal, from your deployment terminal:

```sh
kamal app exec --reuse 'mkdir -p /data/backups'
kamal app exec --reuse 'form-lab-server backup /data/backups/snapshot-2026-11-07.sqlite3'
```

Choose a unique filename each time. Download successful snapshots off the homelab with restrictive permissions and encryption; copies inside the same volume do not protect against host/disk loss. Schedule backups and retention in your own operations tooling. Snapshots include password hashes, saved references and active session hashes; restoring one may restore sessions that were revoked after the snapshot. To revoke all restored sessions, delete the `sessions` rows with SQLite while offline.

For recovery, stop **all** app containers using the volume, preserve the existing database/WAL/SHM as a set in a recovery directory, then install a verified snapshot as `/data/form-lab.sqlite3`, owned by UID 10001 with mode 0600. Ensure no old `form-lab.sqlite3-wal` or `form-lab.sqlite3-shm` remains beside the replacement. Start the service and verify sign-in and saved entries before reopening traffic. Rehearse this on a separate volume first. Compose normally prefixes the volume name with its project name, while Kamal uses the literal `form-lab-data` name. When switching deployment methods, migrate a verified snapshot into the target volume; do not assume the library will appear automatically. Container-local backups, off-host transfer, scheduling and host recovery are separate checks.

## Review validation (2026-11-07)

CLI verification: frontend suite and production build; Rust test/build/Clippy with the locked dependency set; real loopback HTTP integration checks for account isolation, multiple-device sessions, CSRF rejection, private-response caching, session hashing/revocation/expiry, HTTPS cookie flags, throttling, restart persistence, and online backup/restore; Compose configuration and Kamal 2.12 configuration with placeholder hosts; shell syntax and strict docs index audit. The original frontend baseline passed 246 tests. Added camera tests cover shared-view restoration, framing, loaded-model selection and stale callbacks. Wrangler was updated to 4.158.0 to resolve reported development dependency advisories; npm audit and RustSec audit report no known vulnerabilities in the checked lockfiles. This is dependency scanning and a code review, not an independent security audit.

Unverified: Docker image build/run (daemon unavailable), real reverse proxy/TLS/DNS/ingress behavior, Kamal deployment and architecture-specific image build, live Sketchfab camera/embedding/image export, visual/responsive/accessibility behavior, actual three-machine sign-in, and off-host backup/recovery operations. The production build retains non-fatal Manifold browser-externalization and bundle-size warnings. No GUI/browser automation, deployment, push or commit was performed. The separate public viewer was not changed or live-verified.
