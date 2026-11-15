//! 窗口定位与「鼠标穿透」守卫。
//!
//! Tauri 的 `set_ignore_cursor_events(true)` 只是加 `WS_EX_TRANSPARENT`，
//! 不像 Electron 那样有 `forward` 选项——穿透状态下窗口收不到任何鼠标事件，
//! 所以「移到组件上才接管鼠标」这件事不能靠前端 mousemove 判断。
//!
//! 改成后端做：前端把需要交互的矩形（卡片、面板、按钮）报上来，
//! 后台线程以 30ms 轮询全局光标，命中就取消穿透，离开就恢复穿透。

use crate::state::AppState;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[cfg(windows)]
use windows::Win32::Foundation::POINT;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// 铺满整个屏幕（含任务栏区域）。坐标与抓屏底图完全对齐，
/// 毛玻璃才能一像素不差地贴到桌面内容上。
pub fn fill_screen(win: &WebviewWindow) -> tauri::Result<()> {
    // 必须用主屏：扩展屏在虚拟坐标里可能是负偏移，
    // 那样「光标坐标」和「窗口内坐标」就对不上，热区判定会整体偏移。
    let monitor = match win.primary_monitor()? {
        Some(m) => m,
        None => return Ok(()),
    };
    let pos = monitor.position();
    let size = monitor.size();
    win.set_position(PhysicalPosition::new(pos.x, pos.y))?;
    win.set_size(PhysicalSize::new(size.width, size.height))?;
    Ok(())
}

pub fn spawn_hit_guard(app: AppHandle) {
    std::thread::spawn(move || {
        let mut last = true; // 初始是穿透
        loop {
            std::thread::sleep(std::time::Duration::from_millis(30));

            let Some(win) = app.get_webview_window("main") else {
                continue;
            };
            let state = app.state::<AppState>();
            let (regions, force) = {
                let h = match state.hit.lock() {
                    Ok(h) => h,
                    Err(p) => p.into_inner(),
                };
                (h.regions.clone(), h.force)
            };

            #[cfg(windows)]
            let inside = {
                let mut pt = POINT::default();
                let ok = unsafe { GetCursorPos(&mut pt) };
                if ok.is_err() {
                    false
                } else {
                    let (x, y) = (pt.x as f64, pt.y as f64);
                    force
                        || regions
                            .iter()
                            .any(|r| x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])
                }
            };
            #[cfg(not(windows))]
            let inside = force;

            let ignore = !inside;
            if ignore != last {
                last = ignore;
                let _ = win.set_ignore_cursor_events(ignore);
                if let Ok(mut h) = state.hit.lock() {
                    h.ignoring = ignore;
                }
            }
        }
    });
}

/// 显示窗口但不激活它。
///
/// 开机自启时如果直接 show()，窗口会抢走前台焦点，把用户正在打的字顶掉。
/// 桌面层本来就不需要键盘焦点，所以统一用 SW_SHOWNOACTIVATE。
#[cfg(windows)]
pub fn show_no_activate(hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
    unsafe {
        let _ = ShowWindow(windows::Win32::Foundation::HWND(hwnd as *mut _), SW_SHOWNOACTIVATE);
    }
}

#[cfg(not(windows))]
pub fn show_no_activate(_hwnd: isize) {}

/// 临时置顶（自检截图时用）
#[cfg(windows)]
pub fn raise_temporarily(hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    unsafe {
        let _ = SetWindowPos(
            windows::Win32::Foundation::HWND(hwnd as *mut _),
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// 放回桌面层
#[cfg(windows)]
pub fn restore_to_desktop(hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };
    unsafe {
        let _ = SetWindowPos(
            windows::Win32::Foundation::HWND(hwnd as *mut _),
            Some(HWND_BOTTOM),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

#[cfg(not(windows))]
pub fn raise_temporarily(_hwnd: isize) {}

#[cfg(not(windows))]
pub fn restore_to_desktop(_hwnd: isize) {}

#[cfg(windows)]
pub fn is_visible(hwnd: isize) -> bool {
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    unsafe { IsWindowVisible(windows::Win32::Foundation::HWND(hwnd as *mut _)).as_bool() }
}

#[cfg(not(windows))]
pub fn is_visible(_hwnd: isize) -> bool {
    false
}

/// 前端把热区上报上来（物理像素）。窗口铺满主屏，所以等价于屏幕坐标。
pub fn set_regions(state: &AppState, rects: Vec<[f64; 4]>, force: bool) {
    if let Ok(mut h) = state.hit.lock() {
        h.regions = rects;
        h.force = force;
    }
}
