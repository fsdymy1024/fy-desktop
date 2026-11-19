//! 托盘。桌面常驻应用没有主窗口可关，托盘就是唯一的入口。
//!
//! 左键 = 打开 / 收起控制中心（v1.1 起）；右键 = 自绘快捷菜单。
//! 菜单仍然是前端画的（`traypop` 小窗里的 #traymenu）：原生 Win32 托盘菜单的字体
//! 和配色是系统样式，没法跟随材质、也用不上组件的 MiSans。托盘只负责「图标被点了」——
//! 把图标的屏幕位置发给小窗，菜单本体、勾选状态和全部动作都归前端。
//!
//! 菜单为什么要有自己的窗口：主窗口是 `alwaysOnBottom` 的桌面层，菜单画在里面就永远
//! 压在别的窗口下面（v1.2.2 之前的 bug）。独立小窗自己是 `alwaysOnTop`，和系统托盘
//! 菜单一样浮在最上面，桌面组件也不用跟着被抬起来。
//!
//! 控制中心是独立的普通窗口（label = hub），不是桌面层里的浮层：
//! 它有任务栏按钮、能被 Alt+Tab 切到，也不会把桌面上的热区逻辑卷进来。

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

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
                // 这里全部换算成**屏幕物理像素**：菜单有自己的窗口，前端拿到的坐标
                // 直接就是它要摆的地方，不用再减主窗口原点。
                let app = tray.app_handle();
                let win = app.get_webview_window("main");
                let scale = win
                    .as_ref()
                    .and_then(|w| w.scale_factor().ok())
                    .unwrap_or(1.0);
                let icon: tauri::PhysicalPosition<f64> = rect.position.to_physical(scale);
                let size: tauri::PhysicalSize<f64> = rect.size.to_physical(scale);

                // 工作区 + 屏幕尺寸（都是屏幕物理像素），只给前端当**兜底夹取**用。
                // 菜单朝哪边弹由前端按图标位置判断——任务栏随时会被挪到另一条边，
                // 而这里读到的 work_area 只能反映「此刻」，不能拿来当方向的依据。
                // 任务栏永远在最上层，菜单一旦压到它那一条上就会被它盖住。
                let mon = win
                    .as_ref()
                    .and_then(|w| w.current_monitor().ok().flatten());
                let (wa, sw, sh) = match mon {
                    Some(m) => {
                        let r = m.work_area();
                        let s = m.size();
                        (
                            [
                                f64::from(r.position.x),
                                f64::from(r.position.y),
                                f64::from(r.size.width),
                                f64::from(r.size.height),
                            ],
                            f64::from(s.width),
                            f64::from(s.height),
                        )
                    }
                    None => ([0.0, 0.0, 0.0, 0.0], 0.0, 0.0),
                };

                open_menu(
                    app,
                    serde_json::json!({
                        "x": icon.x,
                        "y": icon.y,
                        "w": size.width,
                        "h": size.height,
                        "wa": wa,
                        "sw": sw,
                        "sh": sh,
                    }),
                );
            }
        })
        .build(app)?;

    Ok(())
}

/// 把「打开菜单」的请求交给 `traypop` 小窗。
///
/// 小窗的 WebView 可能比托盘晚就绪（开机后头一两秒），那时直接 emit 事件会静默丢失，
/// 表现就是「点了托盘没反应」。所以请求先落进 `state.tray_pending`：已就绪就立刻发，
/// 没就绪就等它 `traypop_ready` 时补发（后一次右键会覆盖前一次，符合直觉）。
fn open_menu(app: &AppHandle, payload: serde_json::Value) {
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        *crate::state::lock(&state.tray_pending) = Some(payload);
    }
    if !crate::TRAY_READY.load(std::sync::atomic::Ordering::SeqCst) {
        eprintln!("[tray] 菜单小窗还没就绪，请求先攒着");
    }
    crate::flush_tray_pending(app);
}
