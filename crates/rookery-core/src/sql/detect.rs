//! Shortcuts into SQL (docs/07 §2.4): Docker "Open in SQL", Laravel `.env` import and
//! "Find databases on this PC". They only fill in a form; none of them ever returns a password.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;
use serde_json::Value;
use ts_rs::TS;

use super::{default_port, manager::parse_url};
use crate::collectors::valid_container_ref;
use crate::model::DbEngine;
use crate::ssh::{exec, ConnectionManager};
use crate::{Error, Result};

/// Connection settings found by a shortcut. Never holds a password.
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct SqlPrefill {
    /// Suggested connection name (container name, app name…).
    pub name: String,
    pub engine: DbEngine,
    pub address: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    /// Where the address came from ("published port 5433", "container IP on bridge"…).
    pub note: Option<String>,
    /// Where the password can be found (an env variable name), shown as a hint. The value is never read.
    pub password_hint: Option<String>,
    /// `.env` import: the file has a password. Rust keeps it in memory for a while under this
    /// reference; it is used only when the user ticks "use password from .env".
    pub password_ref: Option<String>,
}

/// Where to read a Laravel `.env` from.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EnvSource {
    /// A file on this computer (file picker).
    Local { path: String },
    /// A file on a saved server, read through SFTP.
    Remote { host_id: String, path: String },
}

// ------------------------------------------------------------------ Docker

/// Engine of a database image (`postgres:16`, `bitnami/mysql`, `mariadb:11`…).
pub fn engine_of_image(image: &str) -> Option<DbEngine> {
    let name = image.rsplit('/').next().unwrap_or(image);
    let name = name.split([':', '@']).next().unwrap_or(name).to_ascii_lowercase();
    if name.contains("exporter") {
        return None; // prometheus mysqld-exporter / postgres-exporter
    }
    if ["postgres", "postgis", "timescale"].iter().any(|k| name.contains(k)) {
        Some(DbEngine::Postgres)
    } else if ["mysql", "mariadb", "percona"].iter().any(|k| name.contains(k)) {
        Some(DbEngine::Mysql)
    } else {
        None
    }
}

/// Read a `docker inspect <container>` JSON: engine from the image, user and database from
/// the env, and the address as seen from the Docker host (published port first, then the
/// container IP). Password variables are only named in `password_hint`, never read.
pub fn parse_docker_inspect(json: &str) -> Result<SqlPrefill> {
    let v: Value = serde_json::from_str(json.trim()).map_err(|_| Error::Other(format!("docker inspect: {}", first_line(json))))?;
    prefill_of_container(v.as_array().and_then(|a| a.first()).unwrap_or(&v))
}

/// One container object of `docker inspect` output.
fn prefill_of_container(c: &Value) -> Result<SqlPrefill> {
    let image = c["Config"]["Image"].as_str().unwrap_or_default();
    let engine = engine_of_image(image).ok_or_else(|| Error::Other(format!("{image} is not a PostgreSQL, MySQL or MariaDB image")))?;
    let name = c["Name"].as_str().unwrap_or_default().trim_start_matches('/').to_string();
    let env: Vec<(&str, &str)> = c["Config"]["Env"]
        .as_array()
        .map(|a| a.iter().filter_map(|e| e.as_str()?.split_once('=')).collect())
        .unwrap_or_default();
    let get = |keys: &[&str]| keys.iter().find_map(|k| env.iter().find(|(n, v)| n == k && !v.is_empty()).map(|(_, v)| v.to_string()));
    let has = |k: &str| env.iter().any(|(n, _)| *n == k);

    let (user, database, password_hint) = match engine {
        DbEngine::Postgres => {
            let user = get(&["POSTGRES_USER", "POSTGRESQL_USERNAME"]).unwrap_or_else(|| "postgres".into());
            let db = get(&["POSTGRES_DB", "POSTGRESQL_DATABASE"]).unwrap_or_else(|| user.clone());
            let hint = ["POSTGRES_PASSWORD", "POSTGRES_PASSWORD_FILE", "POSTGRESQL_PASSWORD"].into_iter().find(|k| has(k));
            (user, Some(db), hint)
        }
        DbEngine::Mysql => {
            let app_user = get(&["MYSQL_USER", "MARIADB_USER"]);
            let db = get(&["MYSQL_DATABASE", "MARIADB_DATABASE"]);
            let hint = if app_user.is_some() {
                ["MYSQL_PASSWORD", "MARIADB_PASSWORD", "MYSQL_PASSWORD_FILE", "MARIADB_PASSWORD_FILE"].into_iter().find(|k| has(k))
            } else {
                ["MYSQL_ROOT_PASSWORD", "MARIADB_ROOT_PASSWORD", "MYSQL_ROOT_PASSWORD_FILE", "MARIADB_ROOT_PASSWORD_FILE"].into_iter().find(|k| has(k))
            };
            (app_user.unwrap_or_else(|| "root".into()), db, hint)
        }
    };

    // The port inside the container: the engine's default when exposed, else the first exposed TCP port.
    let default = default_port(engine);
    let exposed: Vec<u16> = c["Config"]["ExposedPorts"]
        .as_object()
        .map(|m| m.keys().filter_map(|k| k.strip_suffix("/tcp")?.parse().ok()).collect())
        .unwrap_or_default();
    let inner = if exposed.is_empty() || exposed.contains(&default) { default } else { exposed[0] };

    let net = &c["NetworkSettings"];
    let published = net["Ports"][format!("{inner}/tcp")].as_array().and_then(|binds| {
        binds.iter().find_map(|b| {
            let port: u16 = b["HostPort"].as_str()?.parse().ok()?;
            let ip = b["HostIp"].as_str().unwrap_or_default();
            let addr = if matches!(ip, "" | "0.0.0.0" | "::" | "127.0.0.1" | "::1") { "127.0.0.1" } else { ip };
            Some((addr.to_string(), port))
        })
    });
    let host_mode = c["HostConfig"]["NetworkMode"].as_str() == Some("host");
    let container_ip = net["Networks"]
        .as_object()
        .and_then(|m| m.iter().find_map(|(n, x)| x["IPAddress"].as_str().filter(|ip| !ip.is_empty()).map(|ip| (n.clone(), ip.to_string()))))
        .or_else(|| net["IPAddress"].as_str().filter(|ip| !ip.is_empty()).map(|ip| ("bridge".to_string(), ip.to_string())));

    let (address, port, note) = if let Some((addr, port)) = published {
        (addr, port, format!("published port {port}"))
    } else if host_mode {
        ("127.0.0.1".into(), inner, "host network".into())
    } else if let Some((net_name, ip)) = container_ip {
        (ip, inner, format!("container IP on {net_name}"))
    } else {
        return Err(Error::Other(format!("{name} has no published port and no IP address (is it running?)")));
    };

    Ok(SqlPrefill {
        name: if name.is_empty() { image.to_string() } else { name },
        engine,
        address,
        port,
        user,
        database,
        note: Some(note),
        password_hint: password_hint.map(|k| format!("{k} in the container's settings")),
        password_ref: None,
    })
}

// ------------------------------------------------------------- Laravel .env

/// Biggest `.env` file we read.
pub const ENV_MAX_BYTES: u64 = 256 * 1024;

/// `KEY=value` lines of a dotenv file: comments, `export`, single / double quotes,
/// `value # comment`. No `${VAR}` expansion.
pub fn parse_dotenv(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let l = l.strip_prefix("export ").map(str::trim_start).unwrap_or(l);
        let Some((k, v)) = l.split_once('=') else { continue };
        let k = k.trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.') {
            continue;
        }
        let v = v.trim();
        let value = if let Some(rest) = v.strip_prefix('"') {
            let mut s = String::new();
            let mut chars = rest.chars();
            while let Some(c) = chars.next() {
                match c {
                    '"' => break,
                    '\\' => match chars.next() {
                        Some('n') => s.push('\n'),
                        Some('t') => s.push('\t'),
                        Some(o) => s.push(o),
                        None => s.push('\\'),
                    },
                    c => s.push(c),
                }
            }
            s
        } else if let Some(rest) = v.strip_prefix('\'') {
            rest.split('\'').next().unwrap_or_default().to_string()
        } else {
            let cut = v.find(" #").or_else(|| v.find("\t#")).unwrap_or(v.len());
            v[..cut].trim_end().to_string()
        };
        out.push((k.to_string(), value));
    }
    out
}

/// What a Laravel `.env` says about its database. The password stays in Rust.
pub struct EnvDb {
    pub prefill: SqlPrefill,
    pub password: Option<Zeroizing<String>>,
}

/// `DB_CONNECTION, DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME` (or `DB_URL`), and `DB_PASSWORD` kept aside.
pub fn parse_laravel_env(text: &str) -> Result<EnvDb> {
    let vars = parse_dotenv(text);
    let get = |k: &str| vars.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty());
    let url = get("DB_URL").or_else(|| get("DATABASE_URL"));
    let from_url = url.as_deref().and_then(|u| parse_url(u).ok()).map(|p| p.params);
    let engine = match get("DB_CONNECTION").map(|c| c.to_ascii_lowercase()).as_deref() {
        Some("mysql" | "mariadb") => DbEngine::Mysql,
        Some("pgsql" | "postgres" | "postgresql") => DbEngine::Postgres,
        Some(other) => return Err(Error::Other(format!("this .env uses DB_CONNECTION={other}; Rookery opens MySQL, MariaDB and PostgreSQL"))),
        None => match &from_url {
            Some(p) => p.engine,
            None => return Err(Error::Other("no DB_CONNECTION in this file (is it a Laravel .env?)".into())),
        },
    };
    let host = get("DB_HOST").or_else(|| from_url.as_ref().map(|p| p.host.clone())).unwrap_or_else(|| "127.0.0.1".into());
    let port = get("DB_PORT").and_then(|p| p.parse().ok()).or_else(|| from_url.as_ref().map(|p| p.port)).unwrap_or(default_port(engine));
    let user = get("DB_USERNAME")
        .or_else(|| from_url.as_ref().map(|p| p.user.clone()))
        .unwrap_or_else(|| if engine == DbEngine::Mysql { "root".into() } else { "postgres".into() });
    let database = get("DB_DATABASE").or_else(|| from_url.as_ref().and_then(|p| p.database.clone()));
    let password = get("DB_PASSWORD").map(Zeroizing::new).or_else(|| from_url.and_then(|p| p.password));
    let app = get("APP_NAME").filter(|n| n != "Laravel");
    let name = match (&app, &database) {
        (Some(a), _) => a.clone(),
        (None, Some(d)) => d.clone(),
        (None, None) => "Laravel".into(),
    };
    // Sail / compose: DB_HOST=mysql is a service name that only resolves inside the Docker network.
    let service_name = !host.contains('.') && !host.contains(':') && host != "localhost";
    let note = service_name.then(|| format!("DB_HOST \"{host}\" looks like a Docker service name; from outside Docker use 127.0.0.1 and the published port"));
    Ok(EnvDb {
        prefill: SqlPrefill { name, engine, address: host, port, user, database, note, password_hint: None, password_ref: None },
        password,
    })
}

/// Read a `.env` (local file or through SFTP) and parse it.
pub async fn read_env(sftp: &crate::sftp::Sftp, source: &EnvSource) -> Result<EnvDb> {
    let bytes = match source {
        EnvSource::Local { path } => {
            let path = std::path::PathBuf::from(path);
            let len = tokio::fs::metadata(&path).await?.len();
            if len > ENV_MAX_BYTES {
                return Err(Error::Other("this file is too big for a .env".into()));
            }
            tokio::fs::read(&path).await?
        }
        EnvSource::Remote { host_id, path } => sftp.read_small(host_id, path.trim(), ENV_MAX_BYTES).await?,
    };
    parse_laravel_env(&String::from_utf8_lossy(&bytes))
}

/// One `docker inspect` on the server (through its SSH session) → prefill for its Database view.
pub async fn docker_inspect(conns: &ConnectionManager, host_id: &str, container: &str) -> Result<SqlPrefill> {
    if !valid_container_ref(container) {
        return Err(Error::Other("invalid container".into()));
    }
    let lease = conns.acquire(host_id).await?;
    let h = lease.handle().await?;
    let out = exec(&h, &format!("docker inspect --type container {container} 2>&1"), Duration::from_secs(20)).await?;
    if out.exit.unwrap_or(0) != 0 {
        return Err(Error::Other(first_line(&out.stdout)));
    }
    parse_docker_inspect(&out.stdout)
}

// ------------------------------------------------------ databases on this PC

/// A database found on this computer ("Add MySQL on localhost:3306?").
#[derive(Debug, Clone, PartialEq, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct LocalDb {
    pub engine: DbEngine,
    pub port: u16,
    /// From the server's greeting: "MySQL 8.4.2", "MariaDB 10.4.32", "PostgreSQL".
    pub product: String,
    /// The Docker container that publishes this port: "shop-db-1 (postgres:16)".
    pub container: Option<String>,
    /// Suggested login: from the container's settings, else XAMPP / Laragon / Postgres defaults.
    pub user: String,
    pub database: Option<String>,
    pub hint: Option<String>,
}

/// Ports tried on 127.0.0.1 (MySQL / MariaDB, PostgreSQL, and their usual second instance).
pub const LOCAL_PORTS: [u16; 4] = [3306, 3307, 5432, 5433];
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

/// MySQL / MariaDB greeting (the server speaks first): "MySQL 8.4.2" / "MariaDB 11.4.2".
pub fn parse_mysql_greeting(b: &[u8]) -> Option<String> {
    if b.len() < 6 {
        return None;
    }
    match b[4] {
        // protocol 10: NUL-terminated version
        0x0a => {
            let end = b[5..].iter().position(|&x| x == 0)? + 5;
            let v = std::str::from_utf8(&b[5..end]).ok()?;
            let v = v.strip_prefix("5.5.5-").unwrap_or(v);
            Some(match v.find("-MariaDB") {
                Some(i) => format!("MariaDB {}", &v[..i]),
                None if v.to_ascii_lowercase().contains("mariadb") => format!("MariaDB {}", v.split('-').next().unwrap_or(v)),
                None => format!("MySQL {}", v.split('-').next().unwrap_or(v)),
            })
        }
        // error packet first ("Host '…' is not allowed to connect"): still MySQL
        0xff if b.len() > 7 => Some("MySQL / MariaDB".into()),
        _ => None,
    }
}

/// Is something on this local port, and which database is it?
async fn probe(port: u16) -> Option<(DbEngine, String)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut s = tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(("127.0.0.1", port))).await.ok()?.ok()?;
    let mut buf = [0u8; 256];
    match tokio::time::timeout(PROBE_TIMEOUT, s.read(&mut buf)).await {
        Ok(Ok(n)) if n > 0 => parse_mysql_greeting(&buf[..n]).map(|p| (DbEngine::Mysql, p)),
        Ok(_) => None,
        // Silent: ask like a Postgres client would (SSLRequest); it answers 'S' or 'N'.
        Err(_) => {
            s.write_all(&[0, 0, 0, 8, 4, 0xd2, 0x16, 0x2f]).await.ok()?;
            let mut one = [0u8; 1];
            match tokio::time::timeout(PROBE_TIMEOUT, s.read(&mut one)).await {
                Ok(Ok(1)) if one[0] == b'S' || one[0] == b'N' => Some((DbEngine::Postgres, "PostgreSQL".into())),
                _ => None,
            }
        }
    }
}

/// `docker ps` ports column → published host ports: "0.0.0.0:5433->5432/tcp, :::5433->5432/tcp" → [(5433, 5432)].
pub fn parse_published_ports(ports: &str) -> Vec<(u16, u16)> {
    let mut out = Vec::new();
    for part in ports.split(',') {
        let Some((host, inner)) = part.trim().split_once("->") else { continue };
        let Some(inner) = inner.strip_suffix("/tcp").and_then(|p| p.parse::<u16>().ok()) else { continue };
        let Some(hp) = host.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) else { continue };
        if !out.contains(&(hp, inner)) {
            out.push((hp, inner));
        }
    }
    out
}

/// Run the local `docker` CLI (no console window on Windows). None = not installed / not running.
async fn local_docker(args: &[&str]) -> Option<String> {
    let candidates: &[&str] = if cfg!(target_os = "macos") {
        // Apps started from Finder don't get the shell's PATH.
        &["docker", "/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker"]
    } else {
        &["docker"]
    };
    for exe in candidates {
        let mut cmd = tokio::process::Command::new(exe);
        cmd.args(args).kill_on_drop(true).stdin(std::process::Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        match tokio::time::timeout(Duration::from_secs(4), cmd.output()).await {
            Ok(Ok(out)) if out.status.success() => return Some(String::from_utf8_lossy(&out.stdout).into_owned()),
            Ok(Ok(_)) => return None, // docker is there but the daemon is not running
            Ok(Err(_)) => continue,   // not found here
            Err(_) => return None,    // hangs: give up
        }
    }
    None
}

/// Databases published by local Docker containers: (host port, container label, prefill from inspect).
async fn docker_databases() -> Vec<(u16, String, Option<SqlPrefill>)> {
    let Some(ps) = local_docker(&["ps", "--format", "{{.Names}}\t{{.Image}}\t{{.Ports}}"]).await else { return vec![] };
    let mut found = Vec::new();
    for line in ps.lines() {
        let mut cols = line.split('\t');
        let (Some(name), Some(image), Some(ports)) = (cols.next(), cols.next(), cols.next()) else { continue };
        let Some(engine) = engine_of_image(image) else { continue };
        let ports = parse_published_ports(ports);
        let want = default_port(engine);
        let pick = ports.iter().find(|(_, inner)| *inner == want).or(ports.first());
        if let Some((host_port, _)) = pick {
            found.push((name.to_string(), image.to_string(), *host_port));
        }
    }
    if found.is_empty() {
        return vec![];
    }
    // One inspect for all of them: user and database from their settings (never the password).
    let mut args = vec!["inspect", "--type", "container"];
    args.extend(found.iter().map(|(n, _, _)| n.as_str()));
    let inspected: Vec<Value> = match local_docker(&args).await {
        Some(json) => serde_json::from_str::<Value>(&json).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        None => vec![],
    };
    found
        .into_iter()
        .map(|(name, image, port)| {
            let prefill = inspected
                .iter()
                .find(|c| c["Name"].as_str().map(|n| n.trim_start_matches('/')) == Some(name.as_str()))
                .and_then(|c| prefill_of_container(c).ok());
            (port, format!("{name} ({image})"), prefill)
        })
        .collect()
}

/// "Find databases on this PC": probe 127.0.0.1 on the usual ports (300 ms each, in parallel)
/// plus the ports local Docker containers publish. Only ports that answer like a database count.
pub async fn detect_local() -> Vec<LocalDb> {
    let docker = docker_databases().await;
    let mut ports: Vec<u16> = LOCAL_PORTS.to_vec();
    for (p, _, _) in &docker {
        if !ports.contains(p) {
            ports.push(*p);
        }
    }
    let mut set = tokio::task::JoinSet::new();
    for port in ports.clone() {
        set.spawn(async move { (port, probe(port).await) });
    }
    let mut answers = std::collections::HashMap::new();
    while let Some(Ok((port, found))) = set.join_next().await {
        if let Some(f) = found {
            answers.insert(port, f);
        }
    }
    ports
        .into_iter()
        .filter_map(|port| {
            let (engine, product) = answers.remove(&port)?;
            let from_docker = docker.iter().find(|(p, _, _)| *p == port);
            let (user, database, hint) = match from_docker.and_then(|(_, _, pf)| pf.as_ref()) {
                Some(pf) => (pf.user.clone(), pf.database.clone(), pf.password_hint.as_ref().map(|h| format!("Password: {h}"))),
                None => match engine {
                    DbEngine::Mysql => ("root".to_string(), None, Some("XAMPP / Laragon: user root, no password".to_string())),
                    DbEngine::Postgres => ("postgres".to_string(), None, Some("The password you chose when installing PostgreSQL".to_string())),
                },
            };
            Some(LocalDb { engine, port, product, container: from_docker.map(|(_, c, _)| c.clone()), user, database, hint })
        })
        .collect()
}

fn first_line(s: &str) -> String {
    s.trim().lines().next().unwrap_or("no output").chars().take(200).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PG: &str = r#"[{
        "Name": "/shop-db-1",
        "Config": {
            "Image": "postgres:16-alpine",
            "Env": ["POSTGRES_USER=shop", "POSTGRES_PASSWORD=very-secret", "POSTGRES_DB=shop_prod", "PATH=/usr/bin"],
            "ExposedPorts": {"5432/tcp": {}}
        },
        "HostConfig": {"NetworkMode": "shop_default"},
        "NetworkSettings": {
            "IPAddress": "",
            "Ports": {"5432/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5433"}, {"HostIp": "::", "HostPort": "5433"}]},
            "Networks": {"shop_default": {"IPAddress": "172.18.0.2"}}
        }
    }]"#;

    #[test]
    fn postgres_with_a_published_port() {
        let p = parse_docker_inspect(PG).unwrap();
        assert_eq!(p.password_ref, None);
        assert_eq!(p.engine, DbEngine::Postgres);
        assert_eq!((p.address.as_str(), p.port), ("127.0.0.1", 5433));
        assert_eq!((p.user.as_str(), p.database.as_deref()), ("shop", Some("shop_prod")));
        assert_eq!(p.name, "shop-db-1");
        assert_eq!(p.password_hint.as_deref(), Some("POSTGRES_PASSWORD in the container's settings"));
        assert!(!format!("{p:?}").contains("very-secret"), "the password is never read");
    }

    #[test]
    fn mysql_on_the_container_ip() {
        let json = r#"[{"Name": "/mysql", "Config": {"Image": "mysql:8.4", "Env": ["MYSQL_ROOT_PASSWORD=x", "MYSQL_DATABASE=app"], "ExposedPorts": {"3306/tcp": {}, "33060/tcp": {}}},
            "HostConfig": {"NetworkMode": "bridge"},
            "NetworkSettings": {"IPAddress": "172.17.0.3", "Ports": {"3306/tcp": null, "33060/tcp": null}, "Networks": {"bridge": {"IPAddress": "172.17.0.3"}}}}]"#;
        let p = parse_docker_inspect(json).unwrap();
        assert_eq!((p.engine, p.address.as_str(), p.port), (DbEngine::Mysql, "172.17.0.3", 3306));
        assert_eq!((p.user.as_str(), p.database.as_deref()), ("root", Some("app")));
        assert_eq!(p.password_hint.as_deref(), Some("MYSQL_ROOT_PASSWORD in the container's settings"));
        assert_eq!(p.note.as_deref(), Some("container IP on bridge"));
    }

    #[test]
    fn mariadb_app_user_and_host_network() {
        let json = r#"[{"Name": "/db", "Config": {"Image": "docker.io/library/mariadb:11.4", "Env": ["MARIADB_USER=app", "MARIADB_PASSWORD=x", "MARIADB_DATABASE=wp"]},
            "HostConfig": {"NetworkMode": "host"}, "NetworkSettings": {"IPAddress": "", "Ports": {}, "Networks": {"host": {"IPAddress": ""}}}}]"#;
        let p = parse_docker_inspect(json).unwrap();
        assert_eq!((p.address.as_str(), p.port, p.user.as_str()), ("127.0.0.1", 3306, "app"));
        assert_eq!(p.password_hint.as_deref(), Some("MARIADB_PASSWORD in the container's settings"));
    }

    #[test]
    fn dotenv_lines() {
        let v = parse_dotenv("# c\nA=1\nexport B = \"two words\" # x\nC='it''s'\nD=plain # comment\nE=\"q\\\"uote\"\nbad line\nF=\n");
        let get = |k: &str| v.iter().find(|(n, _)| n == k).map(|(_, x)| x.as_str());
        assert_eq!(get("A"), Some("1"));
        assert_eq!(get("B"), Some("two words"));
        assert_eq!(get("C"), Some("it"));
        assert_eq!(get("D"), Some("plain"));
        assert_eq!(get("E"), Some("q\"uote"));
        assert_eq!(get("F"), Some(""));
        assert_eq!(v.len(), 6);
    }

    #[test]
    fn laravel_env() {
        let env = "APP_NAME=\"Shop API\"\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_PORT=3307\nDB_DATABASE=shop\nDB_USERNAME=shop\nDB_PASSWORD=\"s3cr#t\"\n";
        let e = parse_laravel_env(env).unwrap();
        assert_eq!(e.prefill.name, "Shop API");
        assert_eq!((e.prefill.engine, e.prefill.address.as_str(), e.prefill.port), (DbEngine::Mysql, "127.0.0.1", 3307));
        assert_eq!((e.prefill.user.as_str(), e.prefill.database.as_deref()), ("shop", Some("shop")));
        assert_eq!(e.password.as_deref().map(|s| s.as_str()), Some("s3cr#t"));
        assert!(e.prefill.note.is_none());
        assert!(!format!("{:?}", e.prefill).contains("s3cr"), "the prefill never holds the password");

        // Sail: pgsql on a compose service name, no password
        let e = parse_laravel_env("APP_NAME=Laravel\nDB_CONNECTION=pgsql\nDB_HOST=pgsql\nDB_DATABASE=laravel\nDB_USERNAME=sail\nDB_PASSWORD=\n").unwrap();
        assert_eq!((e.prefill.engine, e.prefill.port, e.prefill.name.as_str()), (DbEngine::Postgres, 5432, "laravel"));
        assert!(e.password.is_none());
        assert!(e.prefill.note.unwrap().contains("service name"));

        // DB_URL only
        let e = parse_laravel_env("DB_URL=postgres://app:pw@db.example.com:6543/app\n").unwrap();
        assert_eq!((e.prefill.address.as_str(), e.prefill.port, e.prefill.user.as_str()), ("db.example.com", 6543, "app"));
        assert_eq!(e.password.as_deref().map(|s| s.as_str()), Some("pw"));

        assert!(parse_laravel_env("DB_CONNECTION=sqlite\n").err().unwrap().to_string().contains("sqlite"));
        assert!(parse_laravel_env("FOO=bar\n").is_err());
    }

    #[test]
    fn greetings_and_ports() {
        let mut my = vec![0x4a, 0, 0, 0, 0x0a];
        my.extend_from_slice(b"8.4.2\0rest");
        assert_eq!(parse_mysql_greeting(&my).as_deref(), Some("MySQL 8.4.2"));
        let mut maria = vec![0x4a, 0, 0, 0, 0x0a];
        maria.extend_from_slice(b"5.5.5-10.4.32-MariaDB\0rest");
        assert_eq!(parse_mysql_greeting(&maria).as_deref(), Some("MariaDB 10.4.32"));
        let mut maria11 = vec![0x4a, 0, 0, 0, 0x0a];
        maria11.extend_from_slice(b"11.4.2-MariaDB-ubu2404\0");
        assert_eq!(parse_mysql_greeting(&maria11).as_deref(), Some("MariaDB 11.4.2"));
        assert_eq!(parse_mysql_greeting(b"HTTP/1.1 400 Bad Request"), None);

        assert_eq!(parse_published_ports("0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp"), vec![(5433, 5432)]);
        assert_eq!(parse_published_ports("127.0.0.1:3307->3306/tcp, 33060/tcp"), vec![(3307, 3306)]);
        assert!(parse_published_ports("5432/tcp").is_empty());
        assert!(parse_published_ports("").is_empty());
    }

    #[tokio::test]
    async fn probe_tells_databases_from_other_servers() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // a fake Postgres: silent, then answers the SSLRequest with 'N'
        let pg = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let pg_port = pg.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = pg.accept().await.unwrap();
            let mut b = [0u8; 8];
            s.read_exact(&mut b).await.unwrap();
            assert_eq!(b, [0, 0, 0, 8, 4, 0xd2, 0x16, 0x2f]);
            s.write_all(b"N").await.unwrap();
        });
        // something else that greets first
        let other = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let other_port = other.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = other.accept().await.unwrap();
            s.write_all(b"SSH-2.0-OpenSSH_9.6\r\n").await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        assert_eq!(probe(pg_port).await, Some((DbEngine::Postgres, "PostgreSQL".into())));
        assert_eq!(probe(other_port).await, None);
        // nothing listening
        let free = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().port();
        assert_eq!(probe(free).await, None);
    }

    /// With real databases on this PC (e.g. Docker containers publishing 5433 / 3307):
    /// `cargo test -p rookery-core detect_local_for_real -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn detect_local_for_real() {
        for db in detect_local().await {
            eprintln!("{db:?}");
        }
    }

    #[test]
    fn images_and_errors() {
        assert_eq!(engine_of_image("bitnami/postgresql:16"), Some(DbEngine::Postgres));
        assert_eq!(engine_of_image("postgis/postgis:16-3.4"), Some(DbEngine::Postgres));
        assert_eq!(engine_of_image("percona:8"), Some(DbEngine::Mysql));
        assert_eq!(engine_of_image("redis:7"), None);
        assert_eq!(engine_of_image("prom/mysqld-exporter:v0.15"), None);
        assert!(parse_docker_inspect(r#"[{"Config": {"Image": "redis:7"}}]"#).is_err());
        assert!(parse_docker_inspect("Error: No such container: nope").unwrap_err().to_string().contains("No such container"));
        let stopped = r#"[{"Name": "/pg", "Config": {"Image": "postgres"}, "NetworkSettings": {"IPAddress": "", "Ports": {}, "Networks": {}}}]"#;
        assert!(parse_docker_inspect(stopped).unwrap_err().to_string().contains("is it running"));
    }
}
