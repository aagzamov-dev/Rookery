//! Collectors: one batched exec per tick, parsed in Rust (docs/01 §4.2).

use crate::model::MetricsSample;

/// One exec returns everything the stats bar needs. Sections are separated by `---`.
pub const METRICS_SCRIPT: &str = "export LC_ALL=C; head -n1 /proc/stat; echo ---; head -n3 /proc/meminfo; \
echo ---; cat /proc/loadavg; echo ---; cat /proc/uptime; echo ---; df -P / | tail -n1; echo ---; cat /proc/net/dev";

/// Counters kept between samples to compute rates.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct RawCounters {
    pub cpu_total: u64,
    pub cpu_idle: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub ts_ms: i64,
}

/// Parse [`METRICS_SCRIPT`] output. `prev` (from the previous tick) enables CPU % and net rates.
pub fn parse_metrics(raw: &str, prev: Option<&RawCounters>, ts_ms: i64) -> Option<(MetricsSample, RawCounters)> {
    let sections: Vec<&str> = raw.split("---\n").map(str::trim).collect();
    if sections.len() < 6 {
        return None;
    }

    // /proc/stat: cpu user nice system idle iowait irq softirq steal ...
    let cpu: Vec<u64> = sections[0]
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|v| v.parse().ok())
        .collect();
    if cpu.len() < 4 {
        return None;
    }
    let cpu_total: u64 = cpu.iter().sum();
    let cpu_idle = cpu[3] + cpu.get(4).copied().unwrap_or(0);

    // /proc/meminfo (kB)
    let mut mem_total = 0u64;
    let mut mem_avail = None;
    let mut mem_free = 0u64;
    for line in sections[1].lines() {
        let mut it = line.split_whitespace();
        let (Some(k), Some(v)) = (it.next(), it.next()) else { continue };
        let v: u64 = v.parse().unwrap_or(0) * 1024;
        match k {
            "MemTotal:" => mem_total = v,
            "MemFree:" => mem_free = v,
            "MemAvailable:" => mem_avail = Some(v),
            _ => {}
        }
    }
    let ram_used = mem_total.saturating_sub(mem_avail.unwrap_or(mem_free));

    // /proc/loadavg
    let load: Vec<f32> = sections[2].split_whitespace().take(3).filter_map(|v| v.parse().ok()).collect();

    // /proc/uptime
    let uptime_s = sections[3]
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0) as u64;

    // df -P /: fs 1024-blocks used available capacity mount
    let df: Vec<&str> = sections[4].split_whitespace().collect();
    let (disk_total, disk_used, disk_pct) = if df.len() >= 5 {
        let total = df[1].parse::<u64>().unwrap_or(0) * 1024;
        let used = df[2].parse::<u64>().unwrap_or(0) * 1024;
        let pct = df[4].trim_end_matches('%').parse::<f32>().unwrap_or(0.0);
        (total, used, pct)
    } else {
        (0, 0, 0.0)
    };

    // /proc/net/dev: sum all interfaces except loopback
    let (mut net_rx, mut net_tx) = (0u64, 0u64);
    for line in sections[5].lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else { continue };
        if iface.trim() == "lo" {
            continue;
        }
        let f: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
        if f.len() >= 9 {
            net_rx += f[0];
            net_tx += f[8];
        }
    }

    let now = RawCounters { cpu_total, cpu_idle, net_rx, net_tx, ts_ms };

    let (cpu_pct, rx_bps, tx_bps) = match prev {
        Some(p) if cpu_total > p.cpu_total && ts_ms > p.ts_ms => {
            let dt = cpu_total - p.cpu_total;
            let di = cpu_idle.saturating_sub(p.cpu_idle);
            let pct = (100.0 * (dt.saturating_sub(di)) as f64 / dt as f64) as f32;
            let secs = (ts_ms - p.ts_ms) as f64 / 1000.0;
            let rx = (net_rx.saturating_sub(p.net_rx) as f64 / secs) as u64;
            let tx = (net_tx.saturating_sub(p.net_tx) as f64 / secs) as u64;
            (Some(pct.clamp(0.0, 100.0)), Some(rx), Some(tx))
        }
        _ => (None, None, None),
    };

    Some((
        MetricsSample {
            ts_ms,
            cpu_pct,
            ram_used_bytes: ram_used,
            ram_total_bytes: mem_total,
            disk_pct,
            disk_used_bytes: disk_used,
            disk_total_bytes: disk_total,
            load1: load.first().copied().unwrap_or(0.0),
            load5: load.get(1).copied().unwrap_or(0.0),
            load15: load.get(2).copied().unwrap_or(0.0),
            uptime_s,
            net_rx_bps: rx_bps,
            net_tx_bps: tx_bps,
        },
        now,
    ))
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

pub const DOCKER_PS: &str = "docker ps -a --no-trunc --format '{{json .}}' 2>&1";
pub const DOCKER_EVENTS: &str = "exec docker events --format '{{json .}}' --filter type=container";
pub const DOCKER_STATS: &str = "exec docker stats --format '{{json .}}'";

/// Turn `docker ps` output into containers, or a friendly error.
pub fn parse_docker_ps(out: &str, exit: Option<u32>) -> Result<Vec<crate::model::Container>, String> {
    let lower = out.to_lowercase();
    if lower.contains("command not found") || lower.contains("not found: docker") || exit == Some(127) {
        return Err("Docker is not installed on this server.".into());
    }
    if lower.contains("permission denied") && lower.contains("docker") {
        return Err(
            "No permission to use Docker. Add your user to the docker group: sudo usermod -aG docker $USER (then log in again)."
                .into(),
        );
    }
    if lower.contains("cannot connect to the docker daemon") || lower.contains("is the docker daemon running") {
        return Err("The Docker daemon is not running on this server.".into());
    }
    let mut list = Vec::new();
    for line in out.lines().map(str::trim).filter(|l| l.starts_with('{')) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let labels = s("Labels");
        let label = |name: &str| {
            labels
                .split(',')
                .find_map(|kv| kv.strip_prefix(name).and_then(|r| r.strip_prefix('=')))
                .map(String::from)
        };
        let status = s("Status");
        let health = ["(healthy)", "(unhealthy)", "(health: starting)"]
            .iter()
            .find(|h| status.contains(*h))
            .map(|h| h.trim_matches(['(', ')']).trim_start_matches("health: ").to_string());
        list.push(crate::model::Container {
            id: s("ID"),
            name: s("Names").split(',').next().unwrap_or_default().to_string(),
            image: s("Image"),
            state: s("State"),
            status,
            ports: s("Ports"),
            health,
            project: label("com.docker.compose.project"),
            service: label("com.docker.compose.service"),
            created: s("CreatedAt"),
        });
    }
    if list.is_empty() && !out.trim().is_empty() && exit.unwrap_or(0) != 0 {
        return Err(out.lines().next().unwrap_or("docker ps failed").to_string());
    }
    list.sort_by(|a, b| a.project.cmp(&b.project).then(a.name.cmp(&b.name)));
    Ok(list)
}

/// One line of `docker stats --format '{{json .}}'`.
pub fn parse_docker_stats_line(line: &str) -> Option<crate::model::ContainerStats> {
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let pct = |k: &str| s(k).trim_end_matches('%').trim().parse::<f32>().unwrap_or(0.0);
    let id = s("ID");
    if id.is_empty() {
        return None;
    }
    Some(crate::model::ContainerStats {
        id,
        name: s("Name"),
        cpu_pct: pct("CPUPerc"),
        mem_pct: pct("MemPerc"),
        mem_usage: s("MemUsage"),
    })
}

/// Container ids / names are passed to the shell: keep them to safe characters.
pub fn valid_container_ref(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// RFC 3339 timestamps for `docker logs --since`.
pub fn valid_since(s: &str) -> bool {
    !s.is_empty() && s.len() <= 40 && s.chars().all(|c| c.is_ascii_digit() || "TZ:.+-".contains(c))
}

// ---------------------------------------------------------------------------
// systemd services
// ---------------------------------------------------------------------------

pub const SERVICES: &str = "systemctl list-units --type=service --all --no-pager --plain --no-legend 2>&1";

pub fn parse_services(out: &str) -> Result<Vec<crate::model::Service>, String> {
    if out.contains("command not found") || out.contains("System has not been booted with systemd") {
        return Err("This server does not use systemd.".into());
    }
    let mut list: Vec<crate::model::Service> = out
        .lines()
        .filter_map(|line| {
            let line = line.trim_start_matches(['●', '*', ' ']).trim();
            let mut it = line.split_whitespace();
            let name = it.next()?;
            if !name.ends_with(".service") {
                return None;
            }
            let load = it.next()?.to_string();
            let active = it.next()?.to_string();
            let sub = it.next()?.to_string();
            let description = it.collect::<Vec<_>>().join(" ");
            Some(crate::model::Service { name: name.trim_end_matches(".service").to_string(), load, active, sub, description })
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

/// Top processes by CPU. `etimes` (seconds) is GNU procps; busybox falls back to the plain list.
pub const PROCESSES: &str = "ps -eo pid=,user=,pcpu=,pmem=,etimes=,comm= --sort=-pcpu 2>/dev/null | head -n 80";

pub fn parse_processes(out: &str) -> Vec<crate::model::Process> {
    out.lines()
        .filter_map(|line| {
            let mut it = line.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let user = it.next()?.to_string();
            let cpu = it.next()?.parse().unwrap_or(0.0);
            let mem = it.next()?.parse().unwrap_or(0.0);
            let elapsed_s = it.next()?.parse().unwrap_or(0);
            let command = it.collect::<Vec<_>>().join(" ");
            if command.is_empty() {
                return None;
            }
            Some(crate::model::Process { pid, user, cpu, mem, elapsed_s, command })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Dashboard sync: everything in ONE exec (docs/04 §4.6)
// ---------------------------------------------------------------------------

const SYNC_SEP: &str = "@@ROOK@@";

/// Metrics twice (1 s apart, for CPU %), OS name, then optional docker / failed services.
pub fn sync_script(collect: crate::model::Collect) -> String {
    use crate::model::Collect;
    let metrics = METRICS_SCRIPT.trim_start_matches("export LC_ALL=C; ");
    let mut s = format!(
        "export LC_ALL=C; M(){{ {metrics}; }}; M; echo {SYNC_SEP}; sleep 1; M; echo {SYNC_SEP}; \
         ( . /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" ) || uname -sr"
    );
    if matches!(collect, Collect::BasicDocker | Collect::Everything) {
        s.push_str(&format!("; echo {SYNC_SEP}; "));
        s.push_str(DOCKER_PS);
        s.push_str(&format!("; echo \"@@exit $?\"; echo {SYNC_SEP}; "));
        s.push_str("docker stats --no-stream --format '{{json .}}' 2>/dev/null");
    }
    if collect == Collect::Everything {
        s.push_str(&format!(
            "; echo {SYNC_SEP}; systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | awk '{{print $1}}'"
        ));
    }
    s
}

pub struct SyncCollected {
    pub metrics: MetricsSample,
    pub os: Option<String>,
    pub docker: Option<crate::model::DockerSummary>,
    pub failed_services: Option<Vec<String>>,
}

/// Parse [`sync_script`] output. `now_ms` = time the second metrics read finished (≈ end of exec).
pub fn parse_sync(out: &str, collect: crate::model::Collect, now_ms: i64) -> Option<SyncCollected> {
    use crate::model::{Collect, DockerSummary};
    let parts: Vec<&str> = out.split(&format!("{SYNC_SEP}\n")).collect();
    if parts.len() < 3 {
        return None;
    }
    let (_, first) = parse_metrics(parts[0], None, now_ms - 1000)?;
    let (metrics, _) = parse_metrics(parts[1], Some(&first), now_ms)?;
    let os = parts[2].lines().next().map(str::trim).filter(|s| !s.is_empty()).map(String::from);

    let docker = if matches!(collect, Collect::BasicDocker | Collect::Everything) && parts.len() >= 5 {
        let (ps, exit) = match parts[3].rsplit_once("@@exit ") {
            Some((ps, code)) => (ps, code.trim().parse::<u32>().ok()),
            None => (parts[3], None),
        };
        Some(match parse_docker_ps(ps, exit) {
            Err(e) => DockerSummary { error: Some(e), ..Default::default() },
            Ok(list) => {
                let mut top: Vec<_> = parts[4].lines().filter_map(parse_docker_stats_line).collect();
                top.sort_by(|a, b| b.cpu_pct.total_cmp(&a.cpu_pct));
                top.truncate(5);
                DockerSummary {
                    total: list.len() as u32,
                    running: list.iter().filter(|c| c.state == "running").count() as u32,
                    exited: list.iter().filter(|c| c.state == "exited" || c.state == "dead").count() as u32,
                    unhealthy: list.iter().filter(|c| c.health.as_deref() == Some("unhealthy")).map(|c| c.name.clone()).collect(),
                    restarting: list.iter().filter(|c| c.state == "restarting").map(|c| c.name.clone()).collect(),
                    top,
                    error: None,
                }
            }
        })
    } else {
        None
    };

    let failed_services = (collect == Collect::Everything).then(|| {
        parts
            .get(5)
            .map(|p| p.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
            .unwrap_or_default()
    });

    Some(SyncCollected { metrics, os, docker, failed_services })
}

#[cfg(test)]
mod sync_tests {
    use super::*;
    use crate::model::Collect;

    const STAT1: &str = "cpu  100 0 100 800 0 0 0 0\n---\nMemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 600 kB\n---\n0.5 0.4 0.3 1/100 999\n---\n3600.5 100\n---\n/dev/sda1 1000 800 200 80% /\n---\nInter-|\n face |\n eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0\n";
    const STAT2: &str = "cpu  150 0 150 900 0 0 0 0\n---\nMemTotal: 1000 kB\nMemFree: 200 kB\nMemAvailable: 500 kB\n---\n0.6 0.4 0.3 1/100 999\n---\n3601.5 100\n---\n/dev/sda1 1000 810 190 81% /\n---\nInter-|\n face |\n eth0: 2000 0 0 0 0 0 0 0 4000 0 0 0 0 0 0 0\n";

    #[test]
    fn parses_basic_sync() {
        let out = format!("{STAT1}{SYNC_SEP}\n{STAT2}{SYNC_SEP}\nUbuntu 24.04.1 LTS\n");
        let c = parse_sync(&out, Collect::Basic, 10_000).unwrap();
        // cpu: total +200, idle +100 → 50 %
        assert_eq!(c.metrics.cpu_pct, Some(50.0));
        assert_eq!(c.metrics.disk_pct, 81.0);
        assert_eq!(c.os.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert!(c.docker.is_none());
        assert!(c.failed_services.is_none());
    }

    #[test]
    fn parses_docker_and_services() {
        let ps = r#"{"ID":"a","Image":"x","Labels":"","Names":"web","State":"running","Status":"Up 1 hour (unhealthy)"}
{"ID":"b","Image":"y","Labels":"","Names":"worker","State":"restarting","Status":"Restarting (1) 5 seconds ago"}
{"ID":"c","Image":"z","Labels":"","Names":"old","State":"exited","Status":"Exited (0) 2 days ago"}"#;
        let stats = r#"{"ID":"a","Name":"web","CPUPerc":"12.5%","MemPerc":"3.0%","MemUsage":"100MiB / 1GiB"}"#;
        let out = format!("{STAT1}{SYNC_SEP}\n{STAT2}{SYNC_SEP}\nDebian 12\n{SYNC_SEP}\n{ps}\n@@exit 0\n{SYNC_SEP}\n{stats}\n{SYNC_SEP}\nnginx.service\n");
        let c = parse_sync(&out, Collect::Everything, 10_000).unwrap();
        let d = c.docker.unwrap();
        assert_eq!((d.total, d.running, d.exited), (3, 1, 1));
        assert_eq!(d.unhealthy, vec!["web".to_string()]);
        assert_eq!(d.restarting, vec!["worker".to_string()]);
        assert_eq!(d.top.len(), 1);
        assert_eq!(c.failed_services.unwrap(), vec!["nginx.service".to_string()]);
    }

    #[test]
    fn docker_missing_is_a_summary_error_not_a_failure() {
        let out = format!("{STAT1}{SYNC_SEP}\n{STAT2}{SYNC_SEP}\nAlpine\n{SYNC_SEP}\nsh: docker: not found\n@@exit 127\n{SYNC_SEP}\n");
        let c = parse_sync(&out, Collect::BasicDocker, 10_000).unwrap();
        assert!(c.docker.unwrap().error.unwrap().contains("not installed"));
    }

    #[test]
    fn script_contains_requested_parts() {
        assert!(!sync_script(Collect::Basic).contains("docker"));
        assert!(sync_script(Collect::BasicDocker).contains("docker stats --no-stream --format '{{json .}}'"));
        assert!(sync_script(Collect::Everything).contains("systemctl"));
    }
}

#[cfg(test)]
mod docker_tests {
    use super::*;

    #[test]
    fn parses_ps_with_compose_labels_and_health() {
        let out = r#"{"CreatedAt":"2026-10-12 08:00:00 +0000 UTC","ID":"abc123","Image":"shop/app:2.14.0","Labels":"com.docker.compose.project=shop,com.docker.compose.service=app","Names":"shop-app-1","Ports":"9000/tcp","State":"running","Status":"Up 3 hours (healthy)"}
{"CreatedAt":"2026-10-12 08:00:00 +0000 UTC","ID":"def456","Image":"louislam/uptime-kuma:1","Labels":"","Names":"uptime-kuma","Ports":"0.0.0.0:3001->3001/tcp","State":"exited","Status":"Exited (1) 2 minutes ago"}"#;
        let list = parse_docker_ps(out, Some(0)).unwrap();
        assert_eq!(list.len(), 2);
        let app = list.iter().find(|c| c.name == "shop-app-1").unwrap();
        assert_eq!(app.project.as_deref(), Some("shop"));
        assert_eq!(app.service.as_deref(), Some("app"));
        assert_eq!(app.health.as_deref(), Some("healthy"));
        let kuma = list.iter().find(|c| c.name == "uptime-kuma").unwrap();
        assert_eq!(kuma.project, None);
        assert_eq!(kuma.state, "exited");
    }

    #[test]
    fn friendly_docker_errors() {
        assert!(parse_docker_ps("sh: 1: docker: not found", Some(127)).unwrap_err().contains("not installed"));
        assert!(parse_docker_ps(
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
            Some(1)
        )
        .unwrap_err()
        .contains("usermod"));
        assert_eq!(parse_docker_ps("", Some(0)).unwrap().len(), 0);
    }

    #[test]
    fn parses_stats_line() {
        let s = parse_docker_stats_line(r#"{"CPUPerc":"8.20%","ID":"abc","MemPerc":"5.31%","MemUsage":"412MiB / 7.6GiB","Name":"shop-app-1"}"#).unwrap();
        assert_eq!(s.cpu_pct, 8.2);
        assert_eq!(s.mem_usage, "412MiB / 7.6GiB");
        assert!(parse_docker_stats_line("garbage").is_none());
    }

    #[test]
    fn parses_services() {
        let out = "nginx.service loaded active running A high performance web server\n\
● php8.3-fpm.service loaded failed failed The PHP 8.3 FastCGI Process Manager\n\
cron.service loaded active running Regular background program processing daemon\n";
        let list = parse_services(out).unwrap();
        assert_eq!(list.len(), 3);
        let php = list.iter().find(|s| s.name == "php8.3-fpm").unwrap();
        assert_eq!(php.active, "failed");
    }

    #[test]
    fn parses_processes() {
        let out = "  812 www-data  9.1  2.3   86400 php-fpm8.3\n 1203 mysql     3.0 14.0 9900000 mysqld\nbad line\n";
        let p = parse_processes(out);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].pid, 812);
        assert_eq!(p[0].command, "php-fpm8.3");
        assert_eq!(p[1].elapsed_s, 9_900_000);
    }

    #[test]
    fn validates_refs() {
        assert!(valid_container_ref("shop-app-1"));
        assert!(!valid_container_ref("x; rm -rf /"));
        assert!(valid_since("2026-10-15T08:12:44.123456789Z"));
        assert!(!valid_since("$(id)"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(cpu: &str, rx: u64, tx: u64) -> String {
        format!(
            "cpu  {cpu}\n---\nMemTotal:        8000000 kB\nMemFree:          500000 kB\nMemAvailable:    4900000 kB\n---\n\
0.42 0.51 0.48 1/234 5678\n---\n3542400.12 6000000.00\n---\n/dev/vda1 82535812 66028352 12249824 81% /\n---\n\
Inter-|   Receive                                                |  Transmit\n \
face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n    \
lo: 999999 10 0 0 0 0 0 0 999999 10 0 0 0 0 0 0\n  eth0: {rx} 100 0 0 0 0 0 0 {tx} 100 0 0 0 0 0 0\n"
        )
    }

    #[test]
    fn first_sample_has_no_rates() {
        let (s, raw) = parse_metrics(&sample("100 0 100 800 0 0 0 0", 1000, 500), None, 1_000).unwrap();
        assert_eq!(s.cpu_pct, None);
        assert_eq!(s.ram_total_bytes, 8_000_000 * 1024);
        assert_eq!(s.ram_used_bytes, (8_000_000 - 4_900_000) * 1024);
        assert_eq!(s.disk_pct, 81.0);
        assert_eq!(s.load1, 0.42);
        assert_eq!(s.uptime_s, 3_542_400);
        assert_eq!(raw.net_rx, 1000); // loopback excluded
    }

    #[test]
    fn second_sample_computes_cpu_and_net() {
        let (_, prev) = parse_metrics(&sample("100 0 100 800 0 0 0 0", 1000, 500), None, 1_000).unwrap();
        // +100 total ticks, +75 idle → 25 % busy; +3000 rx / +1500 tx over 3 s
        let (s, _) = parse_metrics(&sample("115 0 110 875 0 0 0 0", 4000, 2000), Some(&prev), 4_000).unwrap();
        assert!((s.cpu_pct.unwrap() - 25.0).abs() < 0.01);
        assert_eq!(s.net_rx_bps, Some(1000));
        assert_eq!(s.net_tx_bps, Some(500));
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(parse_metrics("sh: docker: not found", None, 0).is_none());
    }
}
