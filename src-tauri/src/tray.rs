//! 托盘。桌面常驻应用没有主窗口可关，托盘就是唯一的入口。
//!
//! 左键 = 打开 / 收起控制中心（v1.1 起）；右键 = 自绘快捷菜单。
//! 菜单仍然是前端画的（#traymenu）：原生 Win32 托盘菜单的字体和配色是系统样式，
//! 没法跟随材质、也用不上组件的 MiSans。托盘只负责「图标被点了」——
//! 把图标的屏幕位置发给前端，菜单本体、勾选状态和全部动作都归前端。
//!
//! 控制中心是独立的普通窗口（label = hub），不是桌面层里的浮层：
//! 它有任务栏按钮、能被 Alt+Tab 切到，也不会把桌面上的热区逻辑卷进来。

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("fy-desktop · 左键打开控制中心")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                rect,
                button,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // 左键：控制中心。收起/聚焦的判定放在命令里，带双击保护。
                if matches!(button, MouseButton::Left) {
                    crate::commands::toggle_hub(tray.app_handle());
                    return;
                }

                // 右键：贴着图标弹自绘菜单。
                // rect 是托盘图标在屏幕上的物理位置，前端拿它把菜单贴着图标弹出。
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
