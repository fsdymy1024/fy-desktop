//! 托盘。桌面常驻应用没有主窗口可关，托盘就是唯一的入口。
//!
//! 菜单是前端自绘的（#traymenu）：原生 Win32 托盘菜单的字体和配色是系统样式，
//! 没法跟随材质、也用不上组件的 MiSans。托盘只负责「图标被点了」——
//! 把图标的屏幕位置发给前端，菜单本体、勾选状态和全部动作都归前端
//! （前端再走 open_root / open_config_dir / set_autostart / quit_app 这些命令）。

use tauri::tray::{MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("fy-desktop")
        // 左键、右键都弹自绘菜单（原来左键也是弹菜单，行为保持一致）。
        // rect 是托盘图标在屏幕上的物理位置，前端拿它把菜单贴着图标弹出。
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let scale = tray
                    .app_handle()
                    .get_webview_window("main")
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let p: tauri::PhysicalPosition<f64> = rect.position.to_physical(scale);
                let s: tauri::PhysicalSize<f64> = rect.size.to_physical(scale);
                let _ = tray.app_handle().emit(
                    "tray:open-menu",
                    serde_json::json!({ "x": p.x, "y": p.y, "w": s.width, "h": s.height }),
                );
            }
        })
        .build(app)?;

    Ok(())
}
