//! 业务常量集中处。
//!
//! 这些值以前散在各个模块里（更新仓库、探测地址、采样周期、分组配色），
//! 改一处忘一处就会出现「天气 15 分钟、延迟 5 秒、Wi-Fi 12 秒」这种周期对不上的
//! 问题。集中之后只有一个事实源，也方便自检/文档引用。

use std::time::Duration;

/* ------------------------------ 对外地址 ------------------------------ */

/// 更新源仓库（GitHub Releases）
pub const REPO: &str = "fsdymy1024/fy-desktop";
/// 所有对外请求共用的 UA。GitHub API 不带 UA 会直接 403
pub const UA: &str = "fy-desktop";
/// 延迟探测目标：阿里 DNS 的 443。走 TCP 握手而不是 ICMP，不需要提权
pub const PROBE_HOST: &str = "223.5.5.5";
pub const PROBE_PORT: u16 = 443;
/// 出口网卡探测用的对端。UDP connect 只记录路由，不产生任何流量
pub const EGRESS_PROBE: &str = "223.5.5.5:80";

/* ------------------------------ 采样周期 ------------------------------ */

pub const WEATHER_INTERVAL: Duration = Duration::from_secs(900);
pub const METRICS_INTERVAL: Duration = Duration::from_secs(1);
/// 每 N 个指标心跳刷一次磁盘（读盘有开销）
pub const DISK_REFRESH_TICKS: u32 = 15;
pub const LATENCY_INTERVAL: Duration = Duration::from_secs(5);
/// netsh 开销大，Wi-Fi 信息按这个周期复用
pub const WIFI_CACHE_TTL: Duration = Duration::from_secs(12);
/// 所有 HTTP 请求的默认超时
pub const HTTP_TIMEOUT: Duration = Duration::from_secs(12);

/* ------------------------------ 界面常量 ------------------------------ */

/// 分组配色：新建分组自动取色 + 前端图标占位色块共用同一套（由 `boot` 下发）
pub const GROUP_COLORS: [&str; 7] = [
    "#3d8bf0", "#b16ce0", "#2fa27c", "#e2712c", "#8d9aa6", "#d94f70", "#0f9bb0",
];

/// 合法材质枚举。空串表示「跟随全局」
pub const MATERIALS: [&str; 3] = ["glass", "dusk", "solid"];

/// 三档尺寸的标识
pub const SIZES: [&str; 3] = ["s", "m", "l"];
