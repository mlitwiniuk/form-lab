# Email accounts and configurable delivery

Both tools use email signup and password recovery. Registration is public when enabled; no account creation key is used. Existing username accounts, passwords, sessions and saved references survive the additive SQLite migration. The default mail transport is `disabled`: existing accounts can sign in, while signup, recovery and email changes wait for a configured delivery service.

## Signup and recovery

Choose **Sign in → Create account**, enter an email address, and request a signup link. The link verifies ownership and opens the password/confirmation form. The account is created only after that form is submitted, then signs in immediately. Choosing the password after email verification prevents someone from pre-registering another person's address with a password they control. Email addresses are normalized to lowercase ASCII and unique irrespective of case.

Choose **Forgot your password?** to request a reset link. Submitting a new password revokes every existing session and clears pending account-action links. Reset does not sign in automatically: use the new password to sign in afterward. Requests return the same generic accepted response whether the address exists or not; provider delivery runs outside the request path. For signup, use the newest email link to finish registration if a previous request was interrupted.

Email links contain 256-bit random tokens in URL fragments. The server stores only SHA-256 digests. Signup links expire after 24 hours; reset and email-change links after 30 minutes. Links are scoped to one action and consumed transactionally on success. New requests replace earlier links to the same address/action. GET requests and email link scanners do not change an account: the user must submit a same-origin POST form. The frontend removes tokens from browser history before rendering or study/share processing and also handles action links opened in an already-running page.

Reset and email-change links are bound to the password hash at request time. Password changes invalidate them. Completing an email change additionally checks the previous email, preventing an older change request from replacing a later confirmed address. Raw links and credentials are never written to application logs; click/open tracking is disabled for Mailgun API and SMTP messages.

## Existing accounts and email changes

Legacy users can continue signing in with their username. In the account dialog, **Add your email address** takes an email and the current password, then sends a confirmation link. Confirm it, then sign in using the email or existing username. This attaches email to the same user ID and preserves the entire library. The same controls support changing an existing email address. Confirmation revokes existing sessions. An address already owned by another account cannot be attached or merged; responses do not disclose whether another account owns it.

A legacy account without a verified email cannot use email recovery until it adds one while signed in. Account deletion and an administrator recovery interface are not implemented. This code has automated security checks but has not had an independent security audit.

## Delivery configuration

Set configuration in the environment of the Rust server. The binary does not automatically read `.env`; Compose does. `.env.example` documents the production values. Set `FORM_LAB_ORIGIN` to the exact public HTTPS origin, because all emailed links use it rather than a request Host/forwarded header.

| Variable | Meaning |
| --- | --- |
| `FORM_LAB_REGISTRATION_ENABLED` | `true` by default; `false` closes signup, including completion of outstanding signup links, while recovery remains available. |
| `FORM_LAB_MAIL_TRANSPORT` | `mailgun`, `smtp`, `disabled` (default), or local-only `file`. |
| `FORM_LAB_MAIL_FROM` | Required for enabled delivery; e.g. `Form Lab <no-reply@example.com>`. |
| `FORM_LAB_MAILGUN_REGION` | `us` (default) or `eu`, matching the sending domain's Mailgun region. |
| `FORM_LAB_MAILGUN_DOMAIN` | Sending domain, required for Mailgun API delivery. |
| `FORM_LAB_MAILGUN_API_KEY` | Secret API credential, required for Mailgun API delivery. |
| `FORM_LAB_SMTP_HOST` | SMTP hostname, required for SMTP delivery. |
| `FORM_LAB_SMTP_PORT` | Implicit-TLS port, defaults to `465`. |
| `FORM_LAB_SMTP_USERNAME` / `FORM_LAB_SMTP_PASSWORD` | SMTP credentials, both required for SMTP delivery. |
| `FORM_LAB_MAIL_DIRECTORY` | Required only for local `file` mode. |

Mailgun API example (supply the secret separately):

```sh
export FORM_LAB_MAIL_TRANSPORT=mailgun
export FORM_LAB_MAIL_FROM='Form Lab <no-reply@example.com>'
export FORM_LAB_MAILGUN_REGION=eu
export FORM_LAB_MAILGUN_DOMAIN=mg.example.com
```

SMTP alternative (supply the username/password separately):

```sh
export FORM_LAB_MAIL_TRANSPORT=smtp
export FORM_LAB_MAIL_FROM='Form Lab <no-reply@example.com>'
export FORM_LAB_SMTP_HOST=smtp.eu.mailgun.org
export FORM_LAB_SMTP_PORT=465
```

The API client uses HTTPS with certificate verification, a fixed Mailgun region endpoint, disabled redirects and a 15-second timeout. SMTP uses **implicit TLS**, verifies the relay certificate/hostname, and has no plaintext or opportunistic downgrade. Port 587 STARTTLS is not this transport's protocol; use an implicit-TLS endpoint, normally 465. SMTP is provider-independent and can use another relay with those requirements. The runtime Docker image includes CA certificates; the Rust build stage includes CMake for the TLS crypto dependency.

See Mailgun's [sending API](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/send-http), [region endpoints](https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview), and [tracking options](https://documentation.mailgun.com/docs/mailgun/user-manual/sending-messages/pass-sending-options). Configure the sending domain and sender with Mailgun before testing real delivery.

Compose passes these environment variables through from `.env`. Kamal's `config/deploy.yml` reads the non-secret values from your terminal and `.kamal/secrets` references the API key or SMTP credentials. It does not read Compose's `.env`. Configure the chosen transport before deploying; missing required values fail startup. The unused provider's credentials may remain empty. No live credentials were retrieved or stored during implementation.

## Local testing without a mail provider

From the repository root:

```sh
npm run setup
npm run build
export FORM_LAB_ORIGIN=http://127.0.0.1:3000
export FORM_LAB_MAIL_TRANSPORT=file
export FORM_LAB_MAIL_FROM='Form Lab <no-reply@example.test>'
export FORM_LAB_MAIL_DIRECTORY="$PWD/.local-mail"
cargo run --locked --manifest-path server/Cargo.toml
```

Open `http://127.0.0.1:3000/` or `/sketchfab/`, request signup for an address such as `you@example.test`, then inspect the newest `.eml` file in `.local-mail` and open its link in your browser. Choose a password, save a study, sign out, and test **Forgot your password?** using the captured reset email. File delivery is allowed only with a loopback HTTP origin, creates mode-0600 messages, and is ignored by Git and Docker build context. These files contain live local action links: keep them private and remove them after testing. Never serve the mail directory as public assets.

To test real delivery, configure one production transport and use an address you own. Verify receipt, From address, domain authentication, link origin, signup completion and password recovery. These live provider checks have not been performed here.

## Operations and verification limits

Sending uses a bounded 64-job in-memory queue. Each message gets up to three attempts, each bounded to 20 seconds, with two seconds between attempts. The queue is not durable: a crash/redeploy can lose pending mail; request a new link afterward. Timeouts can also cause duplicate delivery, but links remain single-use. Delivery failures log a generic message after retries. Pending users are not created until signup finishes. Persistent tokens survive restarts and remain subject to expiry, hash binding and single-use checks.

Email requests are limited to three per address per ten minutes, sharing the service's global authentication budget of 60 attempts/minute. Token submissions and password hashing are also throttled/bounded. These process-local budgets reset on restart; configure ingress abuse protection for public hosting.

The backup command includes email addresses and hashed tokens. Treat backups as account data. Restoring an older snapshot can restore revoked sessions and unconsumed action tokens; clear both `sessions` and `email_tokens` while offline when revoking all restored access.

Automated verification covers captured-email signup/reset/verification, legacy linking, replay/cross-purpose/expiry rejection, generic recovery responses, current-password protection, session revocation, saved-library preservation, Mailgun configuration startup, and rejection of a local self-signed SMTP certificate. Frontend tests cover action-link parsing, token removal and safe handoff, including hash navigation within an existing page. The HTTP test uses Python 3 and the OpenSSL CLI for its temporary SMTP certificate. Live Mailgun API delivery, successful authenticated SMTP delivery, production TLS/DNS/ingress, Docker image build/run and browser/visual behavior remain unverified. No external email, push or deployment was performed.
