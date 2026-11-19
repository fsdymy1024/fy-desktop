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
                // rect 是 tray-icon 给的物理矩形（它被包成了 `Position` / `Size` 枚举，
                // 取值要用 `to_physical`——对 Physical 变体是恒等转换，不会重复乘缩放）。
                // 这里只做「屏幕坐标 → 窗口坐标」，前端统一除以 dpr。
                let app = tray.app_handle();
                let win = app.get_webview_window("main");
                let scale = win
                    .as_ref()
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let icon: tauri::PhysicalPosition<f64> = rect.position.to_physical(scale);
                let size: tauri::PhysicalSize<f64> = rect.size.to_physical(scale);
                let (ox, oy) = win
                    .as_ref()
                    .and_then(|w| w.outer_position().ok())
                    .map(|p| (p.x, p.y))
                    .unwrap_or((0, 0));

                // 工作区（相对窗口，物理像素），只给前端当**兜底夹取**用。
                // 菜单朝哪边弹由前端按图标位置判断——任务栏随时会被挪到另一条边，
                // 而这里读到的 work_area 只能反映「此刻」，不能拿来当方向的依据。
                // 窗口铺满整屏（含任务栏区域），菜单一旦压到任务栏那一条上就会被它盖住。
                let wa = win
                    .as_ref()
                    .and_then(|w| w.current_monitor().ok().flatten())
                    .map(|m| {
                        let r = m.work_area();
                        [
                            f64::from(r.position.x - ox),
                            f64::from(r.position.y - oy),
                            f64::from(r.size.width),
                            f64::from(r.size.height),
                        ]
                    })
                    .unwrap_or([0.0, 0.0, 0.0, 0.0]);

                let _ = app.emit(
                    "tray:open-menu",
                    serde_json::json!({
                        "x": icon.x - f64::from(ox),
                        "y": icon.y - f64::from(oy),
                        "w": size.width,
                        "h": size.height,
                        "wa": wa,
                    }),
                );
            }
        })
        .build(app)?;

    Ok(())
}
