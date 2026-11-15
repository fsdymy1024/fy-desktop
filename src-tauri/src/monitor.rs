//! 系统 / 网络指标采集。
//!
//! 全部由后台线程采样后通过事件推送，前端不轮询：
//! - CPU / 内存 / 网速：1s
//! - 磁盘：15s（读盘有开销）
//! - 延迟：5s（TCP 握手，不用 ICMP，避免管理员权限）
//! - Wi-Fi：12s（要 spawn netsh，缓存住）

use serde::Serialize;
use std::collections::VecDeque;
use std::net::{IpAddr, TcpStream};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};
use tauri::{AppHandle, Emitter};

const HISTORY: usize = 24;

#[derive(Debug, Clone, Serialize, Default)]
pub struct Link {
    /// wifi | ethernet | none
    pub kind: String,
    pub name: String,
    pub ssid: String,
    /// 0-100，有线为 None
    pub signal: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Metrics {
    pub cpu: f32,
    pub mem: f32,
    pub disk: f32,
    pub cores: usize,
    pub uptime: u64,
    /// bytes/s
    pub down: f64,
    pub up: f64,
    pub latency: u32,
    pub ip: String,
    pub link: Link,
    pub down_history: Vec<u64>,
}

static LATENCY: AtomicU32 = AtomicU32::new(0);

/// 上次抓到的 Wi-Fi 信息，netsh 开销大，按 12s 复用。
/// 用 None 表示「还没查过」——这样静态初始化仍然是 const 的。
static WIFI: Mutex<Option<(Link, Instant)>> = Mutex::new(None);

pub fn wifi_link() -> Link {
    let mut guard = match WIFI.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let fresh = guard
        .as_ref()
        .map(|(link, at)| !link.kind.is_empty() && at.elapsed() < Duration::from_secs(12))
        .unwrap_or(false);
    if fresh {
        return guard.as_ref().map(|(l, _)| l.clone()).unwrap_or_default();
    }
    let link = query_wifi();
    *guard = Some((link.clone(), Instant::now()));
    link
}

/// 解析 `netsh wlan show interfaces`。
/// 不同语言的 Windows 输出不同，但 SSID 与百分号的格式是稳定的。
fn query_wifi() -> Link {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("netsh")
            .args(["wlan", "show", "interfaces"])
            .creation_flags(0x0800_0000)
            .output();

        if let Ok(o) = out {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let mut ssid = String::new();
            let mut signal = None;
            let mut name = String::new();

            for line in text.lines() {
                let l = line.trim();
                if let Some((k, v)) = l.split_once(':') {
                    let key = k.trim().to_lowercase();
                    let val = v.trim().to_string();
                    // BSSID 以 bssid 开头，不会误中 ssid 分支
                    if key.starts_with("ssid") {
                        ssid = val;
                    } else if (key.contains("name") || key.contains("名称")) && name.is_empty() {
                        name = val;
                    } else if key.contains("signal") || key.contains("信号") {
                        signal = val
                            .trim_end_matches('%')
                            .parse::<u32>()
                            .ok()
                            .or_else(|| first_percent(&val));
                    }
                }
            }

            if !ssid.is_empty() {
                return Link {
                    kind: "wifi".into(),
                    name: if name.is_empty() { ssid.clone() } else { name },
                    ssid,
                    signal,
                };
            }
        }

        Link {
            kind: "ethernet".into(),
            name: String::new(),
            ssid: String::new(),
            signal: None,
        }
    }
    #[cfg(not(windows))]
    {
        Link::default()
    }
}

fn first_percent(s: &str) -> Option<u32> {
    s.split(|c: char| !c.is_ascii_digit())
        .filter(|p| !p.is_empty())
        .next()
        .and_then(|p| p.parse().ok())
}

fn probe_latency() -> u32 {
    let start = Instant::now();
    // 阿里 DNS 的 443，比 ICMP 稳且不需要提权
    let addr = std::net::SocketAddr::from(([223, 5, 5, 5], 443));
    match TcpStream::connect_timeout(&addr, Duration::from_millis(900)) {
        Ok(_) => start.elapsed().as_millis().min(999) as u32,
        Err(_) => 0,
    }
}

fn total_bytes(nets: &Networks) -> (u64, u64) {
    let mut rx = 0;
    let mut tx = 0;
    for (_, data) in nets.iter() {
        rx += data.total_received();
        tx += data.total_transmitted();
    }
    (rx, tx)
}

fn local_ip(nets: &Networks) -> String {
    for (_, data) in nets.iter() {
        for ipn in data.ip_networks() {
            let addr = ipn.addr;
            match addr {
                IpAddr::V4(v4) => {
                    if !v4.is_loopback() && !v4.is_link_local() {
                        return v4.to_string();
                    }
                }
                IpAddr::V6(_) => {}
            }
        }
    }
    String::new()
}

fn disk_usage(disks: &Disks) -> f32 {
    let mut best: Option<(u64, u64)> = None;
    for d in disks.iter() {
        let mount = d.mount_point().to_string_lossy().to_uppercase();
        if mount.starts_with('C') {
            best = Some((d.total_space(), d.available_space()));
            break;
        }
    }
    let (total, avail) = best.unwrap_or_else(|| {
        let mut t = 0;
        let mut a = 0;
        for d in disks.iter() {
            t += d.total_space();
            a += d.available_space();
        }
        (t, a)
    });
    if total == 0 {
        return 0.0;
    }
    (((total - avail) as f64 / total as f64) * 100.0) as f32
}

pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        // sysinfo 0.40 把这几个构造器改成了 Result，拿不到就直接放弃采集，
        // 而不是让整个后台线程 panic
        let (mut sys, mut nets, mut disks) = match (
            System::new(),
            Networks::new_with_refreshed_list(),
            Disks::new_with_refreshed_list(),
        ) {
            (Ok(s), Ok(n), Ok(d)) => (s, n, d),
            _ => {
                eprintln!("[monitor] 初始化失败，指标采集退出");
                return;
            }
        };
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        // CPU 用量靠两次刷新之间的差值；先让它跑一小会儿再取第一次值
        std::thread::sleep(Duration::from_millis(400));
        sys.refresh_cpu_usage();

        let (mut last_rx, mut last_tx) = total_bytes(&nets);
        let mut last_at = Instant::now();
        let mut history: VecDeque<u64> = VecDeque::with_capacity(HISTORY);
        let mut smooth_down = 0.0_f64;
        let mut smooth_up = 0.0_f64;
        let mut tick: u32 = 0;

        // 延迟单独线程，避免 900ms 的超时把 1s 心跳拖歪
        spawn_latency();

        loop {
            std::thread::sleep(Duration::from_millis(1000));
            tick += 1;

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            nets.refresh(true);

            let (rx, tx) = total_bytes(&nets);
            let dt = last_at.elapsed().as_secs_f64().max(0.001);
            let down_raw = (rx.saturating_sub(last_rx)) as f64 / dt;
            let up_raw = (tx.saturating_sub(last_tx)) as f64 / dt;
            last_rx = rx;
            last_tx = tx;
            last_at = Instant::now();

            // 指数平滑：原始值每帧跳得厉害，直接显示会闪
            let a = 0.45;
            smooth_down = smooth_down * (1.0 - a) + down_raw * a;
            smooth_up = smooth_up * (1.0 - a) + up_raw * a;

            if tick % 15 == 0 {
                disks.refresh(true);
            }

            history.push_back(smooth_down.max(0.0) as u64);
            while history.len() > HISTORY {
                history.pop_front();
            }

            let total_mem = sys.total_memory().max(1);
            let metrics = Metrics {
                cpu: sys.global_cpu_usage().clamp(0.0, 100.0),
                mem: (sys.used_memory() as f64 / total_mem as f64 * 100.0) as f32,
                disk: disk_usage(&disks),
                cores: sys.cpus().len(),
                uptime: System::uptime().unwrap_or(0),
                down: smooth_down,
                up: smooth_up,
                latency: LATENCY.load(Ordering::Relaxed),
                ip: local_ip(&nets),
                link: wifi_link(),
                down_history: history.iter().copied().collect(),
            };

            if tick == 1 {
                eprintln!(
                    "[monitor] 首帧 cpu={:.1} mem={:.1} disk={:.1} down={:.0}",
                    metrics.cpu, metrics.mem, metrics.disk, metrics.down
                );
            }
            if let Err(e) = app.emit("metrics", &metrics) {
                eprintln!("[monitor] 推送失败: {e}");
            }
        }
    });
}

fn spawn_latency() {
    std::thread::spawn(|| loop {
        let ms = probe_latency();
        LATENCY.store(ms, Ordering::Relaxed);
        std::thread::sleep(Duration::from_secs(5));
    });
}
