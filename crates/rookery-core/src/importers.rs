//! Importers (docs/04 §7): `~/.ssh/config`, MobaXterm sessions, PuTTY sessions.
//! Parsing is pure; `apply` turns the chosen entries into groups, logins and hosts.
//! Passwords are never imported (none of these sources store them in a usable way).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::db::Db;
use crate::model::*;
use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct ImportedHost {
    pub name: String,
    pub address: String,
    pub port: u16,
    pub user: Option<String>,
    /// Private key file (SSH config IdentityFile, PuTTY PublicKeyFile, MobaXterm key).
    pub key_path: Option<String>,
    /// Folder / group in the source (MobaXterm folders).
    pub folder: Option<String>,
    /// Already in Rookery (same address, port and user): unchecked by default.
    #[serde(default)]
    pub exists: bool,
}

// ------------------------------------------------------------- ~/.ssh/config

pub fn parse_ssh_config(text: &str) -> Vec<ImportedHost> {
    struct Block {
        aliases: Vec<String>,
        host: Option<String>,
        port: Option<u16>,
        user: Option<String>,
        key: Option<String>,
    }
    let mut blocks: Vec<Block> = Vec::new();
    let mut defaults = Block { aliases: vec![], host: None, port: None, user: None, key: None };
    #[derive(PartialEq)]
    enum Mode {
        Defaults, // "Host *"
        Skip,     // other patterns / Match blocks: not imported
        Block,
    }
    let mut mode = Mode::Defaults; // lines before the first Host apply to everything
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (k, v) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
            None => continue,
        };
        if k == "host" {
            let aliases: Vec<String> = v.split_whitespace().map(String::from).collect();
            let concrete: Vec<String> = aliases.iter().filter(|a| !a.contains('*') && !a.contains('?') && !a.starts_with('!')).cloned().collect();
            mode = if aliases == ["*"] {
                Mode::Defaults
            } else if concrete.is_empty() {
                Mode::Skip
            } else {
                blocks.push(Block { aliases: concrete, host: None, port: None, user: None, key: None });
                Mode::Block
            };
            continue;
        }
        if k == "match" {
            mode = Mode::Skip;
            continue;
        }
        let target = match mode {
            Mode::Skip => continue,
            Mode::Defaults => &mut defaults,
            Mode::Block => blocks.last_mut().expect("block pushed with Mode::Block"),
        };
        match k.as_str() {
            "hostname" => target.host.get_or_insert(v),
            "port" => {
                if target.port.is_none() {
                    target.port = v.parse().ok();
                }
                continue;
            }
            "user" => target.user.get_or_insert(v),
            "identityfile" => target.key.get_or_insert(v),
            _ => continue,
        };
    }
    let mut out = Vec::new();
    for b in blocks {
        for alias in &b.aliases {
            let address = b.host.clone().unwrap_or_else(|| alias.clone()).replace("%h", alias);
            out.push(ImportedHost {
                name: alias.clone(),
                address,
                port: b.port.or(defaults.port).unwrap_or(22),
                user: b.user.clone().or(defaults.user.clone()),
                key_path: b.key.clone().or(defaults.key.clone()),
                folder: None,
                exists: false,
            });
        }
    }
    out
}

// ------------------------------------------------------------------ MobaXterm

/// `.mxtsessions` export or `MobaXterm.ini`: `[Bookmarks…]` sections, `SubRep=Folder\Sub`,
/// `Name=#109#0%host%port%user%…` (109 = SSH).
pub fn parse_mobaxterm(text: &str) -> Vec<ImportedHost> {
    let mut out = Vec::new();
    let mut in_bookmarks = false;
    let mut folder: Option<String> = None;
    for raw in text.lines() {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.starts_with('[') {
            in_bookmarks = line.to_ascii_lowercase().starts_with("[bookmarks");
            folder = None;
            continue;
        }
        if !in_bookmarks {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        if key.eq_ignore_ascii_case("SubRep") {
            folder = Some(value.trim().replace('\\', " / ")).filter(|f| !f.is_empty());
            continue;
        }
        if key.eq_ignore_ascii_case("ImgNum") {
            continue;
        }
        let Some(rest) = value.strip_prefix("#109#") else { continue }; // SSH sessions only
        let fields: Vec<&str> = rest.split('%').collect();
        // fields[0] = flags, then host, port, user, …
        let host = fields.get(1).map(|s| s.trim()).unwrap_or("");
        if host.is_empty() {
            continue;
        }
        let key_path = fields
            .iter()
            .skip(4)
            .find(|f| {
                let l = f.to_ascii_lowercase();
                l.ends_with(".ppk") || l.ends_with(".pem") || l.contains("id_rsa") || l.contains("id_ed25519") || l.ends_with(".key")
            })
            .map(|f| f.replace("_CurrentDrive_", "C").replace("_ProfileDir_", "~"));
        out.push(ImportedHost {
            name: key.trim().to_string(),
            address: host.to_string(),
            port: fields.get(2).and_then(|p| p.trim().parse().ok()).unwrap_or(22),
            user: fields.get(3).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()),
            key_path,
            folder: folder.clone(),
            exists: false,
        });
    }
    out
}

// --------------------------------------------------------------------- PuTTY

/// Output of `reg query HKCU\Software\SimonTatham\PuTTY\Sessions /s`.
pub fn parse_putty_reg(text: &str) -> Vec<ImportedHost> {
    let mut out = Vec::new();
    let mut cur: Option<(String, HashMap<String, String>)> = None;
    let flush = |cur: &mut Option<(String, HashMap<String, String>)>, out: &mut Vec<ImportedHost>| {
        if let Some((name, v)) = cur.take() {
            let proto = v.get("Protocol").map(String::as_str).unwrap_or("ssh");
            let host = v.get("HostName").cloned().unwrap_or_default();
            if proto.eq_ignore_ascii_case("ssh") && !host.trim().is_empty() && name != "Default Settings" {
                let (user, host) = match host.split_once('@') {
                    Some((u, h)) => (Some(u.to_string()), h.to_string()),
                    None => (v.get("UserName").cloned().filter(|u| !u.is_empty()), host),
                };
                out.push(ImportedHost {
                    name,
                    address: host,
                    port: v.get("PortNumber").and_then(|p| parse_reg_dword(p)).unwrap_or(22),
                    user,
                    key_path: v.get("PublicKeyFile").cloned().filter(|k| !k.is_empty()),
                    folder: None,
                    exists: false,
                });
            }
        }
    };
    for raw in text.lines() {
        let line = raw.trim_end();
        if let Some(idx) = line.find("\\PuTTY\\Sessions\\") {
            flush(&mut cur, &mut out);
            let name = url_decode(&line[idx + "\\PuTTY\\Sessions\\".len()..]);
            cur = Some((name, HashMap::new()));
            continue;
        }
        let t = line.trim();
        let mut parts = t.splitn(3, "    ");
        if let (Some(k), Some(_ty), Some(v)) = (parts.next(), parts.next(), parts.next()) {
            if let Some((_, map)) = cur.as_mut() {
                map.insert(k.trim().to_string(), v.trim().to_string());
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

fn parse_reg_dword(v: &str) -> Option<u16> {
    let v = v.trim();
    match v.strip_prefix("0x") {
        Some(hex) => u16::from_str_radix(hex, 16).ok(),
        None => v.parse().ok(),
    }
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Read PuTTY sessions from the Windows registry.
#[cfg(windows)]
pub fn read_putty() -> Result<Vec<ImportedHost>> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\SimonTatham\PuTTY\Sessions", "/s"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    Ok(parse_putty_reg(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(not(windows))]
pub fn read_putty() -> Result<Vec<ImportedHost>> {
    Ok(vec![])
}

// --------------------------------------------------------------------- apply

/// Mark entries that already exist (same address, port, user).
pub fn mark_existing(db: &Db, list: &mut [ImportedHost]) -> Result<()> {
    let hosts = db.list_hosts()?;
    let idents: HashMap<String, Identity> = db.list_identities()?.into_iter().map(|i| (i.id.clone(), i)).collect();
    for e in list.iter_mut() {
        e.exists = hosts.iter().any(|h| {
            let user = h.identity_id.as_ref().and_then(|i| idents.get(i)).map(|i| i.username.clone());
            h.address.eq_ignore_ascii_case(&e.address) && h.port == e.port && (e.user.is_none() || user == e.user)
        });
    }
    Ok(())
}

/// Create hosts (and the groups / logins they need). Returns how many hosts were added.
/// Logins are shared: one per (user, key file); a key file means "key file" login, otherwise
/// "password" (you type it once in the login, Rookery keeps it in the vault).
pub fn apply(db: &Db, list: &[ImportedHost], group: Option<&str>) -> Result<u32> {
    let mut groups: HashMap<String, String> = db.list_groups()?.into_iter().map(|g| (g.name.to_lowercase(), g.id)).collect();
    let mut idents: HashMap<(String, Option<String>), String> = db
        .list_identities()?
        .into_iter()
        .map(|i| ((i.username.clone(), i.key_path.clone()), i.id))
        .collect();
    let mut group_id = |name: &str| -> Result<String> {
        if let Some(id) = groups.get(&name.to_lowercase()) {
            return Ok(id.clone());
        }
        let g = db.save_group(Group {
            id: String::new(),
            parent_id: None,
            name: name.to_string(),
            color: "#8AB4FF".into(),
            sort: 0,
            identity_id: None,
            jump_host_id: None,
            theme: None,
            start_folder: None,
            refresh: RefreshSetting::default(),
            auto_sync_enabled: false,
            updated_at: 0,
        })?;
        groups.insert(name.to_lowercase(), g.id.clone());
        Ok(g.id)
    };
    let mut added = 0;
    for e in list {
        let gid = match (e.folder.as_deref(), group) {
            (Some(f), _) => Some(group_id(f)?),
            (None, Some(g)) if !g.trim().is_empty() => Some(group_id(g.trim())?),
            _ => None,
        };
        let identity_id = match &e.user {
            Some(u) => {
                let key = (u.clone(), e.key_path.clone());
                match idents.get(&key) {
                    Some(id) => Some(id.clone()),
                    None => {
                        let i = db.save_identity(Identity {
                            id: String::new(),
                            name: if e.key_path.is_some() { format!("{u} (key)") } else { u.clone() },
                            username: u.clone(),
                            auth: if e.key_path.is_some() { AuthKind::KeyFile } else { AuthKind::Password },
                            key_path: e.key_path.clone(),
                            has_password: false,
                            has_key: false,
                            has_passphrase: false,
                            has_sudo: false,
                            updated_at: 0,
                        })?;
                        idents.insert(key, i.id.clone());
                        Some(i.id)
                    }
                }
            }
            None => None,
        };
        db.save_host(Host {
            id: String::new(),
            group_id: gid,
            name: e.name.clone(),
            address: e.address.clone(),
            port: e.port,
            env_label: EnvLabel::default(),
            tags: vec![],
            identity_id,
            jump_host_id: None,
            theme: None,
            start_view: StartView::default(),
            start_folder: None,
            auto_reconnect: true,
            keepalive_s: 30,
            log_session: false,
            refresh: RefreshSetting::default(),
            sort: 0,
            created_at: 0,
            updated_at: 0,
        })?;
        added += 1;
    }
    Ok(added)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_config_hosts_aliases_and_defaults() {
        let cfg = r#"
# comment
Host *
    User deploy
    IdentityFile ~/.ssh/id_ed25519

Host web web-alias
    HostName 203.0.113.10
    Port 2222

Host db
  HostName=10.0.0.5
  User root

Match host foo
  User ignored

Host *.internal !bastion
  User x

Host jump
  HostName 198.51.100.1
"#;
        let list = parse_ssh_config(cfg);
        assert_eq!(list.len(), 4);
        assert_eq!(list[3].user.as_deref(), Some("deploy"), "*.internal options must not leak into other hosts");
        assert_eq!(list[0], ImportedHost { name: "web".into(), address: "203.0.113.10".into(), port: 2222, user: Some("deploy".into()), key_path: Some("~/.ssh/id_ed25519".into()), folder: None, exists: false });
        assert_eq!(list[1].name, "web-alias");
        assert_eq!(list[2].user.as_deref(), Some("root"));
        assert_eq!(list[2].port, 22);
    }

    #[test]
    fn mobaxterm_bookmarks_with_folders() {
        let ini = "[Bookmarks]\nSubRep=\nImgNum=42\nRoot box=#109#0%192.168.1.10%22%root%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10\n\
[Bookmarks_1]\nSubRep=Clients\\Acme\nImgNum=41\nacme-vps=#109#0%acme.example.com%2200%deploy%%-1%-1%%%%%0%0%0%_ProfileDir_\\keys\\acme.ppk%%-1%0\nRDP box=#91#4%10.0.0.9%3389%admin\n";
        let list = parse_mobaxterm(ini);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].address, "192.168.1.10");
        assert_eq!(list[0].user.as_deref(), Some("root"));
        assert_eq!(list[0].folder, None);
        assert_eq!(list[1].port, 2200);
        assert_eq!(list[1].folder.as_deref(), Some("Clients / Acme"));
        assert_eq!(list[1].key_path.as_deref(), Some("~\\keys\\acme.ppk"));
    }

    #[test]
    fn putty_registry_dump() {
        let reg = "\r\nHKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Default%20Settings\r\n    HostName    REG_SZ    \r\n\r\n\
HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\my%20server\r\n    HostName    REG_SZ    admin@10.1.1.1\r\n    PortNumber    REG_DWORD    0x16\r\n    Protocol    REG_SZ    ssh\r\n    PublicKeyFile    REG_SZ    C:\\keys\\a.ppk\r\n\r\n\
HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\serial\r\n    HostName    REG_SZ    COM1\r\n    Protocol    REG_SZ    serial\r\n";
        let list = parse_putty_reg(reg);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "my server");
        assert_eq!(list[0].user.as_deref(), Some("admin"));
        assert_eq!(list[0].address, "10.1.1.1");
        assert_eq!(list[0].port, 22);
        assert_eq!(list[0].key_path.as_deref(), Some("C:\\keys\\a.ppk"));
    }

    #[test]
    fn apply_creates_groups_and_shared_logins_once() {
        let db = Db::open_in_memory().unwrap();
        let mk = |name: &str, user: &str, folder: Option<&str>| ImportedHost {
            name: name.into(),
            address: format!("{name}.example"),
            port: 22,
            user: Some(user.into()),
            key_path: None,
            folder: folder.map(String::from),
            exists: false,
        };
        let n = apply(&db, &[mk("a", "root", Some("Prod")), mk("b", "root", Some("Prod")), mk("c", "deploy", None)], Some("Imported")).unwrap();
        assert_eq!(n, 3);
        assert_eq!(db.list_groups().unwrap().len(), 2); // Prod, Imported
        assert_eq!(db.list_identities().unwrap().len(), 2); // root, deploy
        let mut list = vec![mk("a", "root", None)];
        mark_existing(&db, &mut list).unwrap();
        assert!(list[0].exists);
    }
}
