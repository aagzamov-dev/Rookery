use std::time::Duration;

use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::db::Db;
use crate::model::EnvLabel;
use crate::ssh::{ConnectionManager, SshHandle};
use crate::terminal::shell_quote;
use crate::{Error, Result};

const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const ENV: &str = "export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_PAGER=cat GIT_OPTIONAL_LOCKS=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false SSH_ASKPASS_REQUIRE=force;";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct GitFile {
    pub path: String,
    pub original_path: Option<String>,
    pub index: String,
    pub worktree: String,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct GitStash {
    pub reference: String,
    pub subject: String,
}

#[derive(Debug, Default, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct GitStatus {
    pub root: String,
    pub branch: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub operation: Option<String>,
    pub files: Vec<GitFile>,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
    pub stashes: Vec<GitStash>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub struct GitDiff {
    pub left: String,
    pub right: String,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "../../../apps/desktop/src/ipc/bindings/")]
pub enum GitAction {
    Stage { paths: Vec<String> },
    Unstage { paths: Vec<String> },
    Discard { path: String, untracked: bool },
    Commit { message: String },
    Switch { branch: String },
    CreateBranch { branch: String },
    Fetch,
    Pull,
    Push { remote: Option<String> },
    StashCreate { message: String },
    StashApply { reference: String },
    StashPop { reference: String },
    StashDrop { reference: String },
    AbortMerge,
    AbortRebase,
    ContinueRebase,
}

pub fn require_confirmation(db: &Db, host_id: &str, confirmed: bool) -> Result<()> {
    if host_id == crate::computer::ID { return Ok(()); }
    if db.get_host(host_id)?.env_label == EnvLabel::Prod && !confirmed {
        return Err(Error::Other(
            "Confirm this operation on the production server before continuing.".into(),
        ));
    }
    Ok(())
}

fn folder_command(folder: &str, command: &str) -> Result<String> {
    let folder = folder_arg(folder)?;
    Ok(format!("{ENV} cd {folder} && root=$(git rev-parse --show-toplevel) && cd \"$root\" && {{ {command}; }}"))
}

fn folder_arg(folder: &str) -> Result<String> {
    if folder.is_empty() || folder.len() > 4096 || folder.contains('\0') {
        return Err(Error::Other("Enter a repository folder.".into()));
    }
    Ok(if folder == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = folder.strip_prefix("~/") {
        format!("\"$HOME\"/{}", shell_quote(rest))
    } else {
        shell_quote(folder)
    })
}

const DISCOVER: &str = r#"command -v git >/dev/null 2>&1 || { printf 'Git is not installed on this server.' >&2; exit 1; }
checked=0
found=0
probe() {
  root=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  printf '%s\0' "$root"
  found=$((found+1))
}
candidate() {
  [ ! -L "$1" ] && [ -d "$1" ] || return 1
  case "${1##*/}" in .git|node_modules|vendor|.venv|venv|target|dist|build|.cache|.next|.nuxt|.idea|.vscode|__pycache__) return 1;; esac
  checked=$((checked+1))
}
probe "$PWD" && exit 0
for child in "$PWD"/* "$PWD"/.[!.]* "$PWD"/..?*; do
  [ "$checked" -lt 120 ] && [ "$found" -lt 24 ] || break
  candidate "$child" || continue
  probe "$child" && continue
  for grandchild in "$child"/* "$child"/.[!.]* "$child"/..?*; do
    [ "$checked" -lt 120 ] && [ "$found" -lt 24 ] || break
    candidate "$grandchild" || continue
    probe "$grandchild" || :
  done
done
true"#;

fn discovery_command(folder: &str) -> Result<String> {
    Ok(format!(
        "{ENV} cd {} && {{ {DISCOVER}; }}",
        folder_arg(folder)?
    ))
}

pub async fn discover(
    conns: &ConnectionManager,
    host_id: &str,
    folder: &str,
) -> Result<Vec<String>> {
    if host_id == crate::computer::ID { return native::discover(folder).await; }
    let command = discovery_command(folder)?;
    let lease = conns.acquire(host_id).await?;
    let handle = lease.handle().await?;
    let output = run(&handle, &command, 15).await?;
    let mut folders = Vec::new();
    for folder in output.split('\0').filter(|folder| !folder.is_empty()) {
        if !folders.iter().any(|existing| existing == folder) {
            folders.push(folder.to_string());
        }
    }
    Ok(folders)
}

async fn run(handle: &SshHandle, command: &str, seconds: u64) -> Result<String> {
    let work = async {
        let mut channel = handle.channel_open_session().await?;
        channel.exec(true, command).await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit = None;
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
            if stdout.len() + stderr.len() > OUTPUT_LIMIT {
                let _ = channel.close().await;
                return Err(Error::Other(
                    "Git output exceeds 4 MB. Narrow the selection or use the terminal.".into(),
                ));
            }
        }
        if exit != Some(0) {
            let message = format!(
                "{}{}",
                String::from_utf8_lossy(&stderr),
                String::from_utf8_lossy(&stdout)
            );
            return Err(Error::Other(if message.trim().is_empty() {
                "Git command did not complete successfully.".into()
            } else {
                message.trim().to_string()
            }));
        }
        String::from_utf8(stdout).map_err(|_| {
            Error::Other(
                "This Git output contains non-UTF-8 data. Use the terminal for this file.".into(),
            )
        })
    };
    tokio::time::timeout(Duration::from_secs(seconds), work)
        .await
        .map_err(|_| Error::Other("Git timed out. Reload status before retrying; the server may have completed the operation.".into()))?
}

const STATUS: &str = r#"printf '# rook.root %s\0' "$root";
git status --porcelain=v2 -z --branch --untracked-files=all &&
git for-each-ref --format='# rook.branch %(refname:short)%00' refs/heads &&
git remote | while IFS= read -r remote; do printf '# rook.remote %s\0' "$remote"; done &&
git stash list --format='# rook.stash %gd%x09%s%x00' &&
if [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then printf '# rook.operation merge\0';
elif [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then printf '# rook.operation rebase\0'; fi"#;

pub async fn status(conns: &ConnectionManager, host_id: &str, folder: &str) -> Result<GitStatus> {
    if host_id == crate::computer::ID { return native::status(folder).await; }
    let command = folder_command(folder, STATUS)?;
    let lease = conns.acquire(host_id).await?;
    let handle = lease.handle().await?;
    parse_status(&run(&handle, &command, 30).await?)
}

fn parse_status(output: &str) -> Result<GitStatus> {
    let mut result = GitStatus::default();
    let mut records = output.split('\0');
    while let Some(record) = records.next() {
        let record = if record.starts_with('\n') {
            record.trim_start_matches('\n')
        } else {
            record
        };
        if let Some(root) = record.strip_prefix("# rook.root ") {
            result.root = root.into();
        } else if let Some(branch) = record.strip_prefix("# branch.head ") {
            result.branch = branch.into();
        } else if let Some(upstream) = record.strip_prefix("# branch.upstream ") {
            result.upstream = Some(upstream.into());
        } else if let Some(ab) = record.strip_prefix("# branch.ab ") {
            let mut values = ab.split_whitespace();
            result.ahead = values
                .next()
                .and_then(|s| s.strip_prefix('+'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            result.behind = values
                .next()
                .and_then(|s| s.strip_prefix('-'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        } else if let Some(branch) = record.strip_prefix("# rook.branch ") {
            result.branches.push(branch.into());
        } else if let Some(remote) = record.strip_prefix("# rook.remote ") {
            result.remotes.push(remote.into());
        } else if let Some(stash) = record.strip_prefix("# rook.stash ") {
            if let Some((reference, subject)) = stash.split_once('\t') {
                result.stashes.push(GitStash {
                    reference: reference.into(),
                    subject: subject.into(),
                });
            }
        } else if let Some(operation) = record.strip_prefix("# rook.operation ") {
            result.operation = Some(operation.into());
        } else if let Some(path) = record.strip_prefix("? ") {
            result.files.push(GitFile {
                path: path.into(),
                original_path: None,
                index: "?".into(),
                worktree: "?".into(),
                conflicted: false,
            });
        } else if record.starts_with("1 ") || record.starts_with("2 ") || record.starts_with("u ") {
            let renamed = record.starts_with("2 ");
            let conflicted = record.starts_with("u ");
            let fields: Vec<_> = record
                .splitn(
                    if renamed {
                        10
                    } else if conflicted {
                        11
                    } else {
                        9
                    },
                    ' ',
                )
                .collect();
            let xy = fields
                .get(1)
                .ok_or_else(|| Error::Other("Invalid Git status.".into()))?;
            let path = fields
                .last()
                .ok_or_else(|| Error::Other("Invalid Git status path.".into()))?;
            let original_path = if renamed {
                Some(
                    records
                        .next()
                        .ok_or_else(|| Error::Other("Invalid Git rename status.".into()))?
                        .into(),
                )
            } else {
                None
            };
            result.files.push(GitFile {
                path: (*path).into(),
                original_path,
                index: xy.chars().next().unwrap_or('.').to_string(),
                worktree: xy.chars().nth(1).unwrap_or('.').to_string(),
                conflicted,
            });
        }
    }
    if result.root.is_empty() {
        return Err(Error::Other(
            "This folder is not a Git working tree.".into(),
        ));
    }
    Ok(result)
}

fn check_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.starts_with('/')
        || path.contains('\0')
        || path.split('/').any(|p| p == ".." || p == ".git")
    {
        return Err(Error::Other("Invalid repository file path.".into()));
    }
    Ok(())
}

fn paths_arg(paths: &[String]) -> Result<String> {
    if paths.is_empty() || paths.len() > 10_000 {
        return Err(Error::Other("Select repository files first.".into()));
    }
    paths
        .iter()
        .map(|p| {
            check_path(p)?;
            Ok(shell_quote(p))
        })
        .collect::<Result<Vec<_>>>()
        .map(|p| p.join(" "))
}

fn check_branch(branch: &str) -> Result<()> {
    if branch.is_empty()
        || branch.starts_with('-')
        || branch.contains(['\0', '\n', '\r'])
        || branch.len() > 1024
    {
        return Err(Error::Other("Invalid branch name.".into()));
    }
    Ok(())
}

fn stash_arg(reference: &str) -> Result<String> {
    let number = reference
        .strip_prefix("stash@{")
        .and_then(|r| r.strip_suffix('}'));
    if !number.is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
        return Err(Error::Other("Invalid stash reference.".into()));
    }
    Ok(shell_quote(reference))
}

fn action_command(action: &GitAction) -> Result<String> {
    Ok(match action {
        GitAction::Stage { paths } => {
            format!("git --literal-pathspecs add -- {}", paths_arg(paths)?)
        }
        GitAction::Unstage { paths } => {
            let paths = paths_arg(paths)?;
            format!("if git rev-parse --verify HEAD >/dev/null 2>&1; then git --literal-pathspecs reset -q HEAD -- {paths}; else git --literal-pathspecs rm --cached -q -- {paths}; fi")
        }
        GitAction::Discard { path, untracked } => {
            check_path(path)?;
            if *untracked {
                format!("git --literal-pathspecs clean -f -- {}", shell_quote(path))
            } else {
                format!(
                    "git --literal-pathspecs restore --worktree -- {}",
                    shell_quote(path)
                )
            }
        }
        GitAction::Commit { message } => {
            if message.trim().is_empty() || message.contains('\0') || message.len() > 65536 {
                return Err(Error::Other("Enter a commit message (up to 64 KB).".into()));
            }
            format!("git commit -m {}", shell_quote(message))
        }
        GitAction::Switch { branch } => {
            check_branch(branch)?;
            format!(
                "git check-ref-format --branch {} >/dev/null && git switch -- {}",
                shell_quote(branch),
                shell_quote(branch)
            )
        }
        GitAction::CreateBranch { branch } => {
            check_branch(branch)?;
            format!(
                "git check-ref-format --branch {} >/dev/null && git switch -c {}",
                shell_quote(branch),
                shell_quote(branch)
            )
        }
        GitAction::Fetch => "git fetch --prune".into(),
        GitAction::Pull => "git pull --ff-only".into(),
        GitAction::Push { remote } => match remote {
            None => "git push".into(),
            Some(remote) => {
                check_branch(remote)?;
                format!(
                    "git remote get-url {} >/dev/null && git push --set-upstream {} HEAD",
                    shell_quote(remote),
                    shell_quote(remote)
                )
            }
        },
        GitAction::StashCreate { message } => {
            if message.contains('\0') || message.len() > 65536 {
                return Err(Error::Other("Invalid stash message.".into()));
            }
            format!(
                "git stash push --include-untracked -m {}",
                shell_quote(if message.trim().is_empty() {
                    "Rookery stash"
                } else {
                    message
                })
            )
        }
        GitAction::StashApply { reference } => format!("git stash apply {}", stash_arg(reference)?),
        GitAction::StashPop { reference } => format!("git stash pop {}", stash_arg(reference)?),
        GitAction::StashDrop { reference } => format!("git stash drop {}", stash_arg(reference)?),
        GitAction::AbortMerge => "git merge --abort".into(),
        GitAction::AbortRebase => "git rebase --abort".into(),
        GitAction::ContinueRebase => "GIT_EDITOR=true git rebase --continue".into(),
    })
}

pub async fn mutate(
    db: &Db,
    conns: &ConnectionManager,
    host_id: &str,
    folder: &str,
    action: &GitAction,
    confirmed: bool,
) -> Result<String> {
    require_confirmation(db, host_id, confirmed)?;
    if host_id == crate::computer::ID { return native::mutate(folder, action, confirmed).await; }
    let command = folder_command(folder, &action_command(action)?)?;
    let lease = conns.acquire(host_id).await?;
    let handle = lease.handle().await?;
    run(&handle, &command, 120).await
}

pub async fn diff(
    conns: &ConnectionManager,
    host_id: &str,
    folder: &str,
    file: &GitFile,
    staged: bool,
) -> Result<GitDiff> {
    if host_id == crate::computer::ID { return native::diff(folder, file, staged).await; }
    check_path(&file.path)?;
    if let Some(original) = &file.original_path {
        check_path(original)?;
    }
    let old_path = file.original_path.as_deref().unwrap_or(&file.path);
    let left_spec = if staged {
        format!("HEAD:{old_path}")
    } else {
        format!(":{}", file.path)
    };
    let left = if file.conflicted {
        let spec = shell_quote(&format!(":2:{}", file.path));
        format!("if git cat-file -e {spec} 2>/dev/null; then git show {spec}; fi")
    } else if file.index == "?" || (staged && file.index == "A") {
        "printf ''".into()
    } else {
        format!("git show {}", shell_quote(&left_spec))
    };
    let right = if file.conflicted {
        let spec = shell_quote(&format!(":3:{}", file.path));
        format!("if git cat-file -e {spec} 2>/dev/null; then git show {spec}; fi")
    } else if (staged && file.index == "D") || (!staged && file.worktree == "D") {
        "printf ''".into()
    } else if staged {
        format!("git show {}", shell_quote(&format!(":{}", file.path)))
    } else {
        format!("if [ -L {p} ] || [ ! -f {p} ]; then printf 'Not a regular text file' >&2; exit 1; fi; head -c {} -- {p}", OUTPUT_LIMIT + 1, p = shell_quote(&file.path))
    };
    let command = folder_command(
        folder,
        &format!("{{ {left}; }} && printf '\\0' && {{ {right}; }}"),
    )?;
    let lease = conns.acquire(host_id).await?;
    let handle = lease.handle().await?;
    let output = run(&handle, &command, 30).await?;
    let (left, right) = output
        .split_once('\0')
        .ok_or_else(|| Error::Other("Invalid Git diff output.".into()))?;
    if right.contains('\0') || left.contains('\0') {
        return Ok(GitDiff {
            left: String::new(),
            right: String::new(),
            notice: Some("Binary files cannot be shown in the text diff.".into()),
        });
    }
    Ok(GitDiff {
        left: left.into(),
        right: right.into(),
        notice: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn local(folder: &std::path::Path, command: &str) -> String {
        let output = Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(folder)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{command}: {}{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn repository() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        local(dir.path(), "git init -q --initial-branch=main && git config user.email test@example.com && git config user.name Test");
        dir
    }

    fn local_action(folder: &std::path::Path, action: GitAction) {
        local(
            folder,
            &folder_command(folder.to_str().unwrap(), &action_command(&action).unwrap()).unwrap(),
        );
    }

    fn local_status(folder: &std::path::Path) -> GitStatus {
        parse_status(&local(
            folder,
            &folder_command(folder.to_str().unwrap(), STATUS).unwrap(),
        ))
        .unwrap()
    }

    #[test]
    fn git_commands_work_in_new_and_existing_repositories() {
        let dir = repository();
        let folder = dir.path();
        let name = "space ' quote\nfile";
        std::fs::write(folder.join(name), "first\n").unwrap();
        assert_eq!(local_status(folder).files[0].path, name);
        local_action(
            folder,
            GitAction::Stage {
                paths: vec![name.into()],
            },
        );
        local_action(
            folder,
            GitAction::Unstage {
                paths: vec![name.into()],
            },
        );
        assert_eq!(local_status(folder).files[0].index, "?");
        local_action(
            folder,
            GitAction::Stage {
                paths: vec![name.into()],
            },
        );
        local_action(
            folder,
            GitAction::Commit {
                message: "first commit".into(),
            },
        );
        assert!(local_status(folder).files.is_empty());
        local_action(
            folder,
            GitAction::CreateBranch {
                branch: "feature/test".into(),
            },
        );
        assert_eq!(local_status(folder).branch, "feature/test");
        local_action(
            folder,
            GitAction::Switch {
                branch: "main".into(),
            },
        );
        std::fs::write(folder.join(name), "second\n").unwrap();
        local_action(
            folder,
            GitAction::Stage {
                paths: vec![name.into()],
            },
        );
        local_action(
            folder,
            GitAction::Unstage {
                paths: vec![name.into()],
            },
        );
        assert_eq!(local_status(folder).files[0].worktree, "M");
        local_action(
            folder,
            GitAction::Discard {
                path: name.into(),
                untracked: false,
            },
        );
        assert_eq!(
            std::fs::read_to_string(folder.join(name)).unwrap(),
            "first\n"
        );
        std::fs::write(folder.join("untracked"), "new").unwrap();
        local_action(
            folder,
            GitAction::Discard {
                path: "untracked".into(),
                untracked: true,
            },
        );
        assert!(!folder.join("untracked").exists());
    }

    #[test]
    fn git_status_and_stashes_preserve_renamed_worktree_changes() {
        let dir = repository();
        let folder = dir.path();
        std::fs::write(folder.join("old"), "first\n").unwrap();
        local(
            folder,
            "git add old && git commit -qm initial && git mv old new",
        );
        std::fs::write(folder.join("new"), "first\nsecond\n").unwrap();
        let s = local_status(folder);
        assert_eq!(s.files[0].index, "R");
        assert_eq!(s.files[0].worktree, "M");
        assert_eq!(s.files[0].original_path.as_deref(), Some("old"));
        local_action(
            folder,
            GitAction::Stage {
                paths: vec!["new".into()],
            },
        );
        local_action(
            folder,
            GitAction::Unstage {
                paths: vec!["new".into(), "old".into()],
            },
        );
        local_action(
            folder,
            GitAction::StashCreate {
                message: "saved ' work".into(),
            },
        );
        assert!(local_status(folder).files.is_empty());
        assert_eq!(local_status(folder).stashes.len(), 1);
        local_action(
            folder,
            GitAction::StashApply {
                reference: "stash@{0}".into(),
            },
        );
        assert!(!local_status(folder).files.is_empty());
        local_action(
            folder,
            GitAction::StashDrop {
                reference: "stash@{0}".into(),
            },
        );
        assert!(local_status(folder).stashes.is_empty());
        local_action(
            folder,
            GitAction::StashCreate {
                message: "again".into(),
            },
        );
        local_action(
            folder,
            GitAction::StashPop {
                reference: "stash@{0}".into(),
            },
        );
        assert!(local_status(folder).stashes.is_empty());
    }

    #[test]
    fn status_detects_merge_conflicts_and_abort_restores_the_branch() {
        let dir = repository();
        let folder = dir.path();
        std::fs::write(folder.join("file"), "base\n").unwrap();
        local(
            folder,
            "git add file && git commit -qm initial && git switch -qc topic",
        );
        std::fs::write(folder.join("file"), "topic\n").unwrap();
        local(folder, "git commit -qam topic && git switch -q main");
        std::fs::write(folder.join("file"), "main\n").unwrap();
        local(
            folder,
            "git commit -qam main && (git merge topic >/dev/null 2>&1; test $? = 1)",
        );
        let status = local_status(folder);
        assert_eq!(status.operation.as_deref(), Some("merge"));
        assert!(status.files[0].conflicted);
        local_action(folder, GitAction::AbortMerge);
        assert!(local_status(folder).operation.is_none());
        assert!(local_status(folder).files.is_empty());
    }

    #[test]
    fn production_confirmation_uses_the_saved_host() {
        use crate::model::{Host, RefreshSetting, StartView};
        let db = Db::open_in_memory().unwrap();
        let host = db
            .save_host(Host {
                id: String::new(),
                group_id: None,
                name: "production".into(),
                address: "127.0.0.1".into(),
                port: 22,
                env_label: EnvLabel::Prod,
                tags: vec![],
                identity_id: None,
                jump_host_id: None,
                theme: None,
                start_view: StartView::Terminal,
                start_folder: None,
                auto_reconnect: false,
                keepalive_s: 30,
                log_session: false,
                refresh: RefreshSetting::default(),
                sort: 0,
                created_at: 0,
                updated_at: 0,
            })
            .unwrap();
        assert!(require_confirmation(&db, &host.id, false).is_err());
        assert!(require_confirmation(&db, &host.id, true).is_ok());
        let mut dev = host;
        dev.env_label = EnvLabel::Dev;
        let dev = db.save_host(dev).unwrap();
        assert!(require_confirmation(&db, &dev.id, false).is_ok());
        assert!(require_confirmation(&db, "missing", true).is_err());
    }

    #[test]
    fn status_handles_branches_renames_conflicts_and_unusual_paths() {
        let data = "# rook.root /repo\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -3\01 M. N... 100644 100644 100644 abc def file name\02 R. N... 100644 100644 100644 abc def R100 renamed\0old\nname\0u UU N... 100644 100644 100644 100644 a b c conflict\0? new\nfile\0# rook.branch main\0\n# rook.stash stash@{0}\tWIP\0\n# rook.operation merge\0";
        let s = parse_status(data).unwrap();
        assert_eq!(s.branch, "main");
        assert_eq!((s.ahead, s.behind), (2, 3));
        assert_eq!(s.files.len(), 4);
        assert_eq!(s.files[1].original_path.as_deref(), Some("old\nname"));
        assert!(s.files[2].conflicted);
        assert_eq!(s.files[3].path, "new\nfile");
        assert_eq!(s.stashes[0].reference, "stash@{0}");
        assert_eq!(s.operation.as_deref(), Some("merge"));
    }

    #[test]
    fn mutation_arguments_are_literal_and_validated() {
        assert!(action_command(&GitAction::Stage {
            paths: vec!["../outside".into()]
        })
        .is_err());
        assert!(action_command(&GitAction::Switch {
            branch: "--detach".into()
        })
        .is_err());
        assert!(stash_arg("stash@{0}; touch /tmp/oops").is_err());
        let command = action_command(&GitAction::Stage {
            paths: vec!["-name'$(touch nope)".into()],
        })
        .unwrap();
        assert!(command.starts_with("git --literal-pathspecs add -- '"));
        assert!(folder_command("~/repo", "git status")
            .unwrap()
            .contains("\"$HOME\"/'repo'"));
    }

    #[test]
    fn pathspec_characters_only_affect_the_selected_file() {
        let dir = repository();
        let folder = dir.path();
        std::fs::write(folder.join("[a]"), "literal").unwrap();
        std::fs::write(folder.join("a"), "other").unwrap();
        local_action(
            folder,
            GitAction::Stage {
                paths: vec!["[a]".into()],
            },
        );
        assert_eq!(local(folder, "git diff --cached --name-only").trim(), "[a]");
        local_action(
            folder,
            GitAction::Unstage {
                paths: vec!["[a]".into()],
            },
        );
        local_action(
            folder,
            GitAction::Discard {
                path: "[a]".into(),
                untracked: true,
            },
        );
        assert!(!folder.join("[a]").exists());
        assert_eq!(std::fs::read_to_string(folder.join("a")).unwrap(), "other");
    }

    #[test]
    fn discovery_stops_at_the_start_repository() {
        let dir = repository();
        let child = dir.path().join("nested");
        std::fs::create_dir(&child).unwrap();
        local(&child, "git init -q");
        let output = local(
            dir.path(),
            &discovery_command(dir.path().to_str().unwrap()).unwrap(),
        );
        let roots: Vec<_> = output.split('\0').filter(|path| !path.is_empty()).collect();
        assert_eq!(roots.len(), 1);
        assert_eq!(
            std::fs::canonicalize(roots[0]).unwrap(),
            std::fs::canonicalize(dir.path()).unwrap()
        );
    }

    #[test]
    fn discovery_finds_two_levels_and_worktrees_but_skips_noise_and_symlinks() {
        let dir = tempfile::tempdir().unwrap();
        for child in [
            "app",
            "team/api",
            "team/deep/ignored",
            "node_modules/ignored",
        ] {
            let path = dir.path().join(child);
            std::fs::create_dir_all(&path).unwrap();
            local(&path, "git init -q");
        }
        local(&dir.path().join("app"), "git config user.email test@example.com && git config user.name Test && git commit --allow-empty -qm initial");
        let linked = dir.path().join("linked");
        local(
            &dir.path().join("app"),
            &format!(
                "git worktree add -qb linked {}",
                shell_quote(linked.to_str().unwrap())
            ),
        );
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            dir.path().join("team/deep/ignored"),
            dir.path().join("symlink"),
        )
        .unwrap();
        let output = local(
            dir.path(),
            &discovery_command(dir.path().to_str().unwrap()).unwrap(),
        );
        let roots: Vec<_> = output
            .split('\0')
            .filter(|path| !path.is_empty())
            .map(|path| std::fs::canonicalize(path).unwrap())
            .collect();
        assert_eq!(roots.len(), 3);
        for path in ["app", "team/api", "linked"] {
            assert!(roots.contains(&std::fs::canonicalize(dir.path().join(path)).unwrap()));
        }
    }

    #[test]
    fn discovery_caps_repositories_and_directory_probes() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..30 {
            let path = dir.path().join(format!("repo{index:03}"));
            std::fs::create_dir(&path).unwrap();
            local(&path, "git init -q");
        }
        let output = local(
            dir.path(),
            &discovery_command(dir.path().to_str().unwrap()).unwrap(),
        );
        assert_eq!(
            output.split('\0').filter(|path| !path.is_empty()).count(),
            24
        );
        let empty = tempfile::tempdir().unwrap();
        for index in 0..130 {
            std::fs::create_dir(empty.path().join(format!("dir{index:03}"))).unwrap();
        }
        let last = empty.path().join("zzz");
        std::fs::create_dir(&last).unwrap();
        local(&last, "git init -q");
        assert!(local(
            empty.path(),
            &discovery_command(empty.path().to_str().unwrap()).unwrap()
        )
        .is_empty());
    }
}

mod native {
    use super::*;
    use crate::computer::{args, display, path, run};
    use std::path::Path;

    async fn git(folder: &Path, values: &[&str]) -> Result<String> {
        run("git", &args(values), Some(folder), 120).await
    }
    async fn root(folder: &str) -> Result<std::path::PathBuf> {
        let folder = path(folder)?;
        let result = git(&folder, &["rev-parse", "--show-toplevel"]).await?;
        path(result.trim_end_matches(['\r', '\n']))
    }
    pub async fn status(folder: &str) -> Result<GitStatus> {
        let root = root(folder).await?;
        let mut raw = format!("# rook.root {}\0", display(&root));
        raw.push_str(
            &git(
                &root,
                &[
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--branch",
                    "--untracked-files=all",
                ],
            )
            .await?,
        );
        for (command, prefix) in [
            (
                vec!["for-each-ref", "--format=%(refname:short)", "refs/heads"],
                "# rook.branch ",
            ),
            (vec!["remote"], "# rook.remote "),
            (vec!["stash", "list", "--format=%gd%x09%s"], "# rook.stash "),
        ] {
            for line in git(&root, &command).await?.lines() {
                raw.push_str(prefix);
                raw.push_str(line);
                raw.push('\0');
            }
        }
        for (file, operation) in [
            ("MERGE_HEAD", "merge"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
        ] {
            let p = git(&root, &["rev-parse", "--git-path", file]).await?;
            if tokio::fs::try_exists(root.join(p.trim()))
                .await
                .unwrap_or(false)
            {
                raw.push_str(&format!("# rook.operation {operation}\0"));
                break;
            }
        }
        parse_status(&raw)
    }
    pub async fn discover(folder: &str) -> Result<Vec<String>> {
        // Discovery is confined to the explicitly selected directory and two levels beneath it.
        let folder = path(folder)?;
        let mut queue = vec![(folder, 0)];
        let mut checked = 0;
        let mut found = Vec::new();
        while let Some((folder, depth)) = queue.pop() {
            if checked >= 120 || found.len() >= 24 {
                break;
            }
            checked += 1;
            if let Ok(value) = git(&folder, &["rev-parse", "--show-toplevel"]).await {
                let value = display(&path(value.trim())?);
                if !found.contains(&value) {
                    found.push(value);
                }
                continue;
            }
            if depth >= 2 {
                continue;
            }
            let dir = folder.clone();
            let children =
                tokio::task::spawn_blocking(move || -> Result<Vec<std::path::PathBuf>> {
                    let mut children = Vec::new();
                    for entry in std::fs::read_dir(dir)?.take(120) {
                        let entry = entry?;
                        let name = entry.file_name();
                        if entry.file_type()?.is_dir()
                            && ![
                                ".git",
                                "node_modules",
                                "vendor",
                                "target",
                                "dist",
                                "build",
                                ".cache",
                                ".next",
                                ".venv",
                            ]
                            .contains(&name.to_string_lossy().as_ref())
                        {
                            children.push(entry.path());
                        }
                    }
                    Ok(children)
                })
                .await
                .map_err(|e| Error::Other(e.to_string()))??;
            queue.extend(children.into_iter().map(|p| (p, depth + 1)));
        }
        Ok(found)
    }
    fn valid_path(value: &str) -> Result<()> {
        check_path(value)?;
        if value.contains('\\')
            || value.split('/').any(|p| p.eq_ignore_ascii_case(".git"))
            || value.contains(':')
        {
            return Err(Error::Other("Invalid repository file path.".into()));
        }
        Ok(())
    }
    pub async fn mutate(folder: &str, action: &GitAction, confirmed: bool) -> Result<String> {
        // Validate through the shared model before creating native argv.
        action_command(action)?;
        if matches!(
            action,
            GitAction::Discard { .. }
                | GitAction::StashDrop { .. }
                | GitAction::AbortMerge
                | GitAction::AbortRebase
        ) && !confirmed
        {
            return Err(Error::Other(
                "Confirm this destructive local Git operation first.".into(),
            ));
        }
        let root = root(folder).await?;
        let values = match action {
            GitAction::Stage { paths } | GitAction::Unstage { paths } => {
                for p in paths {
                    valid_path(p)?;
                }
                let mut values = if matches!(action, GitAction::Stage { .. }) {
                    args(&["--literal-pathspecs", "add", "--"])
                } else if git(&root, &["rev-parse", "--verify", "HEAD"]).await.is_ok() {
                    args(&["--literal-pathspecs", "reset", "-q", "HEAD", "--"])
                } else {
                    args(&["--literal-pathspecs", "rm", "--cached", "-q", "--"])
                };
                values.extend(paths.iter().cloned());
                values
            }
            GitAction::Discard { path, untracked } => {
                valid_path(path)?;
                let mut a = if *untracked {
                    args(&["--literal-pathspecs", "clean", "-f", "--"])
                } else {
                    args(&["--literal-pathspecs", "restore", "--worktree", "--"])
                };
                a.push(path.clone());
                a
            }
            GitAction::Commit { message } => args(&["commit", "-m", message]),
            GitAction::Switch { branch } => {
                git(&root, &["check-ref-format", "--branch", branch]).await?;
                args(&["switch", "--", branch])
            }
            GitAction::CreateBranch { branch } => {
                git(&root, &["check-ref-format", "--branch", branch]).await?;
                args(&["switch", "-c", branch])
            }
            GitAction::Fetch => args(&["fetch", "--prune"]),
            GitAction::Pull => args(&["pull", "--ff-only"]),
            GitAction::Push { remote } => {
                if let Some(r) = remote {
                    git(&root, &["remote", "get-url", r]).await?;
                    args(&["push", "--set-upstream", r, "HEAD"])
                } else {
                    args(&["push"])
                }
            }
            GitAction::StashCreate { message } => args(&[
                "stash",
                "push",
                "--include-untracked",
                "-m",
                if message.trim().is_empty() {
                    "Rookery stash"
                } else {
                    message
                },
            ]),
            GitAction::StashApply { reference } => args(&["stash", "apply", reference]),
            GitAction::StashPop { reference } => args(&["stash", "pop", reference]),
            GitAction::StashDrop { reference } => args(&["stash", "drop", reference]),
            GitAction::AbortMerge => args(&["merge", "--abort"]),
            GitAction::AbortRebase => args(&["rebase", "--abort"]),
            GitAction::ContinueRebase => args(&["rebase", "--continue"]),
        };
        run("git", &values, Some(&root), 120).await
    }
    async fn blob(root: &Path, spec: &str, optional: bool) -> Result<String> {
        if optional && git(root, &["cat-file", "-e", spec]).await.is_err() {
            return Ok(String::new());
        }
        git(root, &["show", spec]).await
    }
    pub async fn diff(folder: &str, file: &GitFile, staged: bool) -> Result<GitDiff> {
        valid_path(&file.path)?;
        if let Some(p) = &file.original_path {
            valid_path(p)?;
        }
        let root = root(folder).await?;
        let old = file.original_path.as_deref().unwrap_or(&file.path);
        let left = if file.conflicted {
            blob(&root, &format!(":2:{}", file.path), true).await?
        } else if file.index == "?" || staged && file.index == "A" {
            String::new()
        } else {
            blob(
                &root,
                &if staged {
                    format!("HEAD:{old}")
                } else {
                    format!(":{}", file.path)
                },
                false,
            )
            .await?
        };
        let right = if file.conflicted {
            blob(&root, &format!(":3:{}", file.path), true).await?
        } else if staged && file.index == "D" || !staged && file.worktree == "D" {
            String::new()
        } else if staged {
            blob(&root, &format!(":{}", file.path), false).await?
        } else {
            let path = root.join(&file.path);
            let bytes = tokio::task::spawn_blocking(move || {
                let meta = std::fs::symlink_metadata(&path)?;
                if !meta.is_file() || meta.is_symlink() {
                    return Err(Error::Other("Select a regular text file.".into()));
                }
                crate::computer::read(&display(&path), OUTPUT_LIMIT as u64).map(|v| v.0)
            })
            .await
            .map_err(|e| Error::Other(e.to_string()))??;
            String::from_utf8(bytes)
                .map_err(|_| Error::Other("This file is not UTF-8 text.".into()))?
        };
        if left.contains('\0') || right.contains('\0') {
            return Ok(GitDiff {
                left: String::new(),
                right: String::new(),
                notice: Some("Binary files cannot be shown in the text diff.".into()),
            });
        }
        Ok(GitDiff {
            left,
            right,
            notice: None,
        })
    }
}

#[cfg(test)]
mod local_tests {
    use super::*;
    #[tokio::test]
    async fn local_git_uses_literal_native_argv_and_preserves_other_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repository '$() & spaces");
        std::fs::create_dir(&repo).unwrap();
        crate::computer::run(
            "git",
            &crate::computer::args(&["init", "--initial-branch=main"]),
            Some(&repo),
            10,
        )
        .await
        .unwrap();
        let name = "file ' $() &.txt";
        std::fs::write(repo.join(name), b"text\n").unwrap();
        let folder = crate::computer::display(&repo);
        let status = native::status(&folder).await.unwrap();
        assert_eq!(status.files.len(), 1);
        assert_eq!(status.files[0].path, name);
        native::mutate(
            &folder,
            &GitAction::Stage {
                paths: vec![name.into()],
            },
            false,
        )
        .await
        .unwrap();
        let status = native::status(&folder).await.unwrap();
        assert_eq!(status.files[0].index, "A");
        let diff = native::diff(&folder, &status.files[0], true).await.unwrap();
        assert_eq!(diff.right, "text\n");
        assert!(native::mutate(
            &folder,
            &GitAction::Discard {
                path: name.into(),
                untracked: false
            },
            false
        )
        .await
        .is_err());
        assert!(native::mutate(
            &folder,
            &GitAction::Stage {
                paths: vec!["../outside".into()]
            },
            false
        )
        .await
        .is_err());
        assert!(native::mutate(
            &folder,
            &GitAction::Stage {
                paths: vec![".GIT/config".into()]
            },
            false
        )
        .await
        .is_err());
        assert!(native::mutate(
            &folder,
            &GitAction::CreateBranch {
                branch: "--bad".into()
            },
            false
        )
        .await
        .is_err());
    }
}
