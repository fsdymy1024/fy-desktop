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

            #[cfg(windows)]
            let cursor = {
                let mut pt = POINT::default();
                if unsafe { GetCursorPos(&mut pt) }.is_err() {
                    None
                } else {
                    Some((pt.x as f64, pt.y as f64))
                }
            };
            #[cfg(not(windows))]
            let cursor: Option<(f64, f64)> = None;

            let mut menu_outside = false;
            let (regions, force) = {
                let mut h = match state.hit.lock() {
                    Ok(h) => h,
                    Err(p) => p.into_inner(),
                };
                // 托盘菜单开着时盯全局左键：点在菜单外就通知前端收起。
                // 点别的应用 / 任务栏时我们窗口收不到任何事件，前端全靠这一手。
                #[cfg(windows)]
                if let Some((x, y)) = cursor {
                    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
                    let down = (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0;
                    if let Some(rect) = h.menu {
                        let outside =
                            !(x >= rect[0] && x <= rect[2] && y >= rect[1] && y <= rect[3]);
                        if !h.menu_armed {
                            // 弹出菜单的那一下左键可能还没松，等一次抬起再开始判
                            if !down {
                                h.menu_armed = true;
                            }
                        } else if down && !h.last_down && outside {
                            h.menu = None;
                            menu_outside = true;
                        }
                    }
                    h.last_down = down;
                }
                (h.regions.clone(), h.force)
            };

            if menu_outside {
                use tauri::Emitter;
                let _ = app.emit("menu:outside", ());
            }

            let inside = match cursor {
                Some((x, y)) => {
                    force
                        || regions
                            .iter()
                            .any(|r| x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])
                }
                None => force,
            };

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

/// 前端就绪看门狗。
///
/// 窗口已经不再依赖前端来显示（见 `setup` 里的即时 `show_no_activate`），
/// 这里守的是另一件事：前端到点还没跑到 `ui_ready`，说明渲染层卡住或崩了，
/// 此时把耗时和窗口状态打进日志——否则用户只会说「桌面上什么都没有」，
/// 而日志里一片干净，根本无从下手。
pub fn spawn_show_watchdog(app: AppHandle, delay_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        if crate::UI_READY.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let ms = crate::BORN
            .get()
            .map(|t| t.elapsed().as_millis())
            .unwrap_or(delay_ms as u128);
        eprintln!("[window] 看门狗：+{ms}ms 前端仍未就绪（渲染层可能卡住或报错）");

        // 兜一手：万一窗口因为别的原因被藏了，这里补一次显示
        if let Some(win) = app.get_webview_window("main") {
            let hwnd = crate::commands::hwnd_of(&win);
            if !is_visible(hwnd) {
                eprintln!("[window] 看门狗：窗口不可见，强制显示");
                show_no_activate(hwnd);
            }
        }
    });
}

/// 单实例检测。用命名互斥体，第二次启动直接退出。
///
/// 多开会同时写同一份 config.json，两组窗口叠在同一块屏幕上，
/// 用户点哪张卡片都可能落到上面那个实例的窗口里，表现就是「点了没反应」
/// 或者「配置自己变回去了」。
#[cfg(windows)]
pub fn already_running() -> bool {
    use windows::core::w;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    static HELD: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    unsafe {
        // bInitialOwner = true：创建即持有，进程退出时系统自动释放
        let h = CreateMutexW(None, true, w!("Local\\fy-desktop-single-instance"));
        match h {
            Ok(handle) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = windows::Win32::Foundation::CloseHandle(handle);
                    return true;
                }
                // 句柄必须活到进程结束，否则互斥体就释放了
                let _ = HELD.set(handle.0 as usize);
                false
            }
            Err(e) => {
                eprintln!("[window] 单实例互斥体创建失败：{e}");
                false
            }
        }
    }
}

#[cfg(not(windows))]
pub fn already_running() -> bool {
    false
}

/// 前端把热区上报上来（物理像素）。窗口铺满主屏，所以等价于屏幕坐标。
pub fn set_regions(state: &AppState, rects: Vec<[f64; 4]>, force: bool) {
    if let Ok(mut h) = state.hit.lock() {
        h.regions = rects;
        h.force = force;
    }
}
