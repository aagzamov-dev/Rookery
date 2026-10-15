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
