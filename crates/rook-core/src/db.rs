//! SQLite storage (docs/04-DATA-SYNC-SECURITY.md §1).
//! Secrets are never stored here — only references into the vault.

use std::path::Path;

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, Row};
use rusqlite_migration::{Migrations, M};

use crate::model::*;
use crate::{new_id, now_ms, Error, Result};

const MIGRATIONS: &[&str] = &[
    // v1
    r#"
    CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#8AB4FF',
        sort INTEGER NOT NULL DEFAULT 0,
        identity_id TEXT,
        jump_host_id TEXT,
        theme TEXT,
        start_folder TEXT,
        refresh_json TEXT NOT NULL DEFAULT '{}',
        auto_sync_enabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE hosts (
        id TEXT PRIMARY KEY,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22,
        env_label TEXT NOT NULL DEFAULT 'none',
        tags_json TEXT NOT NULL DEFAULT '[]',
        identity_id TEXT,
        jump_host_id TEXT,
        theme TEXT,
        start_view TEXT NOT NULL DEFAULT 'terminal',
        start_folder TEXT,
        auto_reconnect INTEGER NOT NULL DEFAULT 1,
        keepalive_s INTEGER NOT NULL DEFAULT 30,
        log_session INTEGER NOT NULL DEFAULT 0,
        refresh_json TEXT NOT NULL DEFAULT '{}',
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX hosts_group ON hosts(group_id);
    CREATE TABLE identities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT NOT NULL,
        auth TEXT NOT NULL DEFAULT 'password',
        key_path TEXT
    );
    CREATE TABLE known_hosts (
        host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
        key_type TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
    );
    CREATE TABLE server_snapshots (
        host_id TEXT PRIMARY KEY REFERENCES hosts(id) ON DELETE CASCADE,
        taken_at INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT,
        metrics_json TEXT,
        docker_json TEXT
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    );
    "#,
];

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let mut conn = Connection::open(path)?;
        Self::configure(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        Self::configure(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    fn configure(conn: &mut Connection) -> Result<()> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let migrations = Migrations::new(MIGRATIONS.iter().map(|s| M::up(s)).collect());
        migrations.to_latest(conn)?;
        Ok(())
    }

    // ---------------------------------------------------------------- groups

    pub fn list_groups(&self) -> Result<Vec<Group>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT id, parent_id, name, color, sort, identity_id, jump_host_id, theme, start_folder,
                    refresh_json, auto_sync_enabled
             FROM groups ORDER BY sort, name",
        )?;
        let rows = st.query_map([], row_group)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_group(&self, id: &str) -> Result<Option<Group>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT id, parent_id, name, color, sort, identity_id, jump_host_id, theme, start_folder,
                    refresh_json, auto_sync_enabled
             FROM groups WHERE id = ?1",
            [id],
            row_group,
        )
        .optional()?)
    }

    pub fn save_group(&self, mut g: Group) -> Result<Group> {
        if g.id.is_empty() {
            g.id = new_id();
        }
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO groups (id, parent_id, name, color, sort, identity_id, jump_host_id, theme,
                                 start_folder, refresh_json, auto_sync_enabled)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                parent_id=excluded.parent_id, name=excluded.name, color=excluded.color, sort=excluded.sort,
                identity_id=excluded.identity_id, jump_host_id=excluded.jump_host_id, theme=excluded.theme,
                start_folder=excluded.start_folder, refresh_json=excluded.refresh_json,
                auto_sync_enabled=excluded.auto_sync_enabled",
            params![
                g.id,
                g.parent_id,
                g.name,
                g.color,
                g.sort,
                g.identity_id,
                g.jump_host_id,
                g.theme,
                g.start_folder,
                serde_json::to_string(&g.refresh)?,
                g.auto_sync_enabled as i64,
            ],
        )?;
        Ok(g)
    }

    pub fn delete_group(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM groups WHERE id = ?1", [id])?;
        Ok(())
    }

    // ----------------------------------------------------------------- hosts

    pub fn list_hosts(&self) -> Result<Vec<Host>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{HOST_SELECT} ORDER BY sort, name"))?;
        let rows = st.query_map([], row_host)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_host(&self, id: &str) -> Result<Host> {
        let c = self.conn.lock();
        c.query_row(&format!("{HOST_SELECT} WHERE id = ?1"), [id], row_host)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("host {id}")))
    }

    pub fn save_host(&self, mut h: Host) -> Result<Host> {
        let now = now_ms();
        if h.id.is_empty() {
            h.id = new_id();
            h.created_at = now;
        }
        if h.created_at == 0 {
            h.created_at = now;
        }
        h.updated_at = now;
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO hosts (id, group_id, name, address, port, env_label, tags_json, identity_id,
                                jump_host_id, theme, start_view, start_folder, auto_reconnect, keepalive_s,
                                log_session, refresh_json, sort, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
             ON CONFLICT(id) DO UPDATE SET
                group_id=excluded.group_id, name=excluded.name, address=excluded.address, port=excluded.port,
                env_label=excluded.env_label, tags_json=excluded.tags_json, identity_id=excluded.identity_id,
                jump_host_id=excluded.jump_host_id, theme=excluded.theme, start_view=excluded.start_view,
                start_folder=excluded.start_folder, auto_reconnect=excluded.auto_reconnect,
                keepalive_s=excluded.keepalive_s, log_session=excluded.log_session,
                refresh_json=excluded.refresh_json, sort=excluded.sort, updated_at=excluded.updated_at",
            params![
                h.id,
                h.group_id,
                h.name,
                h.address,
                h.port,
                enum_str(&h.env_label)?,
                serde_json::to_string(&h.tags)?,
                h.identity_id,
                h.jump_host_id,
                h.theme,
                enum_str(&h.start_view)?,
                h.start_folder,
                h.auto_reconnect as i64,
                h.keepalive_s,
                h.log_session as i64,
                serde_json::to_string(&h.refresh)?,
                h.sort,
                h.created_at,
                h.updated_at,
            ],
        )?;
        Ok(h)
    }

    pub fn delete_host(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM hosts WHERE id = ?1", [id])?;
        Ok(())
    }

    // ------------------------------------------------------------ identities

    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id, name, username, auth, key_path FROM identities ORDER BY name")?;
        let rows = st.query_map([], row_identity)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_identity(&self, id: &str) -> Result<Identity> {
        let c = self.conn.lock();
        c.query_row(
            "SELECT id, name, username, auth, key_path FROM identities WHERE id = ?1",
            [id],
            row_identity,
        )
        .optional()?
        .ok_or_else(|| Error::NotFound(format!("identity {id}")))
    }

    pub fn save_identity(&self, mut i: Identity) -> Result<Identity> {
        if i.id.is_empty() {
            i.id = new_id();
        }
        self.conn.lock().execute(
            "INSERT INTO identities (id, name, username, auth, key_path) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username,
                auth=excluded.auth, key_path=excluded.key_path",
            params![i.id, i.name, i.username, enum_str(&i.auth)?, i.key_path],
        )?;
        Ok(i)
    }

    pub fn delete_identity(&self, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM identities WHERE id = ?1", [id])?;
        Ok(())
    }

    // ----------------------------------------------------------- known hosts

    pub fn get_known_host(&self, host_id: &str) -> Result<Option<KnownHost>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT host_id, key_type, fingerprint, first_seen, last_seen FROM known_hosts WHERE host_id = ?1",
            [host_id],
            |r| {
                Ok(KnownHost {
                    host_id: r.get(0)?,
                    key_type: r.get(1)?,
                    fingerprint: r.get(2)?,
                    first_seen: r.get(3)?,
                    last_seen: r.get(4)?,
                })
            },
        )
        .optional()?)
    }

    pub fn trust_host_key(&self, host_id: &str, key_type: &str, fingerprint: &str) -> Result<()> {
        let now = now_ms();
        self.conn.lock().execute(
            "INSERT INTO known_hosts (host_id, key_type, fingerprint, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(host_id) DO UPDATE SET key_type=excluded.key_type,
                fingerprint=excluded.fingerprint, first_seen=excluded.first_seen, last_seen=excluded.last_seen",
            params![host_id, key_type, fingerprint, now],
        )?;
        Ok(())
    }

    pub fn touch_known_host(&self, host_id: &str) -> Result<()> {
        self.conn
            .lock()
            .execute("UPDATE known_hosts SET last_seen = ?2 WHERE host_id = ?1", params![host_id, now_ms()])?;
        Ok(())
    }

    // ------------------------------------------------------------- snapshots

    pub fn upsert_snapshot(&self, s: &Snapshot) -> Result<()> {
        let metrics = s.metrics.as_ref().map(serde_json::to_string).transpose()?;
        self.conn.lock().execute(
            "INSERT INTO server_snapshots (host_id, taken_at, ok, error, metrics_json, docker_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(host_id) DO UPDATE SET taken_at=excluded.taken_at, ok=excluded.ok,
                error=excluded.error, metrics_json=excluded.metrics_json, docker_json=excluded.docker_json",
            params![s.host_id, s.taken_at, s.ok as i64, s.error, metrics, s.docker_json],
        )?;
        Ok(())
    }

    pub fn list_snapshots(&self) -> Result<Vec<Snapshot>> {
        let c = self.conn.lock();
        let mut st = c.prepare(
            "SELECT host_id, taken_at, ok, error, metrics_json, docker_json FROM server_snapshots",
        )?;
        let rows = st.query_map([], |r| {
            let metrics: Option<String> = r.get(4)?;
            Ok(Snapshot {
                host_id: r.get(0)?,
                taken_at: r.get(1)?,
                ok: r.get::<_, i64>(2)? != 0,
                error: r.get(3)?,
                metrics: metrics.and_then(|m| serde_json::from_str(&m).ok()),
                docker_json: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    // -------------------------------------------------------------- settings

    pub fn get_setting<T: serde::de::DeserializeOwned>(&self, key: &str) -> Result<Option<T>> {
        let c = self.conn.lock();
        let v: Option<String> = c
            .query_row("SELECT value_json FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .optional()?;
        Ok(match v {
            Some(s) => Some(serde_json::from_str(&s)?),
            None => None,
        })
    }

    pub fn set_setting<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![key, serde_json::to_string(value)?],
        )?;
        Ok(())
    }

    // -------------------------------------------------------- inheritance

    /// Walk host → group → parent groups and return the first identity id.
    pub fn resolve_identity_id(&self, host: &Host) -> Result<Option<String>> {
        if host.identity_id.is_some() {
            return Ok(host.identity_id.clone());
        }
        let mut gid = host.group_id.clone();
        let mut guard = 0;
        while let Some(id) = gid {
            guard += 1;
            if guard > 32 {
                break; // cycle protection
            }
            let Some(g) = self.get_group(&id)? else { break };
            if g.identity_id.is_some() {
                return Ok(g.identity_id);
            }
            gid = g.parent_id;
        }
        Ok(None)
    }

    /// Effective background-refresh setting (docs/04 §4.1).
    pub fn effective_refresh(&self, host: &Host) -> Result<EffectiveRefresh> {
        let global: RefreshSetting = self.get_setting("refresh.global")?.unwrap_or(RefreshSetting {
            mode: RefreshMode::Manual,
            ..Default::default()
        });
        let mut chain: Vec<(String, RefreshSetting)> = vec![("host".into(), host.refresh.clone())];
        let mut gid = host.group_id.clone();
        let mut guard = 0;
        while let Some(id) = gid {
            guard += 1;
            if guard > 32 {
                break;
            }
            let Some(g) = self.get_group(&id)? else { break };
            chain.push((format!("group:{}", g.id), g.refresh.clone()));
            gid = g.parent_id;
        }
        chain.push(("global".into(), global));
        Ok(resolve_refresh(&chain))
    }
}

/// Pure resolution of a refresh chain ordered most-specific first.
pub fn resolve_refresh(chain: &[(String, RefreshSetting)]) -> EffectiveRefresh {
    let (mode, source) = chain
        .iter()
        .find(|(_, s)| s.mode != RefreshMode::Inherit)
        .map(|(src, s)| (s.mode, src.clone()))
        .unwrap_or((RefreshMode::Manual, "global".into()));
    let first = |f: &dyn Fn(&RefreshSetting) -> Option<u32>| chain.iter().find_map(|(_, s)| f(s));
    let first_b = |f: &dyn Fn(&RefreshSetting) -> Option<bool>| chain.iter().find_map(|(_, s)| f(s));
    EffectiveRefresh {
        mode,
        interval_s: first(&|s| s.interval_s).unwrap_or(300),
        collect: chain.iter().find_map(|(_, s)| s.collect).unwrap_or(Collect::Basic),
        desktop: first_b(&|s| s.desktop).unwrap_or(true),
        mobile: first_b(&|s| s.mobile).unwrap_or(true),
        wifi_only: first_b(&|s| s.wifi_only).unwrap_or(true),
        source,
    }
}

const HOST_SELECT: &str = "SELECT id, group_id, name, address, port, env_label, tags_json, identity_id, jump_host_id,
    theme, start_view, start_folder, auto_reconnect, keepalive_s, log_session, refresh_json, sort,
    created_at, updated_at FROM hosts";

fn enum_str<T: serde::Serialize>(v: &T) -> Result<String> {
    Ok(serde_json::to_value(v)?.as_str().unwrap_or_default().to_string())
}

fn enum_parse<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_value(serde_json::Value::String(s)).unwrap_or_default()
}

fn json_or_default<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

fn row_group(r: &Row) -> rusqlite::Result<Group> {
    Ok(Group {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        sort: r.get(4)?,
        identity_id: r.get(5)?,
        jump_host_id: r.get(6)?,
        theme: r.get(7)?,
        start_folder: r.get(8)?,
        refresh: json_or_default(r.get(9)?),
        auto_sync_enabled: r.get::<_, i64>(10)? != 0,
    })
}

fn row_host(r: &Row) -> rusqlite::Result<Host> {
    Ok(Host {
        id: r.get(0)?,
        group_id: r.get(1)?,
        name: r.get(2)?,
        address: r.get(3)?,
        port: r.get(4)?,
        env_label: enum_parse(r.get(5)?),
        tags: json_or_default(r.get(6)?),
        identity_id: r.get(7)?,
        jump_host_id: r.get(8)?,
        theme: r.get(9)?,
        start_view: enum_parse(r.get(10)?),
        start_folder: r.get(11)?,
        auto_reconnect: r.get::<_, i64>(12)? != 0,
        keepalive_s: r.get(13)?,
        log_session: r.get::<_, i64>(14)? != 0,
        refresh: json_or_default(r.get(15)?),
        sort: r.get(16)?,
        created_at: r.get(17)?,
        updated_at: r.get(18)?,
    })
}

fn row_identity(r: &Row) -> rusqlite::Result<Identity> {
    Ok(Identity {
        id: r.get(0)?,
        name: r.get(1)?,
        username: r.get(2)?,
        auth: enum_parse(r.get(3)?),
        key_path: r.get(4)?,
        has_password: false,
        has_key: false,
        has_passphrase: false,
        has_sudo: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(name: &str, group: Option<&str>) -> Host {
        Host {
            id: String::new(),
            group_id: group.map(String::from),
            name: name.into(),
            address: "203.0.113.10".into(),
            port: 22,
            env_label: EnvLabel::Prod,
            tags: vec!["laravel".into()],
            identity_id: None,
            jump_host_id: None,
            theme: None,
            start_view: StartView::Terminal,
            start_folder: Some("/var/www".into()),
            auto_reconnect: true,
            keepalive_s: 30,
            log_session: false,
            refresh: RefreshSetting::default(),
            sort: 0,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn group(name: &str, parent: Option<&str>) -> Group {
        Group {
            id: String::new(),
            parent_id: parent.map(String::from),
            name: name.into(),
            color: "#FF6B6B".into(),
            sort: 0,
            identity_id: None,
            jump_host_id: None,
            theme: None,
            start_folder: None,
            refresh: RefreshSetting::default(),
            auto_sync_enabled: false,
        }
    }

    #[test]
    fn host_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let g = db.save_group(group("Production", None)).unwrap();
        let h = db.save_host(host("prod-api-01", Some(&g.id))).unwrap();
        let loaded = db.get_host(&h.id).unwrap();
        assert_eq!(loaded.name, "prod-api-01");
        assert_eq!(loaded.env_label, EnvLabel::Prod);
        assert_eq!(loaded.tags, vec!["laravel".to_string()]);
        assert_eq!(db.list_hosts().unwrap().len(), 1);
    }

    #[test]
    fn identity_inherits_from_parent_group() {
        let db = Db::open_in_memory().unwrap();
        let ident = db
            .save_identity(Identity {
                id: String::new(),
                name: "deploy".into(),
                username: "deploy".into(),
                auth: AuthKind::Password,
                key_path: None,
                has_password: false,
                has_key: false,
                has_passphrase: false,
                has_sudo: false,
            })
            .unwrap();
        let mut parent = group("Clients", None);
        parent.identity_id = Some(ident.id.clone());
        let parent = db.save_group(parent).unwrap();
        let child = db.save_group(group("Acme", Some(&parent.id))).unwrap();
        let h = db.save_host(host("acme-vps", Some(&child.id))).unwrap();
        assert_eq!(db.resolve_identity_id(&h).unwrap(), Some(ident.id));
    }

    #[test]
    fn refresh_resolution_order() {
        let auto_1m = RefreshSetting { mode: RefreshMode::Auto, interval_s: Some(60), ..Default::default() };
        let manual = RefreshSetting { mode: RefreshMode::Manual, ..Default::default() };
        let inherit = RefreshSetting::default();

        // host inherits, group auto 1m, global manual
        let e = resolve_refresh(&[
            ("host".into(), inherit.clone()),
            ("group:lab".into(), auto_1m.clone()),
            ("global".into(), manual.clone()),
        ]);
        assert_eq!(e.mode, RefreshMode::Auto);
        assert_eq!(e.interval_s, 60);
        assert_eq!(e.source, "group:lab");

        // host never overrides
        let never = RefreshSetting { mode: RefreshMode::Never, ..Default::default() };
        let e = resolve_refresh(&[("host".into(), never), ("group:lab".into(), auto_1m), ("global".into(), manual)]);
        assert_eq!(e.mode, RefreshMode::Never);
        assert_eq!(e.source, "host");
    }
}
