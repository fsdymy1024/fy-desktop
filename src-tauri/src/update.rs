//! 检查更新。
//!
//! 数据源是 GitHub Releases（仓库 `fsdymy1024/fy-desktop`），不引入 Tauri 的
//! updater 插件：插件要求自己维护 latest.json 和一对签名密钥，对一个人维护的
//! 桌面小组件来说太重了——发布流程就是打完包把 setup.exe 挂到一个 release 上，
//! 直接读 release 就够了。
//!
//! 也不做「静默替换 exe」：桌面常驻程序把自己换掉，万一装到一半失败就再也起不来。
//! 这里的做法是「检查 → 告诉你 → 你点一下 → 下载并静默安装」，主动权在人手上。

use crate::consts::{REPO, UA};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// 手动检查的冷却时间：连着点「检查更新」不该连着打 GitHub（会吃 429）
pub const MANUAL_COOLDOWN: Duration = Duration::from_secs(30);
/// 自动检查之间至少隔这么久
pub const AUTO_COOLDOWN: Duration = Duration::from_secs(3600);

/// 最近一次检查结果。进程内缓存，避免重复请求，也让「检查失败后立刻再点」
/// 直接拿到同一条错误而不是再打一次网络。
static LAST_CHECK: Mutex<Option<(Instant, Update)>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug, Default)]
pub struct Update {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    /// release 的更新说明（markdown 原文，前端只做纯文本展示）
    pub notes: String,
    /// release 页面，浏览器打开用
    pub page: String,
    /// 安装包直链；没有匹配的 asset 时为空
    pub asset: String,
    pub size: u64,
    pub published: String,
    /// 非空 = 这次检查失败（仓库还没建、断网、被限流），页面里照实显示
    pub error: String,
}

/// 版本比较：只认 1.2.3 里的数字，`v` 前缀和 `-beta` 后缀都丢掉。
fn parts(v: &str) -> Vec<u32> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|s| s.parse::<u32>().unwrap_or(0))
        .collect()
}

fn newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parts(latest), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

/// 把 tag 洗成 `0.9.7` 这种纯数字点。`v` 前缀、`-beta` 后缀都丢掉；
/// 洗不出版本号（比如 Actions 模板没替换，tag 是 `v{{version}}`）就返回空串。
fn clean_version(tag: &str) -> String {
    let core = tag
        .trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .trim();
    let ok = core.split('.').count() >= 2
        && core
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if ok {
        core.to_string()
    } else {
        String::new()
    }
}

/// 从安装包文件名里取版本：`fy-desktop_0.9.7_x64-setup.exe` → `0.9.7`。
///
/// 打包器拼出来的名字一定和 exe 对得上，比手写的 tag 更可信——GitHub Actions
/// 的 `tagName` 模板没替换时 tag 会是 `v{{version}}` 字面量，只认 tag 的话
/// 「检查更新」永远判不出新版本。
fn version_from_name(name: &str) -> String {
    let spaced: String = name
        .chars()
        .map(|c| if c.is_ascii_digit() || c == '.' { c } else { ' ' })
        .collect();
    spaced
        .split_whitespace()
        .map(|s| s.trim_matches('.'))
        .find(|s| {
            s.split('.').count() >= 3
                && s.split('.')
                    .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        })
        .unwrap_or_default()
        .to_string()
}

pub async fn check() -> Update {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let mut out = Update {
        current: current.clone(),
        ..Default::default()
    };

    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = match crate::http::get(&url, Duration::from_secs(12))
        .header("User-Agent", UA)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            out.error = format!("连不上 GitHub：{e}");
            return out;
        }
    };

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        // 仓库存在但还没有任何 release 也是 404，这里区分不了，措辞上两个都提一句
        out.error = format!("{REPO} 还没有发布版本（或仓库尚未同步）");
        return out;
    }
    // 429 / 403 基本都是限流。GitHub 会带 Retry-After，照着告诉用户要等多久
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN {
        let wait = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .trim()
            .to_string();
        out.error = if wait.is_empty() {
            format!("GitHub 限流（{status}），请稍后再试")
        } else {
            format!("GitHub 限流（{status}），建议 {wait} 秒后重试")
        };
        return out;
    }
    if !status.is_success() {
        out.error = format!("GitHub 返回 {status}");
        return out;
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            out.error = format!("返回内容读不出来：{e}");
            return out;
        }
    };

    let tag = body.get("tag_name").and_then(|v| v.as_str()).unwrap_or("");
    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let name_of = |a: &serde_json::Value| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string()
    };

    // 版本号优先取安装包文件名（理由见 version_from_name），tag 只作兜底
    let asset_ver = assets
        .iter()
        .map(|a| version_from_name(&name_of(a)))
        .find(|v| !v.is_empty())
        .unwrap_or_default();
    let tag_ver = clean_version(tag);
    out.latest = if asset_ver.is_empty() {
        tag_ver.clone()
    } else {
        asset_ver
    };
    if !out.latest.is_empty() && tag_ver != out.latest {
        eprintln!(
            "[update] release tag 是 {tag:?}，改按安装包文件名认定 v{}",
            out.latest
        );
    }
    out.page = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    out.notes = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string();
    out.published = body
        .get("published_at")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .chars()
        .take(10)
        .collect();

    // 挑安装包：优先「文件名版本 = 最新版 + 带 setup」，再退到任意 setup，最后任意 exe。
    // 只有版本对得上的包才不会出现「提示 0.9.8、装上去还是 0.9.7」。
    let latest = out.latest.clone();
    let is_exe = |a: &serde_json::Value| name_of(a).to_ascii_lowercase().ends_with(".exe");
    let is_setup = |a: &serde_json::Value| is_exe(a) && name_of(a).contains("setup");
    let chosen = assets
        .iter()
        .find(|a| is_setup(a) && version_from_name(&name_of(a)) == latest)
        .or_else(|| assets.iter().find(|a| is_setup(a)))
        .or_else(|| assets.iter().find(|a| is_exe(a)));
    if let Some(a) = chosen {
        out.asset = a
            .get("browser_download_url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        out.size = a.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
    }

    out.has_update = !out.latest.is_empty() && newer(&out.latest, &current);
    out
}

/// 带节流的检查：`gap` 内重复调用直接返回上次结果。
///
/// 手动检查用 30s（点两下不该打两次 GitHub），自动检查用 1h。
/// 注意这只在本进程内生效——进程重启后计数清零，但自动检查本来也只跑一次。
pub async fn check_throttled(gap: Duration) -> Update {
    let cached = {
        let g = crate::state::lock(&LAST_CHECK);
        g.as_ref().map(|(at, u)| (at.elapsed(), u.clone()))
    };
    if let Some((elapsed, u)) = cached {
        if elapsed < gap {
            eprintln!("[update] {}s 内已检查过，直接用上次结果", gap.as_secs());
            return u;
        }
    }
    let u = check().await;
    *crate::state::lock(&LAST_CHECK) = Some((Instant::now(), u.clone()));
    u
}

/// 启动后自动检查（配置里 auto_update 关掉就不查）。
/// 只发事件，不弹窗——桌面上突然弹个更新框很打扰，交给「关于」页和一条 toast。
pub fn spawn_auto_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio_sleep(Duration::from_secs(10)).await;
        let on = app
            .try_state::<crate::state::AppState>()
            .map(|s| s.config().auto_update)
            .unwrap_or(false);
        if !on {
            eprintln!("[update] 自动更新已关闭，跳过检查");
            return;
        }
        let u = check_throttled(AUTO_COOLDOWN).await;
        if !u.error.is_empty() {
            eprintln!("[update] 检查失败：{}", u.error);
            return;
        }
        eprintln!(
            "[update] 当前 {} / 最新 {} / 有新版 {}",
            u.current, u.latest, u.has_update
        );
        if u.has_update {
            let _ = app.emit("update:available", &u);
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

/// 下载安装包到临时目录，返回文件路径。
///
/// 流式写盘，每 ~120ms 推一次 `update:download`（已下载 / 总大小），关于页据此
/// 画进度——慢网下 2MB 也要十几秒，没有反馈用户会以为卡死了。下载不完整就删掉
/// 残包，别把一个半截 exe 交给安装程序。
pub async fn download(app: &AppHandle, asset: &str, version: &str) -> Result<String, String> {
    if asset.is_empty() {
        return Err("这个版本没有提供 exe 安装包".into());
    }
    let mut resp = crate::http::get(asset, Duration::from_secs(180))
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let path = std::env::temp_dir().join(format!("fy-desktop_{version}_x64-setup.exe"));
    let mut file = std::fs::File::create(&path).map_err(|e| format!("写文件失败：{e}"))?;

    use std::io::Write;
    let mut got: u64 = 0;
    let mut last = std::time::Instant::now();
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(format!("下载中断：{e}"));
            }
        };
        if let Err(e) = file.write_all(&chunk) {
            drop(file);
            let _ = std::fs::remove_file(&path);
            return Err(format!("写文件失败：{e}"));
        }
        got += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(120) {
            last = std::time::Instant::now();
            let _ = app.emit(
                "update:download",
                serde_json::json!({ "downloaded": got, "total": total, "done": false }),
            );
        }
    }
    let _ = file.sync_all();
    drop(file);
    let _ = app.emit(
        "update:download",
        serde_json::json!({ "downloaded": got, "total": total, "done": true }),
    );
    if total > 0 && got != total {
        let _ = std::fs::remove_file(&path);
        return Err(format!("下载不完整：{got}/{total} 字节"));
    }
    Ok(path.to_string_lossy().to_string())
}

/// 跑安装包（`/S` 静默），然后退出自己——不然安装程序动不了正在运行的 exe。
pub fn run_installer(path: &str) -> Result<(), String> {
    use std::process::Command;
    if !std::path::Path::new(path).exists() {
        return Err("安装包不见了，请重新下载".into());
    }
    let mut cmd = Command::new(path);
    cmd.arg("/S");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(|e| format!("启动安装包失败：{e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tag_clean_rejects_template() {
        assert_eq!(clean_version("v0.9.7"), "0.9.7");
        assert_eq!(clean_version("0.9.7"), "0.9.7");
        assert_eq!(clean_version("v0.9.7-beta.1"), "0.9.7");
        // Actions 的 tagName 模板没替换时会变成这种字面量，必须判成无效
        assert_eq!(clean_version("v{{version}}"), "");
        assert_eq!(clean_version("v__VERSION__"), "");
        assert_eq!(clean_version(""), "");
    }

    #[test]
    fn asset_name_carries_version() {
        assert_eq!(version_from_name("fy-desktop_0.9.7_x64-setup.exe"), "0.9.7");
        assert_eq!(
            version_from_name("fy-desktop_0.10.12_x64-setup.exe"),
            "0.10.12"
        );
        assert_eq!(version_from_name("fy-desktop.exe"), "");
    }

    #[test]
    fn version_compare() {
        assert!(newer("0.9.10", "0.9.9"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.9.7", "0.9.7"));
        assert!(!newer("0.9.6", "0.9.7"));
    }
}
