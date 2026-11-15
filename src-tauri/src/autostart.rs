//! 开机自启。
//!
//! 安装包是 per-user 的（装到 `%LOCALAPPDATA%`），所以自启项也只写
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`，绝不碰 HKLM ——
//! 否则一旦以管理员身份跑过一次，就会给这台机器的**所有用户**挂上一个
//! 指向当前用户目录的启动项，别人登录后看到的是一个 404。
//!
//! 用的 `auto-launch` 就是 Tauri 插件的内核，只是插件把模式写死成
//! `Dynamic`（先试 HKLM、失败再退 HKCU），这里显式指定 `CurrentUser`。

#[cfg(windows)]
use auto_launch::{AutoLaunch, WindowsEnableMode};

pub const APP_NAME: &str = "fy-desktop";
/// 启动参数，方便应用知道自己是被系统拉起来的（不弹编辑模式、不抢焦点）
pub const ARG: &str = "--autostart";

#[cfg(windows)]
fn launcher() -> Result<AutoLaunch, String> {
    let exe = std::env::current_exe().map_err(|e| format!("取不到自身路径：{e}"))?;
    Ok(AutoLaunch::new(
        APP_NAME,
        &exe.to_string_lossy(),
        WindowsEnableMode::CurrentUser,
        &[ARG],
    ))
}

/// 当前是否已登记自启。读失败按「没开」处理，别让 UI 卡住。
#[cfg(windows)]
pub fn is_enabled() -> bool {
    launcher()
        .and_then(|l| l.is_enabled().map_err(|e| e.to_string()))
        .unwrap_or(false)
}

#[cfg(windows)]
pub fn set(on: bool) -> Result<(), String> {
    let l = launcher()?;
    let r = if on { l.enable() } else { l.disable() };
    r.map_err(|e| e.to_string())
}

// 非 Windows 平台先留空实现，编译不受影响
#[cfg(not(windows))]
pub fn is_enabled() -> bool {
    false
}

#[cfg(not(windows))]
pub fn set(_on: bool) -> Result<(), String> {
    Err("当前平台不支持".into())
}

/// 把配置里的意愿同步到系统。只在真正不一致时写注册表。
pub fn apply(want: bool) -> Result<bool, String> {
    let now = is_enabled();
    if want != now {
        set(want)?;
    }
    Ok(want)
}
