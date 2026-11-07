use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use rand::RngCore;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
mod email_accounts;
mod mail;
use tokio::sync::Semaphore;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct App {
    db: Arc<Mutex<Connection>>,
    origin: String,
    registration: bool,
    mailer: mail::Mailer,
    secure: bool,
    attempts: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
    auth_slots: Arc<Semaphore>,
    dummy_hash: String,
}
type ApiError = (StatusCode, &'static str);
type ApiResult<T> = Result<T, ApiError>;
const UNAUTHORIZED: ApiError = (StatusCode::UNAUTHORIZED, "Please sign in.");
fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn digest(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}
fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
fn db_error(_: impl std::fmt::Display) -> ApiError {
    (StatusCode::INTERNAL_SERVER_ERROR, "Storage error.")
}
fn same_origin(app: &App, headers: &HeaderMap) -> ApiResult<()> {
    if headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(app.origin.as_str()) {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "Invalid request origin."))
    }
}
fn username(name: &str) -> ApiResult<String> {
    let n = name.trim().to_ascii_lowercase();
    if (3..=40).contains(&n.len())
        && n.bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        Ok(n)
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "Username must have 3–40 letters, numbers, underscores or hyphens.",
        ))
    }
}
fn cookie_name(app: &App) -> &'static str {
    if app.secure {
        "__Host-formlab_session"
    } else {
        "formlab_session"
    }
}
fn session_user(app: &App, headers: &HeaderMap) -> ApiResult<i64> {
    let value = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .map(str::trim)
                .find_map(|v| v.strip_prefix(&format!("{}=", cookie_name(app))))
        })
        .ok_or(UNAUTHORIZED)?;
    let db = app.db.lock().map_err(db_error)?;
    db.query_row(
        "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?",
        params![digest(value), now()],
        |r| r.get(0),
    )
    .map_err(|_| UNAUTHORIZED)
}
fn guarded_session(app: &App, user_id: i64, password_hash: Option<&str>) -> ApiResult<Response> {
    let raw = token();
    let db = app.db.lock().map_err(db_error)?;
    if let Some(hash) = password_hash {
        let current: String = db
            .query_row(
                "SELECT password_hash FROM users WHERE id=?",
                [user_id],
                |r| r.get(0),
            )
            .map_err(|_| UNAUTHORIZED)?;
        if current != hash {
            return Err(UNAUTHORIZED);
        }
    }
    db.execute("DELETE FROM sessions WHERE expires_at <= ?", [now()])
        .map_err(db_error)?;
    db.execute(
        "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        params![digest(&raw), user_id, now() + 30 * 86400],
    )
    .map_err(db_error)?;
    let cookie = format!(
        "{}={raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000{}",
        cookie_name(app),
        if app.secure { "; Secure" } else { "" }
    );
    let mut res = Json(serde_json::json!({"ok":true})).into_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(db_error)?,
    );
    Ok(res)
}
#[derive(Deserialize)]
struct Credentials {
    #[serde(default)]
    username: String,
    #[serde(default)]
    email: String,
    password: String,
}
fn throttle(app: &App, name: &str) -> ApiResult<()> {
    throttle_limit(app, name, 8)
}
fn throttle_limit(app: &App, name: &str, limit: usize) -> ApiResult<()> {
    let mut attempts = app.attempts.lock().map_err(db_error)?;
    attempts.retain(|_, times| {
        times.retain(|t| t.elapsed() < Duration::from_secs(600));
        !times.is_empty()
    });
    if attempts.len() >= 1000 && !attempts.contains_key(name) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Try again later.",
        ));
    }
    // A global budget also covers guessed usernames and email-link requests.
    let global = attempts.entry(String::new()).or_default();
    global.retain(|t| t.elapsed() < Duration::from_secs(60));
    if global.len() >= 60 {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Try again later.",
        ));
    }
    global.push(Instant::now());
    let times = attempts.entry(name.to_string()).or_default();
    if times.len() >= limit {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Try again later.",
        ));
    }
    times.push(Instant::now());
    Ok(())
}
async fn login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<Credentials>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    let identity = if c.email.is_empty() {
        c.username.as_str()
    } else {
        c.email.as_str()
    };
    let name = if identity.contains('@') {
        email_accounts::address(identity)?
    } else {
        username(identity)?
    };
    throttle(&app, &name)?;
    if c.password.len() > 1024 {
        return Err(UNAUTHORIZED);
    }
    let user: Option<(i64, String)> = {
        let db = app.db.lock().map_err(db_error)?;
        db.query_row(
            "SELECT id,password_hash FROM users WHERE username=?1 OR (email=?1 AND email_verified_at IS NOT NULL)",
            [&name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()
    };
    let (id, hash) = user.unwrap_or_else(|| (0, app.dummy_hash.clone()));
    let permit = app.auth_slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication busy. Try again later.",
        )
    })?;
    let expected_hash = hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&hash).ok().is_some_and(|h| {
            Argon2::default()
                .verify_password(c.password.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(db_error)?;
    if !valid || id == 0 {
        return Err(UNAUTHORIZED);
    }
    guarded_session(&app, id, Some(&expected_hash))
}
async fn logout(State(app): State<App>, headers: HeaderMap) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    if let Some(raw) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .map(str::trim)
                .find_map(|v| v.strip_prefix(&format!("{}=", cookie_name(&app))))
        })
    {
        app.db
            .lock()
            .map_err(db_error)?
            .execute("DELETE FROM sessions WHERE token_hash=?", [digest(raw)])
            .map_err(db_error)?;
    }
    let mut r = Json(serde_json::json!({"ok":true})).into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0{}",
            cookie_name(&app),
            if app.secure { "; Secure" } else { "" }
        ))
        .map_err(db_error)?,
    );
    Ok(r)
}
async fn me(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<serde_json::Value>> {
    let id = session_user(&app, &headers)?;
    let db = app.db.lock().map_err(db_error)?;
    let (name, email): (String, Option<String>) = db
        .query_row("SELECT username,email FROM users WHERE id=?", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .map_err(db_error)?;
    Ok(Json(serde_json::json!({"username":name,"email":email})))
}
#[derive(Serialize)]
struct Model {
    uid: String,
    title: String,
}
#[derive(Deserialize)]
struct NewModel {
    uid: String,
    title: String,
}
async fn list_models(State(app): State<App>, headers: HeaderMap) -> ApiResult<Json<Vec<Model>>> {
    let id = session_user(&app, &headers)?;
    let db = app.db.lock().map_err(db_error)?;
    let mut stmt = db
        .prepare("SELECT uid,title FROM models WHERE user_id=? ORDER BY created_at DESC,uid")
        .map_err(db_error)?;
    let models = stmt
        .query_map([id], |r| {
            Ok(Model {
                uid: r.get(0)?,
                title: r.get(1)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(Json(models))
}
async fn save_model(
    State(app): State<App>,
    headers: HeaderMap,
    Json(m): Json<NewModel>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&app, &headers)?;
    let id = session_user(&app, &headers)?;
    let title = m.title.trim();
    if !(1..=64).contains(&m.uid.len())
        || !m.uid.bytes().all(|b| b.is_ascii_alphanumeric())
        || title.is_empty()
        || title.chars().count() > 120
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid model ID or name."));
    }
    let db = app.db.lock().map_err(db_error)?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM models WHERE user_id=? AND uid<>?",
            params![id, m.uid],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if count >= 1000 {
        return Err((StatusCode::CONFLICT, "Library limit reached (1000 models)."));
    }
    db.execute("INSERT INTO models(user_id,uid,title,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id,uid) DO UPDATE SET title=excluded.title",params![id,m.uid,title,now()]).map_err(db_error)?;
    Ok(Json(serde_json::json!({"ok":true})))
}
async fn delete_model(
    State(app): State<App>,
    headers: HeaderMap,
    Path(uid): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&app, &headers)?;
    let id = session_user(&app, &headers)?;
    app.db
        .lock()
        .map_err(db_error)?
        .execute(
            "DELETE FROM models WHERE user_id=? AND uid=?",
            params![id, uid],
        )
        .map_err(db_error)?;
    Ok(Json(serde_json::json!({"ok":true})))
}
#[derive(Deserialize, Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ConfigurationKind {
    Study,
    Sketchfab,
}
#[derive(Serialize)]
struct Configuration {
    id: String,
    title: String,
    kind: ConfigurationKind,
    settings: serde_json::Value,
    revision: i64,
    updated_at: i64,
}
#[derive(Deserialize)]
struct SaveConfiguration {
    title: String,
    kind: ConfigurationKind,
    settings: serde_json::Value,
    expected_revision: Option<i64>,
}
fn configuration(row: &rusqlite::Row<'_>) -> rusqlite::Result<Configuration> {
    let kind: String = row.get(2)?;
    let settings: String = row.get(3)?;
    Ok(Configuration {
        id: row.get(0)?,
        title: row.get(1)?,
        kind: if kind == "study" {
            ConfigurationKind::Study
        } else {
            ConfigurationKind::Sketchfab
        },
        settings: serde_json::from_str(&settings).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
        })?,
        revision: row.get(4)?,
        updated_at: row.get(5)?,
    })
}
fn validate_configuration(c: &SaveConfiguration) -> ApiResult<String> {
    if c.title.trim().is_empty() || c.title.trim().chars().count() > 120 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a name between 1 and 120 characters.",
        ));
    }
    let valid = match c.kind {
        ConfigurationKind::Study => {
            c.settings
                .get("version")
                .and_then(|v| v.as_u64())
                .is_some_and(|v| (1..=5).contains(&v))
                && c.settings.get("scene").is_some_and(|v| v.is_object())
                && c.settings.get("camera").is_some_and(|v| v.is_object())
        }
        ConfigurationKind::Sketchfab => {
            c.settings.get("version").and_then(|v| v.as_u64()) == Some(1)
                && c.settings
                    .get("uid")
                    .and_then(|v| v.as_str())
                    .is_some_and(|v| {
                        (1..=64).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_alphanumeric())
                    })
        }
    };
    let settings = serde_json::to_string(&c.settings).map_err(db_error)?;
    if !valid || settings.len() > 48 * 1024 {
        return Err((StatusCode::BAD_REQUEST, "Invalid saved settings."));
    }
    Ok(settings)
}
async fn list_configurations(
    State(app): State<App>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<serde_json::Value>>> {
    let user = session_user(&app, &headers)?;
    let db = app.db.lock().map_err(db_error)?;
    let mut stmt = db.prepare("SELECT id,title,kind,revision,updated_at FROM configurations WHERE user_id=? ORDER BY updated_at DESC,id").map_err(db_error)?;
    let rows = stmt.query_map([user], |r| Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"revision":r.get::<_,i64>(3)?,"updated_at":r.get::<_,i64>(4)?}))).map_err(db_error)?.collect::<Result<Vec<_>, _>>().map_err(db_error)?;
    Ok(Json(rows))
}
async fn get_configuration(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<Configuration>> {
    let user = session_user(&app, &headers)?;
    app.db.lock().map_err(db_error)?.query_row("SELECT id,title,kind,settings,revision,updated_at FROM configurations WHERE user_id=? AND id=?", params![user,id], configuration).map(Json).map_err(|e| match e { rusqlite::Error::QueryReturnedNoRows => (StatusCode::NOT_FOUND,"Save not found."), _ => db_error(e) })
}
async fn create_configuration(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<SaveConfiguration>,
) -> ApiResult<Json<Configuration>> {
    same_origin(&app, &headers)?;
    let user = session_user(&app, &headers)?;
    let settings = validate_configuration(&c)?;
    let id = token();
    let db = app.db.lock().map_err(db_error)?;
    let count: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM configurations WHERE user_id=?",
            [user],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if count >= 1000 {
        return Err((StatusCode::CONFLICT, "Library limit reached (1000 saves)."));
    }
    let kind = match c.kind {
        ConfigurationKind::Study => "study",
        ConfigurationKind::Sketchfab => "sketchfab",
    };
    db.execute("INSERT INTO configurations(id,user_id,title,kind,settings,revision,updated_at) VALUES(?,?,?,?,?,1,?)", params![id,user,c.title.trim(),kind,settings,now()]).map_err(db_error)?;
    db.query_row("SELECT id,title,kind,settings,revision,updated_at FROM configurations WHERE user_id=? AND id=?", params![user,id], configuration).map(Json).map_err(db_error)
}
async fn update_configuration(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(c): Json<SaveConfiguration>,
) -> ApiResult<Json<Configuration>> {
    same_origin(&app, &headers)?;
    let user = session_user(&app, &headers)?;
    let settings = validate_configuration(&c)?;
    let expected = c
        .expected_revision
        .filter(|v| *v > 0)
        .ok_or((StatusCode::BAD_REQUEST, "A save revision is required."))?;
    let kind = match c.kind {
        ConfigurationKind::Study => "study",
        ConfigurationKind::Sketchfab => "sketchfab",
    };
    let db = app.db.lock().map_err(db_error)?;
    let changed = db.execute("UPDATE configurations SET title=?,settings=?,revision=revision+1,updated_at=? WHERE user_id=? AND id=? AND kind=? AND revision=?", params![c.title.trim(),settings,now(),user,id,kind,expected]).map_err(db_error)?;
    if changed == 0 {
        let exists = db
            .query_row(
                "SELECT 1 FROM configurations WHERE user_id=? AND id=?",
                params![user, id],
                |_| Ok(()),
            )
            .is_ok();
        return Err(if exists {
            (
                StatusCode::CONFLICT,
                "This save changed in another tab or device. Open its latest version, or save your work as new.",
            )
        } else {
            (StatusCode::NOT_FOUND, "Save not found.")
        });
    }
    db.query_row("SELECT id,title,kind,settings,revision,updated_at FROM configurations WHERE user_id=? AND id=?", params![user,id], configuration).map(Json).map_err(db_error)
}
async fn delete_configuration(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    same_origin(&app, &headers)?;
    let user = session_user(&app, &headers)?;
    let changed = app
        .db
        .lock()
        .map_err(db_error)?
        .execute(
            "DELETE FROM configurations WHERE user_id=? AND id=?",
            params![user, id],
        )
        .map_err(db_error)?;
    if changed == 0 {
        return Err((StatusCode::NOT_FOUND, "Save not found."));
    }
    Ok(Json(serde_json::json!({"ok":true})))
}
fn migrate_configurations(db: &mut Connection) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS configurations(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('study','sketchfab')),settings TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS configurations_user ON configurations(user_id,updated_at); CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);")?;
    if tx
        .query_row(
            "SELECT 1 FROM schema_migrations WHERE version=1",
            [],
            |_| Ok(()),
        )
        .is_err()
    {
        // Preserve earlier named model references as saves with the default camera.
        let legacy = {
            let mut stmt = tx.prepare("SELECT user_id,uid,title,created_at FROM models")?;
            stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?
        };
        for (user, uid, title, created) in legacy {
            tx.execute("INSERT INTO configurations(id,user_id,title,kind,settings,revision,updated_at) VALUES(?,?,?,'sketchfab',?,1,?)", params![token(),user,title,serde_json::json!({"version":1,"uid":uid}).to_string(),created])?;
        }
        tx.execute("INSERT INTO schema_migrations(version) VALUES(1)", [])?;
    }
    tx.commit()
}
async fn account_options(State(app): State<App>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"signup_enabled":app.registration && app.mailer.enabled(),"email_enabled":app.mailer.enabled()}),
    )
}
#[derive(Deserialize)]
struct PasswordChange {
    current_password: String,
    new_password: String,
}
async fn change_password(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<PasswordChange>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    let user = session_user(&app, &headers)?;
    let (name, old): (String, String) = app
        .db
        .lock()
        .map_err(db_error)?
        .query_row(
            "SELECT username,password_hash FROM users WHERE id=?",
            [user],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    throttle(&app, &name)?;
    if c.current_password.len() > 1024
        || c.new_password.chars().count() < 12
        || c.new_password.len() > 1024
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a new password of at least 12 characters (maximum 1024 bytes).",
        ));
    }
    let permit = app.auth_slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication busy. Try again later.",
        )
    })?;
    let old_for_verification = old.clone();
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let parsed = PasswordHash::new(&old_for_verification).map_err(|_| UNAUTHORIZED)?;
        Argon2::default()
            .verify_password(c.current_password.as_bytes(), &parsed)
            .map_err(|_| (StatusCode::UNAUTHORIZED, "Current password is incorrect."))?;
        Argon2::default()
            .hash_password(c.new_password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|h| h.to_string())
            .map_err(db_error)
    })
    .await
    .map_err(db_error)??;
    {
        let mut db = app.db.lock().map_err(db_error)?;
        let tx = db.transaction().map_err(db_error)?;
        let changed = tx
            .execute(
                "UPDATE users SET password_hash=? WHERE id=? AND password_hash=?",
                params![hash, user, old],
            )
            .map_err(db_error)?;
        if changed != 1 {
            return Err((
                StatusCode::CONFLICT,
                "Password changed in another session. Sign in again.",
            ));
        }
        tx.execute("DELETE FROM email_tokens WHERE user_id=?", [user])
            .map_err(db_error)?;
        tx.execute("DELETE FROM sessions WHERE user_id=?", [user])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
    }
    guarded_session(&app, user, Some(&hash))
}
// Never allow shared proxy caches to retain account or library responses.
async fn private_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Cookie"));
    response
}
async fn health(State(app): State<App>) -> ApiResult<&'static str> {
    app.db
        .lock()
        .map_err(db_error)?
        .query_row("SELECT 1", [], |_| Ok(()))
        .map_err(db_error)?;
    Ok("ok")
}
fn valid_origin(origin: &str) -> bool {
    let Ok(uri) = origin.parse::<Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    if authority.as_str().contains('@')
        || origin.ends_with('/')
        || uri.path_and_query().is_some_and(|p| p.as_str() != "/")
    {
        return false;
    }
    uri.scheme_str() == Some("https")
        || (uri.scheme_str() == Some("http")
            && ["localhost", "127.0.0.1"].contains(&authority.host()))
}

// SQLite's online backup API includes committed WAL data without stopping writers.
fn backup_database(destination: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::unix::fs::OpenOptionsExt;
    let source = env::var("FORM_LAB_DATABASE").unwrap_or_else(|_| "form-lab.sqlite3".into());
    let db = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    // Refuse to overwrite a backup, database, or symlink. Restrict password-hash access.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)?;
    db.backup(rusqlite::MAIN_DB, destination, None)?;
    let snapshot =
        Connection::open_with_flags(destination, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result: String = snapshot.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if result != "ok" {
        return Err("Backup failed integrity check".into());
    }
    eprintln!("SQLite backup verified: {destination}");
    Ok(())
}
async fn response_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response.headers_mut().insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    response
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    if !args.is_empty() {
        if args.len() != 2 || args[0] != "backup" {
            return Err("Usage: form-lab-server [backup DESTINATION]".into());
        }
        backup_database(&args[1])?;
        return Ok(());
    }
    let origin = env::var("FORM_LAB_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:3000".into());
    if !valid_origin(&origin) {
        return Err("FORM_LAB_ORIGIN must be the exact HTTPS origin (or loopback HTTP), without a path, credentials, query or trailing slash".into());
    }
    let secure = origin.starts_with("https://");
    let path = env::var("FORM_LAB_DATABASE").unwrap_or_else(|_| "form-lab.sqlite3".into());
    // Create new local databases with private permissions, including their WAL files.
    use std::os::unix::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let mut db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS models(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,uid TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,uid)); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);")?;
    migrate_configurations(&mut db)?;
    email_accounts::migrate(&mut db)?;
    let mailer =
        mail::Mailer::from_env(&origin).map_err(|e| std::io::Error::other(e.to_string()))?;
    let app = App {
        db: Arc::new(Mutex::new(db)),
        origin,
        registration: match env::var("FORM_LAB_REGISTRATION_ENABLED")
            .unwrap_or_else(|_| "true".into())
            .as_str()
        {
            "true" => true,
            "false" => false,
            _ => return Err("FORM_LAB_REGISTRATION_ENABLED must be true or false".into()),
        },
        mailer,
        secure,
        attempts: Arc::new(Mutex::new(HashMap::new())),
        auth_slots: Arc::new(Semaphore::new(2)),
        dummy_hash: Argon2::default()
            .hash_password(token().as_bytes(), &SaltString::generate(&mut OsRng))
            .map_err(|e| std::io::Error::other(e.to_string()))?
            .to_string(),
    };
    let assets =
        PathBuf::from(env::var("FORM_LAB_ASSETS").unwrap_or_else(|_| "frontend/dist".into()));
    let static_files = ServeDir::new(&assets)
        .append_index_html_on_directories(true)
        .not_found_service(ServeFile::new(assets.join("index.html")));
    let api = Router::new()
        .route("/register", post(email_accounts::register))
        .route(
            "/register/complete",
            post(email_accounts::finish_registration),
        )
        .route("/recovery", post(email_accounts::recover))
        .route("/recovery/complete", post(email_accounts::finish_reset))
        .route("/email", post(email_accounts::request_email))
        .route("/email/complete", post(email_accounts::finish_email))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .route("/account-options", get(account_options))
        .route("/password", post(change_password))
        .route(
            "/configurations",
            get(list_configurations).post(create_configuration),
        )
        .route(
            "/configurations/{id}",
            get(get_configuration)
                .put(update_configuration)
                .delete(delete_configuration),
        )
        .route("/models", get(list_models).post(save_model))
        .route("/models/{uid}", delete(delete_model))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(private_response));
    let router = Router::new()
        .nest("/api", api)
        .route("/up", get(health))
        .fallback_service(static_files)
        .layer(middleware::from_fn(response_headers))
        .with_state(app);
    let address: SocketAddr = env::var("FORM_LAB_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3000".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("Form Lab listening on {address}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            #[cfg(unix)]
            {
                let mut term =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                        .expect("SIGTERM handler");
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
            }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_verified_old_password_cannot_issue_a_session_after_password_rotation() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE users(id INTEGER PRIMARY KEY,password_hash TEXT); CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER,expires_at INTEGER); INSERT INTO users VALUES(1,'rotated-hash');").unwrap();
        let app = App {
            db: Arc::new(Mutex::new(db)),
            origin: "http://127.0.0.1:3000".into(),
            registration: false,
            mailer: mail::Mailer::disabled(),
            secure: false,
            attempts: Arc::new(Mutex::new(HashMap::new())),
            auth_slots: Arc::new(Semaphore::new(2)),
            dummy_hash: String::new(),
        };
        assert_eq!(
            guarded_session(&app, 1, Some("old-verified-hash"))
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            app.db
                .lock()
                .unwrap()
                .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(guarded_session(&app, 1, Some("rotated-hash")).is_ok());
    }
    #[test]
    fn existing_model_references_migrate_once_without_loss_or_resurrection() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1); CREATE TABLE models(user_id INTEGER,uid TEXT,title TEXT,created_at INTEGER); INSERT INTO models VALUES(1,'model123','Original saved name',123);").unwrap();
        migrate_configurations(&mut db).unwrap();
        migrate_configurations(&mut db).unwrap();
        let (count, title, payload): (i64, String, String) = db
            .query_row(
                "SELECT COUNT(*),title,settings FROM configurations",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(count, 1);
        assert_eq!(title, "Original saved name");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            serde_json::json!({"version":1,"uid":"model123"})
        );
        db.execute("DELETE FROM configurations", []).unwrap();
        migrate_configurations(&mut db).unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM configurations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM models", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn origins_are_exact_and_public_origins_require_tls() {
        for origin in [
            "https://form-lab.example.com",
            "https://example.com:8443",
            "http://127.0.0.1:3000",
            "http://localhost:5173",
        ] {
            assert!(valid_origin(origin), "{origin}");
        }
        for origin in [
            "https://",
            "https://example.com/",
            "https://example.com/path",
            "https://example.com?x=1",
            "https://user@example.com",
            "http://localhost:123@evil.example",
            "http://example.com",
            "null",
        ] {
            assert!(!valid_origin(origin), "{origin}");
        }
    }
}
