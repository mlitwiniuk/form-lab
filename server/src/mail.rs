use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor, message::Mailbox,
    transport::smtp::authentication::Credentials,
};
use std::{env, path::PathBuf, time::Duration};
use tokio::sync::mpsc;

type MailError = Box<dyn std::error::Error + Send + Sync>;
#[derive(Clone)]
pub struct Email {
    pub to: String,
    pub subject: String,
    pub body: String,
}
#[derive(Clone)]
pub struct Mailer {
    sender: Option<mpsc::Sender<Option<Email>>>,
}
enum Delivery {
    File(PathBuf),
    Mailgun {
        client: reqwest::Client,
        endpoint: String,
        key: String,
    },
    Smtp(Box<AsyncSmtpTransport<Tokio1Executor>>),
}
fn required(name: &str) -> Result<String, MailError> {
    env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| format!("Missing {name}").into())
}
impl Mailer {
    pub fn disabled() -> Self {
        Self { sender: None }
    }
    pub fn enabled(&self) -> bool {
        self.sender.is_some()
    }
    // Reserve before looking up the address so queue pressure cannot disclose account existence.
    pub fn reserve(&self) -> Result<mpsc::Permit<'_, Option<Email>>, &'static str> {
        self.sender
            .as_ref()
            .ok_or("Email delivery is unavailable.")?
            .try_reserve()
            .map_err(|_| "Email delivery is busy. Please try again shortly.")
    }
    pub fn from_env(origin: &str) -> Result<Self, MailError> {
        let mode = env::var("FORM_LAB_MAIL_TRANSPORT").unwrap_or_else(|_| "disabled".into());
        if mode == "disabled" {
            return Ok(Self::disabled());
        }
        let from: Mailbox = required("FORM_LAB_MAIL_FROM")?
            .parse()
            .map_err(|_| "Invalid FORM_LAB_MAIL_FROM")?;
        let delivery = match mode.as_str() {
            "file" => {
                if !(origin.starts_with("http://127.0.0.1:")
                    || origin.starts_with("http://localhost:"))
                {
                    return Err(
                        "File email delivery is only allowed on a loopback HTTP origin".into(),
                    );
                }
                let directory = PathBuf::from(required("FORM_LAB_MAIL_DIRECTORY")?);
                std::fs::create_dir_all(&directory)?;
                Delivery::File(directory)
            }
            "mailgun" => {
                let host = match env::var("FORM_LAB_MAILGUN_REGION")
                    .unwrap_or_else(|_| "us".into())
                    .as_str()
                {
                    "us" => "api.mailgun.net",
                    "eu" => "api.eu.mailgun.net",
                    _ => return Err("FORM_LAB_MAILGUN_REGION must be us or eu".into()),
                };
                let domain = required("FORM_LAB_MAILGUN_DOMAIN")?;
                if domain.len() > 253
                    || !domain
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.')
                {
                    return Err("Invalid FORM_LAB_MAILGUN_DOMAIN".into());
                }
                Delivery::Mailgun {
                    client: reqwest::Client::builder()
                        .https_only(true)
                        .redirect(reqwest::redirect::Policy::none())
                        .timeout(Duration::from_secs(15))
                        .build()?,
                    endpoint: format!("https://{host}/v3/{domain}/messages"),
                    key: required("FORM_LAB_MAILGUN_API_KEY")?,
                }
            }
            "smtp" => {
                let host = required("FORM_LAB_SMTP_HOST")?;
                let port: u16 = env::var("FORM_LAB_SMTP_PORT")
                    .unwrap_or_else(|_| "465".into())
                    .parse()?;
                // relay() always uses implicit TLS, verified against the relay hostname. No plaintext fallback.
                let transport = AsyncSmtpTransport::<Tokio1Executor>::relay(&host)?
                    .port(port)
                    .credentials(Credentials::new(
                        required("FORM_LAB_SMTP_USERNAME")?,
                        required("FORM_LAB_SMTP_PASSWORD")?,
                    ))
                    .timeout(Some(Duration::from_secs(15)))
                    .build();
                Delivery::Smtp(Box::new(transport))
            }
            _ => {
                return Err(
                    "FORM_LAB_MAIL_TRANSPORT must be disabled, mailgun, smtp or file".into(),
                );
            }
        };
        let (sender, mut receiver) = mpsc::channel::<Option<Email>>(64);
        tokio::spawn(async move {
            while let Some(job) = receiver.recv().await {
                let Some(email) = job else {
                    continue;
                };
                let mut delivered = false;
                for attempt in 0..3 {
                    if matches!(
                        tokio::time::timeout(Duration::from_secs(20), delivery.send(&from, &email))
                            .await,
                        Ok(Ok(()))
                    ) {
                        delivered = true;
                        break;
                    }
                    if attempt < 2 {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
                // Never log credentials, recipients, provider response bodies, or action links.
                if !delivered {
                    eprintln!(
                        "Account email delivery failed after three attempts; check mail configuration/provider status. The user can request a new link."
                    );
                }
            }
        });
        Ok(Self {
            sender: Some(sender),
        })
    }
}
impl Delivery {
    async fn send(&self, from: &Mailbox, email: &Email) -> Result<(), MailError> {
        match self {
            Self::File(directory) => {
                use std::{io::Write, os::unix::fs::OpenOptionsExt};
                let path = directory.join(format!("{}.eml", crate::token()));
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(path)?;
                // Plain UTF-8 makes local links easy to inspect; production SMTP uses Lettre's MIME builder.
                write!(
                    file,
                    "From: {from}\nTo: {}\nSubject: {}\nContent-Type: text/plain; charset=utf-8\n\n{}",
                    email.to, email.subject, email.body
                )?;
            }
            Self::Mailgun {
                client,
                endpoint,
                key,
            } => {
                let form = reqwest::multipart::Form::new()
                    .text("from", from.to_string())
                    .text("to", email.to.clone())
                    .text("subject", email.subject.clone())
                    .text("text", email.body.clone())
                    .text("o:tracking", "no")
                    .text("o:tracking-clicks", "no")
                    .text("o:tracking-opens", "no");
                client
                    .post(endpoint)
                    .basic_auth("api", Some(key))
                    .multipart(form)
                    .send()
                    .await?
                    .error_for_status()?;
            }
            Self::Smtp(transport) => {
                let message = Message::builder()
                    .from(from.clone())
                    .to(email.to.parse()?)
                    .subject(&email.subject)
                    .raw_header(lettre::message::header::HeaderValue::new(
                        lettre::message::header::HeaderName::new_from_ascii_str("X-Mailgun-Track"),
                        "no".into(),
                    ))
                    .raw_header(lettre::message::header::HeaderValue::new(
                        lettre::message::header::HeaderName::new_from_ascii_str(
                            "X-Mailgun-Track-Clicks",
                        ),
                        "no".into(),
                    ))
                    .raw_header(lettre::message::header::HeaderValue::new(
                        lettre::message::header::HeaderName::new_from_ascii_str(
                            "X-Mailgun-Track-Opens",
                        ),
                        "no".into(),
                    ))
                    .body(email.body.clone())?;
                transport.send(message).await?;
            }
        }
        Ok(())
    }
}
