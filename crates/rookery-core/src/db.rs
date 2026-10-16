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
    // v2: snippets
    r#"
    CREATE TABLE snippets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        alias TEXT,
        command TEXT NOT NULL,
        vars_json TEXT NOT NULL DEFAULT '[]',
        scope TEXT NOT NULL DEFAULT 'all',
        scope_value TEXT,
        run_mode TEXT NOT NULL DEFAULT 'run',
        hotkey TEXT,
        ask_prod INTEGER NOT NULL DEFAULT 1,
        pack TEXT,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX snippets_alias ON snippets(alias) WHERE alias IS NOT NULL AND alias <> '';
    "#,
    // v3: workflows (multi-step snippets)
    r#"
    ALTER TABLE snippets ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE snippets ADD COLUMN continue_on_error INTEGER NOT NULL DEFAULT 0;
    "#,
    // v4: dashboard sync — richer snapshots (docker_json now holds a DockerSummary)
    r#"
    ALTER TABLE server_snapshots ADD COLUMN state TEXT NOT NULL DEFAULT 'ok';
    ALTER TABLE server_snapshots ADD COLUMN last_ok_at INTEGER;
    ALTER TABLE server_snapshots ADD COLUMN prev_cpu REAL;
    ALTER TABLE server_snapshots ADD COLUMN os TEXT;
    ALTER TABLE server_snapshots ADD COLUMN services_json TEXT;
    ALTER TABLE server_snapshots ADD COLUMN duration_ms INTEGER;
    UPDATE server_snapshots SET state = CASE WHEN ok = 1 THEN 'ok' ELSE 'failed' END,
        last_ok_at = CASE WHEN ok = 1 THEN taken_at END, docker_json = NULL;
    "#,
    // v5: device sync — every synced record has a version time; deletions leave a tombstone
    r#"
    ALTER TABLE groups ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE identities ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE settings ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE tombstones (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
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
                    refresh_json, auto_sync_enabled, updated_at
             FROM groups ORDER BY sort, name",
        )?;
        let rows = st.query_map([], row_group)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_group(&self, id: &str) -> Result<Option<Group>> {
        let c = self.conn.lock();
        Ok(c.query_row(
            "SELECT id, parent_id, name, color, sort, identity_id, jump_host_id, theme, start_folder,
                    refresh_json, auto_sync_enabled, updated_at
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
        g.updated_at = now_ms();
        self.put_group(&g)?;
        Ok(g)
    }

    /// Write a group as is, keeping `updated_at` (device sync / backup import).
    pub fn put_group(&self, g: &Group) -> Result<()> {
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO groups (id, parent_id, name, color, sort, identity_id, jump_host_id, theme,
                                 start_folder, refresh_json, auto_sync_enabled, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                parent_id=excluded.parent_id, name=excluded.name, color=excluded.color, sort=excluded.sort,
                identity_id=excluded.identity_id, jump_host_id=excluded.jump_host_id, theme=excluded.theme,
                start_folder=excluded.start_folder, refresh_json=excluded.refresh_json,
                auto_sync_enabled=excluded.auto_sync_enabled, updated_at=excluded.updated_at",
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
                g.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> Result<()> {
        self.delete_tracked("groups", "id", "group", id)
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
        self.put_host(&h)?;
        Ok(h)
    }

    /// Write a host as is, keeping its timestamps (device sync / backup import).
    pub fn put_host(&self, h: &Host) -> Result<()> {
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
        Ok(())
    }

    pub fn delete_host(&self, id: &str) -> Result<()> {
        self.delete_tracked("hosts", "id", "host", id)
    }

    // ------------------------------------------------------------ identities

    pub fn list_identities(&self) -> Result<Vec<Identity>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT id, name, username, auth, key_path, updated_at FROM identities ORDER BY name")?;
        let rows = st.query_map([], row_identity)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_identity(&self, id: &str) -> Result<Identity> {
        let c = self.conn.lock();
        c.query_row(
            "SELECT id, name, username, auth, key_path, updated_at FROM identities WHERE id = ?1",
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
        i.updated_at = now_ms();
        self.put_identity(&i)?;
        Ok(i)
    }

    /// Write an identity as is, keeping `updated_at` (device sync / backup import).
    pub fn put_identity(&self, i: &Identity) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO identities (id, name, username, auth, key_path, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, username=excluded.username,
                auth=excluded.auth, key_path=excluded.key_path, updated_at=excluded.updated_at",
            params![i.id, i.name, i.username, enum_str(&i.auth)?, i.key_path, i.updated_at],
        )?;
        Ok(())
    }

    pub fn delete_identity(&self, id: &str) -> Result<()> {
        self.delete_tracked("identities", "id", "identity", id)
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
        self.clear_tombstone("known_host", host_id)?;
        Ok(())
    }

    /// Write a trusted key as is (device sync). Its version is `first_seen` (when it was trusted).
    pub fn put_known_host(&self, k: &KnownHost) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO known_hosts (host_id, key_type, fingerprint, first_seen, last_seen)
             SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM hosts WHERE id = ?1)
             ON CONFLICT(host_id) DO UPDATE SET key_type=excluded.key_type,
                fingerprint=excluded.fingerprint, first_seen=excluded.first_seen,
                last_seen=max(last_seen, excluded.last_seen)",
            params![k.host_id, k.key_type, k.fingerprint, k.first_seen, k.last_seen],
        )?;
        Ok(())
    }

    pub fn list_known_hosts(&self) -> Result<Vec<KnownHost>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT host_id, key_type, fingerprint, first_seen, last_seen FROM known_hosts")?;
        let rows = st.query_map([], |r| {
            Ok(KnownHost {
                host_id: r.get(0)?,
                key_type: r.get(1)?,
                fingerprint: r.get(2)?,
                first_seen: r.get(3)?,
                last_seen: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Forget a trusted key: the next connection asks again.
    pub fn forget_host_key(&self, host_id: &str) -> Result<()> {
        self.delete_tracked("known_hosts", "host_id", "known_host", host_id)
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
        let docker = s.docker.as_ref().map(serde_json::to_string).transpose()?;
        let services = s.failed_services.as_ref().map(serde_json::to_string).transpose()?;
        self.conn.lock().execute(
            "INSERT INTO server_snapshots (host_id, taken_at, ok, error, metrics_json, docker_json, state, last_ok_at,
                prev_cpu, os, services_json, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(host_id) DO UPDATE SET taken_at=excluded.taken_at, ok=excluded.ok, error=excluded.error,
                metrics_json=excluded.metrics_json, docker_json=excluded.docker_json, state=excluded.state,
                last_ok_at=excluded.last_ok_at, prev_cpu=excluded.prev_cpu, os=excluded.os,
                services_json=excluded.services_json, duration_ms=excluded.duration_ms",
            params![
                s.host_id,
                s.taken_at,
                (s.state == SyncState::Ok) as i64,
                s.error,
                metrics,
                docker,
                s.state.as_str(),
                s.last_ok_at,
                s.prev_cpu_pct,
                s.os,
                services,
                s.duration_ms
            ],
        )?;
        Ok(())
    }

    pub fn list_snapshots(&self) -> Result<Vec<Snapshot>> {
        let c = self.conn.lock();
        let mut st = c.prepare(SNAPSHOT_SELECT)?;
        let rows = st.query_map([], row_snapshot)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn get_snapshot(&self, host_id: &str) -> Result<Option<Snapshot>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{SNAPSHOT_SELECT} WHERE host_id = ?1"))?;
        Ok(st.query_row(params![host_id], row_snapshot).optional()?)
    }

    // -------------------------------------------------------------- snippets

    pub fn list_snippets(&self) -> Result<Vec<Snippet>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{SNIPPET_SELECT} ORDER BY pack, sort, name"))?;
        let rows = st.query_map([], row_snippet)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn save_snippet(&self, mut s: Snippet) -> Result<Snippet> {
        s.name = s.name.trim().to_string();
        s.alias = s.alias.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
        s.hotkey = s.hotkey.map(|h| h.trim().to_string()).filter(|h| !h.is_empty());
        s.steps.retain(|x| !x.trim().is_empty());
        if s.name.is_empty() || (s.command.trim().is_empty() && s.steps.is_empty()) {
            return Err(Error::Other("name and command are required".into()));
        }
        if let Some(a) = &s.alias {
            if !a.chars().all(|c| c.is_ascii_alphanumeric() || "_.:-".contains(c)) {
                return Err(Error::Other("alias may only contain letters, digits and _ . : -".into()));
            }
            let c = self.conn.lock();
            let taken: Option<String> = c
                .query_row("SELECT name FROM snippets WHERE alias = ?1 AND id <> ?2", params![a, s.id], |r| r.get(0))
                .optional()?;
            if let Some(other) = taken {
                return Err(Error::Other(format!("alias '{a}' is already used by \"{other}\"")));
            }
        }
        let now = now_ms();
        if s.id.is_empty() {
            s.id = new_id();
            s.created_at = now;
        }
        if s.created_at == 0 {
            s.created_at = now;
        }
        s.updated_at = now;
        self.put_snippet(&s)?;
        Ok(s)
    }

    /// Write a snippet as is, keeping its timestamps (device sync / backup import).
    /// Fails if another snippet already uses the alias.
    pub fn put_snippet(&self, s: &Snippet) -> Result<()> {
        self.conn.lock().execute(
            "INSERT INTO snippets (id, name, alias, command, vars_json, scope, scope_value, run_mode, hotkey,
                                   ask_prod, pack, sort, created_at, updated_at, steps_json, continue_on_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, alias=excluded.alias, command=excluded.command,
                vars_json=excluded.vars_json, scope=excluded.scope, scope_value=excluded.scope_value,
                run_mode=excluded.run_mode, hotkey=excluded.hotkey, ask_prod=excluded.ask_prod,
                pack=excluded.pack, sort=excluded.sort, updated_at=excluded.updated_at,
                steps_json=excluded.steps_json, continue_on_error=excluded.continue_on_error",
            params![
                s.id,
                s.name,
                s.alias,
                s.command,
                serde_json::to_string(&s.vars)?,
                enum_str(&s.scope)?,
                s.scope_value,
                enum_str(&s.run_mode)?,
                s.hotkey,
                s.ask_prod as i64,
                s.pack,
                s.sort,
                s.created_at,
                s.updated_at,
                serde_json::to_string(&s.steps)?,
                s.continue_on_error as i64,
            ],
        )?;
        Ok(())
    }

    pub fn delete_snippet(&self, id: &str) -> Result<()> {
        self.delete_tracked("snippets", "id", "snippet", id)
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
        let json = serde_json::to_string(value)?;
        // The version time only moves when the value really changes (no needless sync pushes).
        self.conn.lock().execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                updated_at = CASE WHEN value_json = excluded.value_json THEN updated_at ELSE excluded.updated_at END",
            params![key, json, now_ms()],
        )?;
        Ok(())
    }

    /// Settings that travel between devices (everything except per-device keys).
    pub fn list_synced_settings(&self) -> Result<Vec<SettingRecord>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT key, value_json, updated_at FROM settings")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (key, json, updated_at) = row?;
            if !is_local_setting(&key) {
                out.push(SettingRecord { key, value: serde_json::from_str(&json)?, updated_at });
            }
        }
        Ok(out)
    }

    pub fn put_setting(&self, s: &SettingRecord) -> Result<()> {
        if is_local_setting(&s.key) {
            return Ok(());
        }
        self.conn.lock().execute(
            "INSERT INTO settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![s.key, serde_json::to_string(&s.value)?, s.updated_at],
        )?;
        Ok(())
    }

    // ------------------------------------------------------------ tombstones

    /// Delete a row and remember it, so the deletion reaches other devices.
    fn delete_tracked(&self, table: &str, key_col: &str, kind: &str, id: &str) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let n = tx.execute(&format!("DELETE FROM {table} WHERE {key_col} = ?1"), [id])?;
        if n > 0 {
            tx.execute(
                "INSERT INTO tombstones (kind, id, deleted_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(kind, id) DO UPDATE SET deleted_at = excluded.deleted_at",
                params![kind, id, now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Apply a deletion that came from another device (keeps its time).
    pub fn apply_delete(&self, t: &Tombstone) -> Result<()> {
        let (table, col) = match t.kind.as_str() {
            "group" => ("groups", "id"),
            "host" => ("hosts", "id"),
            "identity" => ("identities", "id"),
            "snippet" => ("snippets", "id"),
            "known_host" => ("known_hosts", "host_id"),
            _ => return Ok(()),
        };
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        tx.execute(&format!("DELETE FROM {table} WHERE {col} = ?1"), [&t.id])?;
        tx.execute(
            "INSERT INTO tombstones (kind, id, deleted_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(kind, id) DO UPDATE SET deleted_at = max(deleted_at, excluded.deleted_at)",
            params![t.kind, t.id, t.deleted_at],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn list_tombstones(&self) -> Result<Vec<Tombstone>> {
        let c = self.conn.lock();
        let mut st = c.prepare("SELECT kind, id, deleted_at FROM tombstones")?;
        let rows = st.query_map([], |r| Ok(Tombstone { kind: r.get(0)?, id: r.get(1)?, deleted_at: r.get(2)? }))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn clear_tombstone(&self, kind: &str, id: &str) -> Result<()> {
        self.conn.lock().execute("DELETE FROM tombstones WHERE kind = ?1 AND id = ?2", params![kind, id])?;
        Ok(())
    }

    /// Replace everything that syncs (backup "Replace all"). Snapshots and per-device settings stay.
    pub fn wipe_synced(&self) -> Result<()> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let local: Vec<String> = LOCAL_SETTING_KEYS.iter().map(|k| format!("'{k}'")).collect();
        tx.execute_batch(&format!(
            "DELETE FROM known_hosts; DELETE FROM hosts; DELETE FROM groups; DELETE FROM identities;
             DELETE FROM snippets; DELETE FROM tombstones;
             DELETE FROM settings WHERE key NOT IN ({}) AND key NOT LIKE 'backup.%';",
            local.join(",")
        ))?;
        tx.commit()?;
        Ok(())
    }

    /// Changes whenever anything that syncs changes. Cheap: a few MAX / COUNT queries.
    pub fn data_revision(&self) -> Result<String> {
        let c = self.conn.lock();
        let local: Vec<String> = LOCAL_SETTING_KEYS.iter().map(|k| format!("'{k}'")).collect();
        let sql = format!(
            "SELECT
               (SELECT COALESCE(MAX(updated_at), 0) FROM groups),
               (SELECT COALESCE(MAX(updated_at), 0) FROM hosts),
               (SELECT COALESCE(MAX(updated_at), 0) FROM identities),
               (SELECT COALESCE(MAX(updated_at), 0) FROM snippets),
               (SELECT COALESCE(MAX(first_seen), 0) FROM known_hosts),
               (SELECT COALESCE(MAX(updated_at), 0) FROM settings WHERE key NOT IN ({}) AND key NOT LIKE 'backup.%'),
               (SELECT COALESCE(MAX(deleted_at), 0) FROM tombstones),
               (SELECT COUNT(*) FROM groups) + (SELECT COUNT(*) FROM hosts) + (SELECT COUNT(*) FROM identities)
                 + (SELECT COUNT(*) FROM snippets) + (SELECT COUNT(*) FROM known_hosts) + (SELECT COUNT(*) FROM tombstones)",
            local.join(",")
        );
        let v: Vec<i64> = c.query_row(&sql, [], |r| (0..8).map(|i| r.get::<_, i64>(i)).collect())?;
        Ok(v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(":"))
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

    /// Global refresh defaults. `auto` only means "follow the group's Auto-sync switch":
    /// every switch starts off, so nothing syncs on its own until the user turns one on.
    pub fn global_refresh(&self) -> Result<RefreshSetting> {
        let mut g: RefreshSetting = self.get_setting("refresh.global")?.unwrap_or_default();
        if g.mode == RefreshMode::Inherit {
            g.mode = RefreshMode::Auto;
        }
        g.interval_s.get_or_insert(300);
        g.collect.get_or_insert(Collect::BasicDocker);
        Ok(g)
    }

    pub fn sync_settings(&self) -> Result<SyncSettings> {
        Ok(self.get_setting("sync.settings")?.unwrap_or_default())
    }

    /// Turn the Auto-sync switch on/off for these groups (`"ungrouped"` = hosts without a group).
    pub fn set_auto_sync(&self, group_ids: &[String], on: bool) -> Result<()> {
        for id in group_ids {
            if id == UNGROUPED {
                let mut s = self.sync_settings()?;
                s.ungrouped_auto = on;
                self.set_setting("sync.settings", &s)?;
            } else {
                self.conn.lock().execute(
                    "UPDATE groups SET auto_sync_enabled = ?2 WHERE id = ?1",
                    params![id, on as i64],
                )?;
            }
        }
        Ok(())
    }

    /// Effective background-refresh setting (docs/04 §4.1).
    pub fn effective_refresh(&self, host: &Host) -> Result<EffectiveRefresh> {
        let global = self.global_refresh()?;
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

/// Settings that stay on this device (open tabs, dashboard tab, sync / backup config).
pub const LOCAL_SETTING_KEYS: &[&str] = &["ui.session", "ui.dashboard.tab", "sync.settings"];

pub fn is_local_setting(key: &str) -> bool {
    LOCAL_SETTING_KEYS.contains(&key) || key.starts_with("backup.")
}

const SNAPSHOT_SELECT: &str = "SELECT host_id, taken_at, state, error, last_ok_at, metrics_json, prev_cpu, os,
    docker_json, services_json, duration_ms FROM server_snapshots";

fn row_snapshot(r: &Row) -> rusqlite::Result<Snapshot> {
    let json = |i: usize| -> rusqlite::Result<Option<String>> { r.get(i) };
    Ok(Snapshot {
        host_id: r.get(0)?,
        taken_at: r.get(1)?,
        state: SyncState::parse(&r.get::<_, String>(2)?),
        error: r.get(3)?,
        last_ok_at: r.get(4)?,
        metrics: json(5)?.and_then(|m| serde_json::from_str(&m).ok()),
        prev_cpu_pct: r.get::<_, Option<f64>>(6)?.map(|v| v as f32),
        os: r.get(7)?,
        docker: json(8)?.and_then(|m| serde_json::from_str(&m).ok()),
        failed_services: json(9)?.and_then(|m| serde_json::from_str(&m).ok()),
        duration_ms: r.get(10)?,
    })
}

const SNIPPET_SELECT: &str = "SELECT id, name, alias, command, vars_json, scope, scope_value, run_mode, hotkey,
    ask_prod, pack, sort, created_at, updated_at, steps_json, continue_on_error FROM snippets";

fn row_snippet(r: &Row) -> rusqlite::Result<Snippet> {
    Ok(Snippet {
        id: r.get(0)?,
        name: r.get(1)?,
        alias: r.get(2)?,
        command: r.get(3)?,
        vars: json_or_default(r.get(4)?),
        scope: enum_parse(r.get(5)?),
        scope_value: r.get(6)?,
        run_mode: enum_parse(r.get(7)?),
        hotkey: r.get(8)?,
        ask_prod: r.get::<_, i64>(9)? != 0,
        pack: r.get(10)?,
        sort: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
        steps: json_or_default(r.get(14)?),
        continue_on_error: r.get::<_, i64>(15)? != 0,
    })
}

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
        updated_at: r.get(11)?,
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
        updated_at: r.get(5)?,
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
            updated_at: 0,
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
                updated_at: 0,
            })
            .unwrap();
        let mut parent = group("Clients", None);
        parent.identity_id = Some(ident.id.clone());
        let parent = db.save_group(parent).unwrap();
        let child = db.save_group(group("Acme", Some(&parent.id))).unwrap();
        let h = db.save_host(host("acme-vps", Some(&child.id))).unwrap();
        assert_eq!(db.resolve_identity_id(&h).unwrap(), Some(ident.id));
    }

    fn snippet(name: &str, alias: Option<&str>) -> Snippet {
        Snippet {
            id: String::new(),
            name: name.into(),
            alias: alias.map(String::from),
            command: "php artisan serve --port=${port}".into(),
            vars: vec![SnippetVar { name: "port".into(), default: Some("8000".into()), ask: true }],
            scope: SnippetScope::Tag,
            scope_value: Some("laravel".into()),
            run_mode: RunMode::Run,
            hotkey: Some("Ctrl+Shift+S".into()),
            ask_prod: true,
            pack: Some("Laravel".into()),
            sort: 0,
            created_at: 0,
            updated_at: 0,
            steps: vec![],
            continue_on_error: false,
        }
    }

    #[test]
    fn workflow_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let mut w = snippet("Deploy", Some("deploy"));
        w.command = String::new();
        w.steps = vec!["git pull".into(), " ".into(), "php artisan migrate --force".into()];
        w.continue_on_error = true;
        db.save_snippet(w).unwrap();
        let got = &db.list_snippets().unwrap()[0];
        assert_eq!(got.steps, vec!["git pull".to_string(), "php artisan migrate --force".to_string()]);
        assert!(got.continue_on_error);
    }

    #[test]
    fn known_hosts_list_and_forget() {
        let db = Db::open_in_memory().unwrap();
        let h = db.save_host(host("prod-api-01", None)).unwrap();
        db.trust_host_key(&h.id, "ssh-ed25519", "SHA256:abc").unwrap();
        assert_eq!(db.list_known_hosts().unwrap().len(), 1);
        db.forget_host_key(&h.id).unwrap();
        assert!(db.list_known_hosts().unwrap().is_empty());
    }

    #[test]
    fn snapshot_roundtrip_and_auto_switch() {
        let db = Db::open_in_memory().unwrap();
        let h = db.save_host(host("web", None)).unwrap();
        assert!(db.get_snapshot(&h.id).unwrap().is_none());
        let s = Snapshot {
            host_id: h.id.clone(),
            taken_at: 10,
            state: SyncState::Locked,
            error: Some("Needs password".into()),
            last_ok_at: Some(5),
            metrics: None,
            prev_cpu_pct: Some(91.5),
            os: Some("Debian 12".into()),
            docker: Some(DockerSummary { total: 2, running: 1, ..Default::default() }),
            failed_services: Some(vec!["nginx.service".into()]),
            duration_ms: Some(1200),
        };
        db.upsert_snapshot(&s).unwrap();
        let back = db.get_snapshot(&h.id).unwrap().unwrap();
        assert_eq!(back.state, SyncState::Locked);
        assert_eq!(back.prev_cpu_pct, Some(91.5));
        assert_eq!(back.docker.unwrap().running, 1);
        assert_eq!(back.failed_services.unwrap(), vec!["nginx.service".to_string()]);
        assert_eq!(db.list_snapshots().unwrap().len(), 1);

        // global default: auto, so a group's switch is all it takes
        assert_eq!(db.global_refresh().unwrap().mode, RefreshMode::Auto);
        db.set_auto_sync(&[UNGROUPED.to_string()], true).unwrap();
        assert!(db.sync_settings().unwrap().ungrouped_auto);
    }

    #[test]
    fn snippet_roundtrip_and_unique_alias() {
        let db = Db::open_in_memory().unwrap();
        let s = db.save_snippet(snippet("Serve", Some("paserve"))).unwrap();
        let list = db.list_snippets().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].alias.as_deref(), Some("paserve"));
        assert_eq!(list[0].scope, SnippetScope::Tag);
        assert_eq!(list[0].vars[0].default.as_deref(), Some("8000"));

        // same alias on another snippet is refused
        let err = db.save_snippet(snippet("Other", Some("paserve"))).unwrap_err();
        assert!(err.to_string().contains("already used"));

        // re-saving the same snippet keeps its alias
        let mut again = s.clone();
        again.name = "Serve app".into();
        db.save_snippet(again).unwrap();

        // empty alias is stored as NULL and does not collide
        db.save_snippet(snippet("No alias 1", Some(" "))).unwrap();
        db.save_snippet(snippet("No alias 2", None)).unwrap();
        assert_eq!(db.list_snippets().unwrap().len(), 3);

        assert!(db.save_snippet(snippet("Bad", Some("pa serve"))).is_err());
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
