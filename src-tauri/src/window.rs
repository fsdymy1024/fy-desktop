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
            if crate::is_shutting_down() {
                return;
            }

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
                let mut h = crate::state::lock(&state.hit);
                // 自绘菜单（卡片右键菜单 / 托盘菜单）开着时盯全局按键：点在菜单外就通知前端收起。
                // 点别的应用 / 任务栏 / 桌面空白时我们窗口收不到任何事件，前端全靠这一手。
                // 左右键都算：右键点菜单外面那一刻，桌面自己的右键菜单会同时弹出来，
                // 我们的菜单得让位（与 Windows 上其它软件的菜单行为一致）。
                #[cfg(windows)]
                if let Some((x, y)) = cursor {
                    use windows::Win32::UI::Input::KeyboardAndMouse::{
                        GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON,
                    };
                    let lb = (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0;
                    let rb = (unsafe { GetAsyncKeyState(VK_RBUTTON.0 as i32) } as u16 & 0x8000) != 0;
                    let down = lb || rb;
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

/// 单实例互斥体句柄。活到进程结束（或退出流程里显式释放）。
///
/// `HANDLE` 内部是裸指针，不实现 Send/Sync，放不进 static；
/// 这里包一层并显式声明「跨线程使用是安全的」——它只是个内核对象句柄，
/// 只在退出时被 CloseHandle 一次。
#[cfg(windows)]
struct MutexHandle(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for MutexHandle {}
#[cfg(windows)]
unsafe impl Sync for MutexHandle {}

#[cfg(windows)]
static INSTANCE: std::sync::OnceLock<MutexHandle> = std::sync::OnceLock::new();

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

    unsafe {
        // bInitialOwner = true：创建即持有，进程退出时系统自动释放
        let h = CreateMutexW(None, true, w!("Local\\fy-desktop-single-instance"));
        match h {
            Ok(handle) => {
                if GetLastError() == ERROR_ALREADY_EXISTS {
                    let _ = windows::Win32::Foundation::CloseHandle(handle);
                    return true;
                }
                // 句柄按真实类型存下来（以前存成 usize，将来若加了主动释放路径，
                // 类型对不上就容易漏关或重复关）。退出时由 release_single_instance 关。
                let _ = INSTANCE.set(MutexHandle(handle));
                false
            }
            Err(e) => {
                // 建不出互斥体时保持「允许启动」：把用户挡在门外比多开更糟。
                // 这条日志是排查「为什么能开两个」的唯一线索。
                eprintln!("[window] 单实例互斥体创建失败，本次不阻止多开：{e}");
                false
            }
        }
    }
}

/// 主动放掉单实例互斥体（退出流程用）。进程自然退出时系统也会回收，
/// 这里显式关一次，便于自检/重启场景下马上能再起来。
#[cfg(windows)]
pub fn release_single_instance() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RELEASED: AtomicBool = AtomicBool::new(false);

    // `begin_shutdown` 声称幂等，但 `CloseHandle` 对同一个句柄第二次调用会失败；
    // 若句柄值已被系统复用，那一次失败反倒会误关别的内核对象。用一次性开关挡住。
    if RELEASED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(h) = INSTANCE.get() {
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(h.0);
        }
    }
}

#[cfg(not(windows))]
pub fn already_running() -> bool {
    false
}

#[cfg(not(windows))]
pub fn release_single_instance() {}

/// 二次启动时，通知已经在跑的那个实例「把控制中心打开」。
///
/// 用命名事件而不是给窗口发消息：Tauri 的窗口类名由 tao 生成、不对外承诺，
/// `FindWindowW` 找不到稳定目标；命名事件是内核对象，两边各自 Create / Open
/// 就行，也不用关心窗口是否已经建好。
#[cfg(windows)]
pub fn signal_open_hub() {
    use windows::core::w;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};

    unsafe {
        match OpenEventW(EVENT_MODIFY_STATE, false, w!("Local\\fy-desktop-open-hub")) {
            Ok(h) => {
                let _ = SetEvent(h);
                let _ = CloseHandle(h);
            }
            // 对方还没走到监听的挂载点（或已经退出）：静默放弃，
            // 用户再点一次快捷方式即可，不必拿一个弹窗打扰他
            Err(_) => eprintln!("[window] 已有实例没在监听，本次启动直接退出"),
        }
    }
}

/// 监听「打开控制中心」信号。只在主实例里挂一次。
///
/// 事件用 auto-reset：一次 SetEvent 唤醒一次等待，连续点几次快捷方式
/// 只会把控制中心拉起/聚焦一次，不会排队。
#[cfg(windows)]
pub fn watch_open_hub<F: Fn() + Send + 'static>(f: F) {
    use windows::core::w;
    use windows::Win32::Foundation::{CloseHandle, WAIT_FAILED, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    std::thread::spawn(move || unsafe {
        let h = match CreateEventW(None, false, false, w!("Local\\fy-desktop-open-hub")) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[window] 创建「打开控制中心」事件失败：{e}");
                return;
            }
        };
        loop {
            if crate::is_shutting_down() {
                break;
            }
            // 500ms 超时只为让线程能感知退出；正常路径是事件一到就返回
            let r = WaitForSingleObject(h, 500);
            if r == WAIT_OBJECT_0 {
                f();
            } else if r == WAIT_FAILED {
                break;
            }
        }
        let _ = CloseHandle(h);
    });
}

#[cfg(not(windows))]
pub fn signal_open_hub() {}

#[cfg(not(windows))]
pub fn watch_open_hub<F: Fn() + Send + 'static>(_f: F) {}

/// 前端把热区上报上来（物理像素）。窗口铺满主屏，所以等价于屏幕坐标。
pub fn set_regions(state: &AppState, rects: Vec<[f64; 4]>, force: bool) {
    if let Ok(mut h) = state.hit.lock() {
        h.regions = rects;
        h.force = force;
    }
}
