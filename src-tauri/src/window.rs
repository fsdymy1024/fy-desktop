//! 窗口定位与「窗口区域」守卫。
//!
//! 桌面层铺满整屏，但只应该占住「真正画了东西」的地方：窗口区域之外的
//! 像素不属于我们，点击直接落到桌面，也不用再靠 `set_ignore_cursor_events`
//! 翻转 `WS_EX_LAYERED` 来实现穿透——那个样式和窗口区域一起用会在窗口顶部
//! 漏出一条浅色横杠（见 `apply_window_region`），而且每次翻转都让 DWM 重算合成。
//!
//! 后台线程留着，但只干一件事：自绘菜单开着时盯全局按键，点在菜单外面就
//! 通知前端收起。菜单外的点击我们窗口根本收不到，只能靠这一手。

use crate::state::AppState;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[cfg(windows)]
use windows::Win32::Foundation::POINT;
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ, RGN_OR,
};
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
        loop {
            std::thread::sleep(std::time::Duration::from_millis(30));
            if crate::is_shutting_down() {
                return;
            }

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
            {
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
            }

            if menu_outside {
                use tauri::Emitter;
                let _ = app.emit("menu:outside", ());
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
///
/// `paint` 是「只画不收鼠标」的矩形（toast 一类临时浮层）：窗口被裁成区域窗口后，
/// 没报上来的部分会被整块裁掉，所以看得见的东西必须跟着一起报。
pub fn set_regions(state: &AppState, rects: Vec<[f64; 4]>, paint: Vec<[f64; 4]>, force: bool) {
    if let Ok(mut h) = state.hit.lock() {
        h.regions = rects;
        h.paint = paint;
        h.force = force;
    }
}

/// 去掉 DWM 给窗口画的那一圈边框与圆角（Windows 11 才有）。
///
/// 无边框弹窗本来不该有可见边框，但 Win11 会给每个顶层窗口画 1px 边框：
/// 窗口铺满全屏时它正好压在屏幕边缘，看不出来；裁成区域之后，区域碰到窗口
/// 边缘的地方就会露出一条浅线（组件贴着屏幕顶边时最明显）。顺手也关掉系统
/// 圆角——圆角会把区域边缘再削一次，和卡片自己的圆角对不上。
#[cfg(windows)]
fn strip_dwm_frame(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE,
        DWMWCP_DONOTROUND,
    };

    let border = DWMWA_COLOR_NONE;
    let corner = DWMWCP_DONOTROUND;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &border as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&corner) as u32,
        );
    }
}

/// 屏幕坐标的热区 → 窗口内的区域矩形（物理像素）。
///
/// 只做坐标平移、阴影外扩和窗口裁剪，不碰窗口句柄，便于单测。
fn window_rects(
    rects: &[[f64; 4]],
    origin: (i32, i32),
    size: PhysicalSize<u32>,
    pad: i32,
) -> Vec<[i32; 4]> {
    let (ox, oy) = (origin.0 as f64, origin.1 as f64);
    let (w, h) = (size.width as i32, size.height as i32);
    let mut list: Vec<[i32; 4]> = Vec::new();
    for r in rects {
        let x0 = ((r[0] - ox).round() as i32 - pad).max(0);
        let y0 = ((r[1] - oy).round() as i32 - pad).max(0);
        let x1 = ((r[2] - ox).round() as i32 + pad).min(w);
        let y1 = ((r[3] - oy).round() as i32 + pad).min(h);
        if x1 > x0 && y1 > y0 {
            list.push([x0, y0, x1, y1]);
        }
    }
    // 排序只为了缓存比对稳定：并集和顺序无关
    list.sort_unstable();
    list.dedup();
    list
}

/// 把主窗口裁成「只覆盖真正画了东西的地方」。
///
/// 铺满全屏的透明窗口会一直挂在 DWM 的合成树上：下面放全屏视频时，视频回不到
/// 硬件叠加层，只能每帧走 GPU 合成，机器一忙就掉帧。裁成组件矩形的并集之后，
/// 空白处根本不属于这个窗口，桌面和视频照旧直接扫描输出。
///
/// 附带的好处：区域外的点击天然落到桌面，不再需要用 `WS_EX_LAYERED` 做穿透——
/// 那个样式和窗口区域一起用会在窗口顶部漏出一条浅色横杠（用户看到的「白框」）。
///
/// `force`（编辑、拖拽、文件拖入）时恢复整窗——这些交互本来就要接管鼠标，
/// 而且拖动过程中卡片会跑到任何位置，跟着裁反而会把自己裁掉。
#[cfg(windows)]
pub fn apply_window_region(app: &AppHandle, state: &AppState) {
    use windows::Win32::Foundation::HWND;

    // 出问题时先在命令行设 FY_REGION_OFF=1 跑一次：整窗恢复，用来确认
    // 症状是不是区域窗口带来的（对比截图时也用得上）。
    if std::env::var_os("FY_REGION_OFF").is_some() {
        return;
    }

    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    let (rects, force) = {
        let h = crate::state::lock(&state.hit);
        let mut all = h.regions.clone();
        all.extend_from_slice(&h.paint);
        (all, h.force)
    };

    // None = 整窗（清掉区域）；Some(list) = 只保留这些矩形（空表示什么都不留）
    let target: Option<Vec<[i32; 4]>> = if force {
        None
    } else {
        let origin = win.outer_position().map(|p| (p.x, p.y)).unwrap_or((0, 0));
        let size = win.outer_size().unwrap_or(PhysicalSize::new(0, 0));
        if size.width == 0 || size.height == 0 {
            // 量不出窗口尺寸时别裁：一个空区域等于把窗口整个抹掉
            return;
        }
        // 不再统一外扩：外扩出来的那圈虽然能画出阴影，但也会把旁边桌面的
        // 点击一起吃掉。需要留阴影的浮层（菜单 / toast）由前端自己把外扩算进矩形。
        // 排「顶部那条浅色横杠」时可以用 FY_REGION_PAD=44 现场把外扩加回来对比，不必重编。
        let pad = std::env::var("FY_REGION_PAD")
            .ok()
            .and_then(|v| v.trim().parse::<i32>().ok())
            .unwrap_or(0);
        let top_min = std::env::var("FY_REGION_TOPMIN")
            .ok()
            .and_then(|v| v.trim().parse::<i32>().ok())
            .unwrap_or(0);
        let list: Vec<[i32; 4]> = window_rects(&rects, origin, size, pad)
            .into_iter()
            .filter_map(|r| {
                let y0 = r[1].max(top_min);
                (r[3] > y0).then_some([r[0], y0, r[2], r[3]])
            })
            .collect();
        if !rects.is_empty() && list.is_empty() {
            // 报了热区却一个都落不进窗口：多半是窗口刚挪过屏、坐标还没对上。
            // 宁可这一轮不动，也不要把窗口裁空（裁空后它连自己都点不到）。
            return;
        }
        Some(list)
    };

    // 和上一次一样就别碰窗口：SetWindowRgn 每次都让 DWM 重算一遍合成
    if crate::state::lock(&state.hit).applied == target {
        return;
    }

    // bredraw 一律传 false：区域一变就让系统同步重画，透明窗口会先被抹上一层
    // 不透明底色、等 WebView 呈现过来才恢复（肉眼就是边缘闪一下）。
    // 交给 DWM 按下一帧合成，反而没有这一帧。
    let hwnd = HWND(crate::commands::hwnd_of(&win) as *mut _);

    // 边框是窗口级属性，第一次动手时清一次就够
    static FRAME_STRIPPED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    if !FRAME_STRIPPED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        strip_dwm_frame(hwnd);
    }
    let ok = unsafe {
        match &target {
            None => SetWindowRgn(hwnd, None, false) != 0,
            Some(list) => {
                let region = CreateRectRgn(0, 0, 0, 0);
                if region.0.is_null() {
                    return;
                }
                for r in list {
                    let part = CreateRectRgn(r[0], r[1], r[2], r[3]);
                    if part.0.is_null() {
                        continue;
                    }
                    CombineRgn(Some(region), Some(region), Some(part), RGN_OR);
                    let _ = DeleteObject(HGDIOBJ(part.0));
                }
                // 成功时区域的所有权交给窗口，失败时还在我们手里
                if SetWindowRgn(hwnd, Some(region), false) != 0 {
                    true
                } else {
                    let _ = DeleteObject(HGDIOBJ(region.0));
                    false
                }
            }
        }
    };

    if !ok {
        eprintln!("[window] 设置窗口区域失败，保持原样");
        return;
    }


    // 排「视频还卡」时先看这一行：区域块数是不是真的跟着布局变了
    if std::env::var_os("FY_REGION_TRACE").is_some() {
        match &target {
            None => eprintln!("[window] 区域：整窗（force）"),
            Some(list) => {
                let area: i64 = list
                    .iter()
                    .map(|r| (r[2] - r[0]) as i64 * (r[3] - r[1]) as i64)
                    .sum();
                let rects: Vec<String> = list
                    .iter()
                    .take(8)
                    .map(|r| format!("({},{},{},{})", r[0], r[1], r[2], r[3]))
                    .collect();
                eprintln!("[window] 区域：{} 块，共 {} px² {}", list.len(), area, rects.join(" "));
            }
        }
    }
    crate::state::lock(&state.hit).applied = target;
}

#[cfg(not(windows))]
pub fn apply_window_region(_app: &AppHandle, _state: &AppState) {}

#[cfg(test)]
mod tests {
    use super::window_rects;
    use tauri::PhysicalSize;

    fn rects(list: &[[f64; 4]]) -> Vec<[i32; 4]> {
        window_rects(list, (0, 0), PhysicalSize::new(1920, 1080), 40)
    }

    #[test]
    fn pads_and_translates_to_window_coordinates() {
        // 窗口在主屏 (100, 50)：屏幕坐标要先减掉窗口原点，再按阴影外扩
        let list = window_rects(&[[200.0, 100.0, 400.0, 300.0]], (100, 50), PhysicalSize::new(1920, 1080), 40);
        assert_eq!(list, vec![[60, 10, 340, 290]]);
    }

    #[test]
    fn clips_to_window_bounds() {
        // 贴着屏幕左上角的卡片：外扩部分不许是负数
        assert_eq!(rects(&[[10.0, 10.0, 60.0, 60.0]]), vec![[0, 0, 100, 100]]);
        // 右下角同理，不许超出窗口
        assert_eq!(
            rects(&[[1880.0, 1040.0, 1950.0, 1100.0]]),
            vec![[1840, 1000, 1920, 1080]]
        );
    }

    #[test]
    fn drops_rectangles_outside_the_window() {
        assert!(rects(&[[5000.0, 5000.0, 5100.0, 5100.0]]).is_empty());
        assert!(rects(&[]).is_empty());
    }

    #[test]
    fn keeps_each_rectangle_separate() {
        // 两张不相连的卡片：不是外接大矩形，中间那块必须留给桌面
        assert_eq!(
            rects(&[[100.0, 100.0, 200.0, 200.0], [900.0, 700.0, 1000.0, 800.0]]),
            vec![[60, 60, 240, 240], [860, 660, 1040, 840]]
        );
    }
}
