//! 检查更新。
//!
//! 数据源是 GitHub Releases（仓库 `fsdymy1024/fy-desktop`），不引入 Tauri 的
//! updater 插件：插件要求自己维护 latest.json 和一对签名密钥，对一个人维护的
//! 桌面小组件来说太重了——发布流程就是打完包把 setup.exe 挂到一个 release 上，
//! 直接读 release 就够了。
//!
//! 也不做「静默替换 exe」：桌面常驻程序把自己换掉，万一装到一半失败就再也起不来。
//! 这里的做法是「检查 → 告诉你 → 你点一下 → 下载并静默安装」，主动权在人手上。

use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const REPO: &str = "fsdymy1024/fy-desktop";
const UA: &str = "fy-desktop-updater";

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

pub async fn check() -> Update {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let mut out = Update {
        current: current.clone(),
        ..Default::default()
    };

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            out.error = e.to_string();
            return out;
        }
    };

    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = match client
        .get(&url)
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

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        // 仓库存在但还没有任何 release 也是 404，这里区分不了，措辞上两个都提一句
        out.error = format!("{REPO} 还没有发布版本（或仓库尚未同步）");
        return out;
    }
    if !resp.status().is_success() {
        out.error = format!("GitHub 返回 {}", resp.status());
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
    out.latest = tag.trim_start_matches(['v', 'V']).to_string();
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

    // 挑安装包：优先名字里带 setup 的 .exe，没有再退回第一个 .exe
    let assets = body
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let pick = |needle: &str| {
        assets
            .iter()
            .find(|a| {
                a.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.ends_with(".exe") && n.contains(needle))
                    .unwrap_or(false)
            })
            .and_then(|a| a.get("browser_download_url").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
    };
    out.asset = pick("setup")
        .or_else(|| pick(""))
        .unwrap_or_default();
    out.size = assets
        .iter()
        .find(|a| {
            a.get("browser_download_url")
                .and_then(|v| v.as_str())
                .map(|u| u == out.asset)
                .unwrap_or(false)
        })
        .and_then(|a| a.get("size").and_then(|v| v.as_u64()))
        .unwrap_or(0);

    out.has_update = !out.latest.is_empty() && newer(&out.latest, &current);
    out
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
        let u = check().await;
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
pub async fn download(asset: &str, version: &str) -> Result<String, String> {
    if asset.is_empty() {
        return Err("这个版本没有提供 exe 安装包".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(asset)
        .header("User-Agent", UA)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("下载中断：{e}"))?;
    let path = std::env::temp_dir().join(format!("fy-desktop_{version}_x64-setup.exe"));
    std::fs::write(&path, &bytes).map_err(|e| format!("写文件失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 跑安装包（`/S` 静默），然后退出自己——不然安装程序动不了正在运行的 exe。
pub fn run_installer(path: &str) -> Result<(), String> {
    use std::process::Command;
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
