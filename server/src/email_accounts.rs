use super::*;
use rusqlite::OptionalExtension;
const INVALID_LINK: ApiError = (
    StatusCode::BAD_REQUEST,
    "This link is invalid, expired, or already used. Please request a new link.",
);
const EMAIL_SENT: &str = "If this address is eligible, an email will arrive shortly. Check your inbox and spam folder, and use the newest link.";
#[derive(Deserialize)]
pub(super) struct EmailRequest {
    email: String,
}
#[derive(Deserialize)]
pub(super) struct FinishRequest {
    token: String,
    #[serde(default)]
    new_password: String,
}
#[derive(Deserialize)]
pub(super) struct AttachRequest {
    email: String,
    current_password: String,
}

pub(super) fn address(value: &str) -> ApiResult<String> {
    let email = value.trim().to_ascii_lowercase();
    if email.len() > 254
        || !email.is_ascii()
        || email
            .bytes()
            .any(|c| c.is_ascii_whitespace() || c.is_ascii_control())
        || email.parse::<lettre::Address>().is_err()
        || !email.rsplit('@').next().is_some_and(|d| d.contains('.'))
    {
        return Err((StatusCode::BAD_REQUEST, "Enter a valid email address."));
    }
    Ok(email)
}
pub(super) fn migrate(db: &mut Connection) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    let columns = {
        let mut stmt = tx.prepare("PRAGMA table_info(users)")?;
        stmt.query_map([], |r| r.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?
    };
    if !columns.iter().any(|c| c == "email") {
        tx.execute_batch("ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE; ALTER TABLE users ADD COLUMN email_verified_at INTEGER;")?;
    }
    tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL; CREATE TABLE IF NOT EXISTS email_tokens(token_hash TEXT PRIMARY KEY,purpose TEXT NOT NULL CHECK(purpose IN ('signup','reset','email')),email TEXT NOT NULL,user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,credential_hash TEXT,prior_email TEXT,expires_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS email_tokens_expiry ON email_tokens(expires_at); CREATE INDEX IF NOT EXISTS email_tokens_address ON email_tokens(email,purpose); CREATE INDEX IF NOT EXISTS email_tokens_user ON email_tokens(user_id);")?;
    tx.commit()
}
fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn mail_throttle(app: &App, email: &str) -> ApiResult<()> {
    throttle_limit(app, &format!("email:{email}"), 3)
}
fn mail_unavailable(message: &'static str) -> ApiError {
    (StatusCode::SERVICE_UNAVAILABLE, message)
}
fn signed_out(app: &App) -> ApiResult<Response> {
    let mut response = Json(serde_json::json!({"ok":true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
            cookie_name(app),
            if app.secure { "; Secure" } else { "" }
        ))
        .map_err(db_error)?,
    );
    Ok(response)
}
fn response() -> Json<serde_json::Value> {
    Json(serde_json::json!({"message":EMAIL_SENT}))
}
struct Challenge {
    email: String,
    user: Option<i64>,
    credential: Option<String>,
    prior_email: Option<String>,
    purpose: &'static str,
}
fn issue(app: &App, c: Challenge) -> ApiResult<mail::Email> {
    let raw = token();
    let ttl = if c.purpose == "signup" {
        24 * 3600
    } else {
        30 * 60
    };
    let mut db = app.db.lock().map_err(db_error)?;
    let tx = db.transaction().map_err(db_error)?;
    tx.execute("DELETE FROM email_tokens WHERE expires_at<=?", [now()])
        .map_err(db_error)?;
    // A newer request replaces older links to the same destination and purpose.
    tx.execute(
        "DELETE FROM email_tokens WHERE purpose=? AND email=?",
        params![c.purpose, c.email],
    )
    .map_err(db_error)?;
    tx.execute("INSERT INTO email_tokens(token_hash,purpose,email,user_id,credential_hash,prior_email,expires_at) VALUES(?,?,?,?,?,?,?)", params![digest(&raw),c.purpose,c.email,c.user,c.credential,c.prior_email,now()+ttl]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    let (subject, instruction) = match c.purpose {
        "signup" => (
            "Finish creating your Form Lab account",
            "Verify your email address and choose a password to create your Form Lab account.",
        ),
        "reset" => (
            "Reset your Form Lab password",
            "Choose a new password for your Form Lab account. This will sign out your other sessions.",
        ),
        _ => (
            "Confirm your Form Lab email address",
            "Confirm this address for the Form Lab account where you requested it. Confirmation will sign out your existing sessions; sign in again with this email.",
        ),
    };
    Ok(mail::Email {
        to: c.email,
        subject: subject.into(),
        body: format!(
            "{instruction}\n\n{}\n\nThis link expires in {} and can be used once. If you did not request it, ignore this email. Your account has not been changed.\n",
            format_args!("{}/#account={}&token={raw}", app.origin, c.purpose),
            if c.purpose == "signup" {
                "24 hours"
            } else {
                "30 minutes"
            }
        ),
    })
}
pub(super) async fn register(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<EmailRequest>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    same_origin(&app, &headers)?;
    if !app.registration {
        return Err((
            StatusCode::FORBIDDEN,
            "New registrations are currently closed.",
        ));
    }
    let email = address(&c.email)?;
    mail_throttle(&app, &email)?;
    let permit = app.mailer.reserve().map_err(mail_unavailable)?;
    let exists = app
        .db
        .lock()
        .map_err(db_error)?
        .query_row("SELECT 1 FROM users WHERE email=?", [&email], |_| Ok(()))
        .optional()
        .map_err(db_error)?
        .is_some();
    let job = if exists {
        None
    } else {
        Some(issue(
            &app,
            Challenge {
                email,
                user: None,
                credential: None,
                prior_email: None,
                purpose: "signup",
            },
        )?)
    };
    permit.send(job);
    Ok((StatusCode::ACCEPTED, response()))
}
pub(super) async fn recover(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<EmailRequest>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    same_origin(&app, &headers)?;
    let email = address(&c.email)?;
    mail_throttle(&app, &email)?;
    let permit = app.mailer.reserve().map_err(mail_unavailable)?;
    let user: Option<(i64, String)> = app
        .db
        .lock()
        .map_err(db_error)?
        .query_row(
            "SELECT id,password_hash FROM users WHERE email=? AND email_verified_at IS NOT NULL",
            [&email],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(db_error)?;
    let job = user
        .map(|(id, hash)| {
            issue(
                &app,
                Challenge {
                    email,
                    user: Some(id),
                    credential: Some(hash),
                    prior_email: None,
                    purpose: "reset",
                },
            )
        })
        .transpose()?;
    permit.send(job);
    Ok((StatusCode::ACCEPTED, response()))
}
async fn password_hash(app: &App, password: String) -> ApiResult<String> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a password of at least 12 characters (maximum 1024 bytes).",
        ));
    }
    let permit = app.auth_slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication busy. Try again shortly.",
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(db_error)
    })
    .await
    .map_err(db_error)?
}
struct StoredChallenge {
    email: String,
    user: Option<i64>,
    credential: Option<String>,
    prior_email: Option<String>,
}
fn challenge(db: &Connection, raw: &str, purpose: &str) -> ApiResult<StoredChallenge> {
    if !valid_token(raw) {
        return Err(INVALID_LINK);
    }
    db.query_row("SELECT email,user_id,credential_hash,prior_email FROM email_tokens WHERE token_hash=? AND purpose=? AND expires_at>?", params![digest(raw),purpose,now()], |r| Ok(StoredChallenge { email:r.get(0)?,user:r.get(1)?,credential:r.get(2)?,prior_email:r.get(3)? })).map_err(|_| INVALID_LINK)
}
pub(super) async fn finish_registration(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<FinishRequest>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    throttle(&app, &format!("token:signup:{}", digest(&c.token)))?;
    if !app.registration {
        return Err((
            StatusCode::FORBIDDEN,
            "New registrations are currently closed.",
        ));
    }
    {
        challenge(&*app.db.lock().map_err(db_error)?, &c.token, "signup")?;
    }
    let hash = password_hash(&app, c.new_password).await?;
    let user = {
        let mut db = app.db.lock().map_err(db_error)?;
        let tx = db.transaction().map_err(db_error)?;
        let stored = challenge(&tx, &c.token, "signup")?;
        // The password is chosen only AFTER email ownership is proved, avoiding pre-registration takeover.
        tx.execute(
            "INSERT INTO users(username,password_hash,email,email_verified_at) VALUES(?,?,?,?)",
            params![
                format!("email-{}", &token()[..32]),
                hash,
                stored.email,
                now()
            ],
        )
        .map_err(|_| INVALID_LINK)?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "DELETE FROM email_tokens WHERE email=? AND purpose='signup'",
            [stored.email],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        id
    };
    guarded_session(&app, user, Some(&hash))
}
pub(super) async fn finish_reset(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<FinishRequest>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    throttle(&app, &format!("token:reset:{}", digest(&c.token)))?;
    {
        challenge(&*app.db.lock().map_err(db_error)?, &c.token, "reset")?;
    }
    let hash = password_hash(&app, c.new_password).await?;
    let mut db = app.db.lock().map_err(db_error)?;
    let tx = db.transaction().map_err(db_error)?;
    let stored = challenge(&tx, &c.token, "reset")?;
    let user = stored.user.ok_or(INVALID_LINK)?;
    let changed = tx.execute("UPDATE users SET password_hash=? WHERE id=? AND email=? AND email_verified_at IS NOT NULL AND password_hash=?", params![hash,user,stored.email,stored.credential]).map_err(db_error)?;
    if changed != 1 {
        return Err(INVALID_LINK);
    }
    tx.execute("DELETE FROM sessions WHERE user_id=?", [user])
        .map_err(db_error)?;
    tx.execute(
        "DELETE FROM email_tokens WHERE user_id=? OR (email=? AND purpose='signup')",
        params![user, stored.email],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    signed_out(&app)
}
pub(super) async fn request_email(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<AttachRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&app, &headers)?;
    let user = session_user(&app, &headers)?;
    let email = address(&c.email)?;
    mail_throttle(&app, &email)?;
    if c.current_password.len() > 1024 {
        return Err(UNAUTHORIZED);
    }
    let (hash, prior_email): (String, Option<String>) = app
        .db
        .lock()
        .map_err(db_error)?
        .query_row(
            "SELECT password_hash,email FROM users WHERE id=?",
            [user],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    let permit = app.auth_slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication busy. Try again shortly.",
        )
    })?;
    let verify = hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&verify).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(c.current_password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(db_error)?;
    if !valid {
        return Err((StatusCode::UNAUTHORIZED, "Current password is incorrect."));
    }
    let permit = app.mailer.reserve().map_err(mail_unavailable)?;
    let exists = app
        .db
        .lock()
        .map_err(db_error)?
        .query_row(
            "SELECT 1 FROM users WHERE email=? AND id<>?",
            params![email, user],
            |_| Ok(()),
        )
        .optional()
        .map_err(db_error)?
        .is_some();
    let job = if exists {
        None
    } else {
        Some(issue(
            &app,
            Challenge {
                email,
                user: Some(user),
                credential: Some(hash),
                prior_email,
                purpose: "email",
            },
        )?)
    };
    permit.send(job);
    Ok(response())
}
pub(super) async fn finish_email(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<FinishRequest>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    throttle(&app, &format!("token:email:{}", digest(&c.token)))?;
    let mut db = app.db.lock().map_err(db_error)?;
    let tx = db.transaction().map_err(db_error)?;
    let stored = challenge(&tx, &c.token, "email")?;
    let user = stored.user.ok_or(INVALID_LINK)?;
    let changed = tx.execute("UPDATE users SET email=?,email_verified_at=? WHERE id=? AND password_hash=? AND email IS ?", params![stored.email,now(),user,stored.credential,stored.prior_email]).map_err(|_| INVALID_LINK)?;
    if changed != 1 {
        return Err(INVALID_LINK);
    }
    tx.execute("DELETE FROM sessions WHERE user_id=?", [user])
        .map_err(db_error)?;
    tx.execute(
        "DELETE FROM email_tokens WHERE user_id=? OR email=?",
        params![user, stored.email],
    )
    .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    signed_out(&app)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_are_canonical_and_not_headers_or_display_names() {
        assert_eq!(
            address(" Person@Example.COM ").unwrap(),
            "person@example.com"
        );
        for value in [
            "alice",
            "alice@localhost",
            "a@example.com\r\nBcc:x@example.com",
            "Name <a@example.com>",
            "a@example.com,b@example.com",
        ] {
            assert!(address(value).is_err());
        }
    }
    #[test]
    fn email_migration_preserves_existing_users_and_is_repeatable() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT); INSERT INTO users VALUES(1,'alice','existing-hash');").unwrap();
        migrate(&mut db).unwrap();
        migrate(&mut db).unwrap();
        assert_eq!(
            db.query_row(
                "SELECT password_hash FROM users WHERE username='alice' AND email IS NULL",
                [],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "existing-hash"
        );
    }
}
