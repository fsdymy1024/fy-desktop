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
    /// IP 所属网卡名（如「WLAN」「以太网」），让「这是哪块网卡的地址」一眼可见
    pub iface: String,
    /// 出口网卡的协商速率（bps），0 表示取不到。
    /// 有线是自协商结果（100M / 1G / 2.5G），Wi-Fi 是当前物理层速率。
    pub link_speed: u64,
    pub link: Link,
    pub down_history: Vec<u64>,
}

static LATENCY: AtomicU32 = AtomicU32::new(0);

/// 上次抓到的 Wi-Fi 信息，netsh 开销大，按 12s 复用。
/// 用 None 表示「还没查过」——这样静态初始化仍然是 const 的。
static WIFI: Mutex<Option<(Link, Instant)>> = Mutex::new(None);

pub fn wifi_link() -> Link {
    let mut guard = crate::state::lock(&WIFI);
    let fresh = guard
        .as_ref()
        .map(|(link, at)| !link.kind.is_empty() && at.elapsed() < crate::consts::WIFI_CACHE_TTL)
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
    let addr = match crate::consts::PROBE_HOST.parse::<std::net::IpAddr>() {
        Ok(ip) => std::net::SocketAddr::new(ip, crate::consts::PROBE_PORT),
        Err(_) => return 0,
    };
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

/// 出口网卡 IP。
///
/// 旧实现是「遍历所有网卡，取第一个非回环 IPv4」，但网卡顺序不等于路由顺序：
/// 装了 VMware / Hyper-V / WSL / VirtualBox 的机器上经常先返回虚拟网卡，
/// 卡片上就会显示一个根本不通外网的地址。
///
/// 这里改成让内核自己回答：对公网地址做一次 UDP `connect`（不发送任何数据包），
/// 路由表选定出口网卡后，`local_addr()` 就是那块网卡的地址。
fn egress_ip() -> Option<std::net::Ipv4Addr> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    // connect 对 UDP 只是记录对端，不产生流量
    sock.connect(crate::consts::EGRESS_PROBE).ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4),
        _ => None,
    }
}

/// 虚拟网卡：兜底扫描时要跳过，否则又会挑到它们
const VIRTUAL_HINTS: &[&str] = &[
    "vmware", "virtualbox", "vethernet", "hyper-v", "loopback", "tap-", "tun", "wsl",
    "docker", "npcap", "bluetooth",
];

fn looks_virtual(name: &str) -> bool {
    let n = name.to_lowercase();
    VIRTUAL_HINTS.iter().any(|h| n.contains(h))
}

/// 返回 (IP, 网卡名)
fn net_identity(nets: &Networks) -> (String, String) {
    if let Some(v4) = egress_ip() {
        let ip = v4.to_string();
        for (name, data) in nets.iter() {
            if data.ip_networks().iter().any(|n| n.addr.to_string() == ip) {
                return (ip, name.to_string_lossy().to_string());
            }
        }
        return (ip, String::new());
    }
    scan_ip(nets)
}

/// 兜底：路由查询失败时（极少见）扫网卡，但跳过虚拟适配器
fn scan_ip(nets: &Networks) -> (String, String) {
    let mut fallback: Option<(String, String)> = None;
    for (name, data) in nets.iter() {
        for ipn in data.ip_networks() {
            if let IpAddr::V4(v4) = ipn.addr {
                if v4.is_loopback() || v4.is_link_local() {
                    continue;
                }
                let hit = (v4.to_string(), name.to_string_lossy().to_string());
                if !looks_virtual(&name.to_string_lossy()) {
                    return hit;
                }
                fallback.get_or_insert(hit);
            }
        }
    }
    fallback.unwrap_or_default()
}

/// 出口网卡的协商速率（bps）。
///
/// `sysinfo` 在 Windows 上读的就是 `MIB_IF_ROW2` 的链路速率：有线是自协商结果，
/// Wi-Fi 是当前物理层速率（会随信号 / 频段变化）。接收与发送各取一次、取大的那个，
/// 个别无线网卡只报其中一边。取不到（刚断线、驱动不报）返回 0，前端显示「--」。
fn link_speed(nets: &Networks, iface: &str) -> u64 {
    if iface.is_empty() {
        return 0;
    }
    nets.iter()
        .find(|(name, _)| name.to_string_lossy() == iface)
        .map(|(_, data)| {
            data.transmit_link_speed()
                .unwrap_or(0)
                .max(data.receive_link_speed().unwrap_or(0))
        })
        .unwrap_or(0)
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

/// 自检/诊断用：单独探一次出口网卡身份
pub fn egress_probe() -> (String, String) {
    match Networks::new_with_refreshed_list() {
        Ok(nets) => net_identity(&nets),
        Err(_) => (String::new(), String::new()),
    }
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

        // 推送连续失败时降频：窗口销毁/重建期间 emit 会一直报错，
        // 每秒打一条日志既没用又刷屏
        let mut emit_fail: u32 = 0;

        loop {
            std::thread::sleep(crate::consts::METRICS_INTERVAL);
            if crate::is_shutting_down() {
                eprintln!("[monitor] 收到退出信号，停止采集");
                return;
            }
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

            if tick % crate::consts::DISK_REFRESH_TICKS == 0 {
                disks.refresh(true);
            }

            history.push_back(smooth_down.max(0.0) as u64);
            while history.len() > HISTORY {
                history.pop_front();
            }

            let total_mem = sys.total_memory().max(1);
            let (ip, iface) = net_identity(&nets);
            let rate = link_speed(&nets, &iface);
            let metrics = Metrics {
                cpu: sys.global_cpu_usage().clamp(0.0, 100.0),
                mem: (sys.used_memory() as f64 / total_mem as f64 * 100.0) as f32,
                disk: disk_usage(&disks),
                cores: sys.cpus().len(),
                uptime: System::uptime().unwrap_or(0),
                down: smooth_down,
                up: smooth_up,
                latency: LATENCY.load(Ordering::Relaxed),
                ip,
                iface,
                link_speed: rate,
                link: wifi_link(),
                down_history: history.iter().copied().collect(),
            };

            if tick == 1 {
                eprintln!(
                    "[monitor] 首帧 cpu={:.1} mem={:.1} disk={:.1} down={:.0} ip={} iface={} speed={}",
                    metrics.cpu,
                    metrics.mem,
                    metrics.disk,
                    metrics.down,
                    metrics.ip,
                    metrics.iface,
                    metrics.link_speed
                );
            }
            match app.emit("metrics", &metrics) {
                Ok(()) => emit_fail = 0,
                Err(e) => {
                    emit_fail += 1;
                    if emit_fail == 1 || emit_fail % 30 == 0 {
                        eprintln!("[monitor] 推送失败（第 {emit_fail} 次）: {e}");
                    }
                    // 连续失败说明前端长时间不在（页面重建中），退避一下再试
                    if emit_fail > 5 {
                        std::thread::sleep(Duration::from_millis(1000 * (emit_fail.min(10) as u64)));
                    }
                }
            }
        }
    });
}

fn spawn_latency() {
    std::thread::spawn(|| loop {
        if crate::is_shutting_down() {
            return;
        }
        let ms = probe_latency();
        LATENCY.store(ms, Ordering::Relaxed);
        std::thread::sleep(crate::consts::LATENCY_INTERVAL);
    });
}
