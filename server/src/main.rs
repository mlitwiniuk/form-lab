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
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct App {
    db: Arc<Mutex<Connection>>,
    origin: String,
    signup: Option<String>,
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
fn make_session(app: &App, user_id: i64) -> ApiResult<Response> {
    let raw = token();
    let db = app.db.lock().map_err(db_error)?;
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
    username: String,
    password: String,
    #[serde(default)]
    signup_key: String,
}
fn throttle(app: &App, name: &str) -> ApiResult<()> {
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
    // A global budget also covers guessed usernames and invalid signup keys.
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
    if times.len() >= 8 {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "Too many attempts. Try again later.",
        ));
    }
    times.push(Instant::now());
    Ok(())
}
async fn register(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<Credentials>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    let name = username(&c.username)?;
    throttle(&app, &name)?;
    let expected = app
        .signup
        .as_ref()
        .ok_or((StatusCode::FORBIDDEN, "Account creation is disabled."))?;
    if digest(&c.signup_key)
        .as_bytes()
        .ct_eq(digest(expected).as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err((StatusCode::FORBIDDEN, "Invalid account creation key."));
    }
    if c.password.chars().count() < 12 || c.password.len() > 1024 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a password of at least 12 characters.",
        ));
    }
    let permit = app.auth_slots.clone().try_acquire_owned().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            "Authentication busy. Try again later.",
        )
    })?;
    let hash = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        Argon2::default()
            .hash_password(c.password.as_bytes(), &SaltString::generate(&mut OsRng))
            .map(|s| s.to_string())
            .map_err(db_error)
    })
    .await
    .map_err(db_error)??;
    let id = {
        let db = app.db.lock().map_err(db_error)?;
        db.execute(
            "INSERT INTO users(username,password_hash) VALUES(?,?)",
            params![name, hash],
        )
        .map_err(|_| (StatusCode::CONFLICT, "Could not create this account."))?;
        db.last_insert_rowid()
    };
    make_session(&app, id)
}
async fn login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(c): Json<Credentials>,
) -> ApiResult<Response> {
    same_origin(&app, &headers)?;
    let name = username(&c.username)?;
    throttle(&app, &name)?;
    if c.password.len() > 1024 {
        return Err(UNAUTHORIZED);
    }
    let user: Option<(i64, String)> = {
        let db = app.db.lock().map_err(db_error)?;
        db.query_row(
            "SELECT id,password_hash FROM users WHERE username=?",
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
    make_session(&app, id)
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
    let name: String = db
        .query_row("SELECT username FROM users WHERE id=?", [id], |r| r.get(0))
        .map_err(db_error)?;
    Ok(Json(serde_json::json!({"username":name})))
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
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(5))?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS models(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,uid TEXT NOT NULL,title TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,uid)); CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);")?;
    let app = App {
        db: Arc::new(Mutex::new(db)),
        origin,
        signup: env::var("FORM_LAB_SIGNUP_KEY")
            .ok()
            .filter(|s| s.len() >= 16),
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
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/logout", post(logout))
        .route("/me", get(me))
        .route("/models", get(list_models).post(save_model))
        .route("/models/{uid}", delete(delete_model))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(DefaultBodyLimit::max(16 * 1024))
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
