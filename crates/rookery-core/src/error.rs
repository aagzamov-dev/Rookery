use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("vault is locked")]
    VaultLocked,
    #[error("vault not initialised")]
    VaultNotInitialised,
    #[error("wrong master password")]
    WrongPassword,
    #[error("wrong PIN, {attempts_left} tries left")]
    WrongPin { attempts_left: u32 },
    #[error("PIN disabled after too many attempts, use the master password")]
    PinDisabled,
    #[error("PIN is not set")]
    PinNotSet,
    #[error("too many wrong PINs, wait {seconds}s")]
    PinCooldown { seconds: u32 },
    #[error("keychain error: {0}")]
    Keychain(String),
    #[error("crypto error")]
    Crypto,

    #[error("ssh error: {0}")]
    Ssh(String),
    #[error("authentication failed")]
    AuthFailed,
    #[error("host key for {host} changed (expected {expected}, got {actual})")]
    HostKeyChanged {
        host: String,
        expected: String,
        actual: String,
    },
    #[error("unknown host key for {host}: {fingerprint}")]
    UnknownHostKey { host: String, fingerprint: String },
    #[error("secret required: {0}")]
    SecretRequired(String),

    #[error("not found: {0}")]
    NotFound(String),
    #[error("{0}")]
    Other(String),
}

impl From<russh::Error> for Error {
    fn from(e: russh::Error) -> Self {
        Error::Ssh(e.to_string())
    }
}

impl From<russh::keys::Error> for Error {
    fn from(e: russh::keys::Error) -> Self {
        Error::Ssh(e.to_string())
    }
}

/// Serialised as a tagged object so the frontend can match on `kind`.
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let kind = match self {
            Error::Db(_) | Error::Migration(_) => "db",
            Error::Io(_) => "io",
            Error::Json(_) => "json",
            Error::VaultLocked => "vault_locked",
            Error::VaultNotInitialised => "vault_not_initialised",
            Error::WrongPassword => "wrong_password",
            Error::WrongPin { .. } => "wrong_pin",
            Error::PinDisabled => "pin_disabled",
            Error::PinNotSet => "pin_not_set",
            Error::PinCooldown { .. } => "pin_cooldown",
            Error::Keychain(_) => "keychain",
            Error::Crypto => "crypto",
            Error::Ssh(_) => "ssh",
            Error::AuthFailed => "auth_failed",
            Error::HostKeyChanged { .. } => "host_key_changed",
            Error::UnknownHostKey { .. } => "unknown_host_key",
            Error::SecretRequired(_) => "secret_required",
            Error::NotFound(_) => "not_found",
            Error::Other(_) => "other",
        };
        let mut st = s.serialize_struct("Error", 5)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        let attempts_left = match self {
            Error::WrongPin { attempts_left } => Some(*attempts_left),
            _ => None,
        };
        st.serialize_field("attempts_left", &attempts_left)?;
        let cooldown_s = match self {
            Error::PinCooldown { seconds } => Some(*seconds),
            _ => None,
        };
        st.serialize_field("cooldown_s", &cooldown_s)?;
        let fingerprint = match self {
            Error::UnknownHostKey { fingerprint, .. } => Some(fingerprint.clone()),
            Error::HostKeyChanged { actual, .. } => Some(actual.clone()),
            _ => None,
        };
        st.serialize_field("fingerprint", &fingerprint)?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;
