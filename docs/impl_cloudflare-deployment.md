# Cloudflare deployment

Date: 23 October 2026. Status: configured and dry-run validated; **not deployed**. The user chose to handle authorization and deployment from their own terminal. The agent-started device authorization was declined and no Cloudflare resources were created.

## What is configured

`wrangler.jsonc` defines an assets-only deployment named `form-lab`, with `frontend/dist/` as its upload directory and `form-lab.app` as a Custom Domain. No application Worker script, backend, database or secret is uploaded. The existing share-link format continues to work entirely in the browser. An additional `workers.dev` URL is enabled for checking the deployment.

Cloudflare serves static assets without request charges or an asset-storage charge. This configuration adds no paid server component. Domain registration/renewal and any other existing account products are separate. [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

The domain currently delegates to `nina.ns.cloudflare.com` and `nitin.ns.cloudflare.com`. Public DNS checks found no apex A/AAAA address or `www` CNAME at preparation time. The account-level DNS records have not been inspected because authorization was not completed. The configuration attaches only the requested apex domain, not `www`.

## First deployment from your terminal

```sh
cd ~/Sites/rust/form-lab
npm run setup
npm run cloudflare:login
npm run cloudflare:whoami
npm run deploy:check
npm run deploy
```

`setup` installs the pinned dependencies, including Wrangler 4.152.0. Login opens Cloudflare in your normal browser and stores the authorized CLI credentials in the OS keychain. The requested scopes cover account/user identification, Workers deployment, routes and zone lookup. No password or token belongs in the project.

Use the account containing the active `form-lab.app` zone. If you have multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` to the correct account ID shown by `cloudflare:whoami` before running `deploy`, or add that account ID to `wrangler.jsonc`. The account ID is not a secret.

`deploy:check` rebuilds and runs Wrangler's dry run without publishing. `deploy` rebuilds and uploads the assets, then provisions the domain route. Cloudflare Custom Domains create the associated DNS record and manage the HTTPS certificate. No separate CNAME pointing at `workers.dev` is necessary. [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

If Wrangler reports an existing Worker named `form-lab` or an existing domain/DNS association, inspect it before accepting replacement. The repository has not yet been linked to a verified Cloudflare account or an existing deployment.

## Verify and update

After Wrangler reports success, open `https://form-lab.app/`. In Workers & Pages → form-lab → Settings → Domains & Routes, confirm the custom domain and certificate are active if HTTPS is still provisioning.

Check that the shape appears, edits refine normally, and Copy share link uses `https://form-lab.app/#s=…`. Open the copied URL in a new tab and confirm the forms, camera and reveals are restored. Test Save image as well; both geometry workers and the WASM asset must load on the deployed origin.

For subsequent releases, run `npm run deploy`. If authorization has expired, run `npm run cloudflare:login` first. Keep prior deployments available in the Cloudflare dashboard for rollback. The original static build can still be hosted elsewhere by serving `frontend/dist/`.

## Verification completed locally

- Production build passed with the existing non-fatal bundle-size and Manifold Node-import warnings.
- Wrangler dry run passed and found seven static files in the build directory.
- Domain nameserver and public address checks completed.
- Deployment scripts and documentation index are prepared; public availability, custom-domain binding, TLS and production share-link behavior remain unverified until the user publishes.
