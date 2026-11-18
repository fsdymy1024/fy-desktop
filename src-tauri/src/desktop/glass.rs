//! 真毛玻璃的地基：抓一张「不含自己」的桌面底图。
//!
//! WebView2 的 `backdrop-filter` 在透明窗口上不会去模糊桌面（和 Electron 一样），
//! 所以 v0.1 只能拿噪点假装磨砂。这里的做法是把桌面真实像素抓下来、降采样，
//! 交给前端当每张卡片的背景 —— 卡片下面是什么，透出来的就是什么。
//! 模糊本身在 CSS 里做（`--glass-blur`），不在这条抓屏链路上：这样调模糊强度
//! 只是改一个变量，不必重新抓整屏。
//!
//! 「不含自己」靠 `WDA_EXCLUDEFROMCAPTURE` 实现：BitBlt 拍到的就是纯桌面，
//! 不需要「隐藏窗口→截图→显示窗口」的闪烁。但它**只能抓底图的那一瞬间开**——
//! v0.9.2 之前是常开的，结果 Windows 截图工具 / PrintScreen / 第三方截图
//! 全都拍不到小组件（用户视角：一截图组件就消失）。现在的规则：
//! 窗口默认 `WDA_NONE`（任何截图都能拍到），抓底图前后临时切换、抓完立刻还原。

use base64::Engine;

#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::Graphics::Dwm::{DwmGetCompositionTimingInfo, DWM_TIMING_INFO};
#[cfg(windows)]
use windows::Win32::System::Performance::QueryPerformanceCounter;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetWindowDisplayAffinity, SM_CXSCREEN, SM_CYSCREEN, WDA_EXCLUDEFROMCAPTURE,
    WDA_NONE,
};

/// 等 DWM 真的把当前这一帧合到屏幕上。
///
/// 「排除自己」只是改了窗口的展示亲和性，屏幕上还是旧帧，必须等下一次合成
/// 才拍不到窗口。以前这里是 `sleep(150)` 盲等：不知道合成何时发生，只能给个
/// 够大的数。`DwmGetCompositionTimingInfo` 直接暴露合成时钟 —— `qpcVBlank`
/// 是最近一次垂直同步的 QPC 时间戳，`qpcRefreshPeriod` 是一帧的长度，
/// 等到「vblank + frames 个周期」即可。60Hz 下 2 帧 ≈ 33ms，144Hz 下 < 15ms。
///
/// 拿不到计时信息（DWM 被禁用 / 兼容模式）时退化成一整段 sleep，行为与改动前
/// 等价，只是略短。返回值仅用于调试输出：是否等满了目标帧数。
#[cfg(windows)]
fn wait_compose(frames: u32, timeout: Duration) -> bool {
    let started = Instant::now();
    let trace = |ok: bool| {
        if std::env::var_os("FY_GLASS_TRACE").is_some() {
            eprintln!("[glass] 等合成 {frames} 帧 → {:?} ok={ok}", started.elapsed());
        }
        ok
    };

    // hwnd 传空 = 查整机合成计时，和「窗口在哪个屏」无关
    let mut info: DWM_TIMING_INFO = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<DWM_TIMING_INFO>() as u32;
    if unsafe { DwmGetCompositionTimingInfo(HWND(std::ptr::null_mut()), &mut info) }.is_err()
        || info.qpcRefreshPeriod == 0
    {
        std::thread::sleep(timeout);
        return trace(false);
    }

    let deadline = info
        .qpcVBlank
        .saturating_add(info.qpcRefreshPeriod.saturating_mul(frames.max(1) as u64));

    loop {
        let mut now = 0i64;
        let _ = unsafe { QueryPerformanceCounter(&mut now) };
        if now > 0 && now as u64 >= deadline {
            return trace(true);
        }
        if started.elapsed() >= timeout {
            return trace(false);
        }
        // 1ms 一探：Windows 的 sleep 粒度受 timer resolution 影响，
        // 最坏会被拉长到 ~15ms，所以超时留了余量，宁可多探几轮也不空转。
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// 抓底图前把自己从截图里排除，抓完立刻还原。
/// 排除生效要等 DWM 合成一帧，所以开完等到下一帧再 BitBlt，
/// 否则抓到的还是「窗口没被排除」的上一帧。
#[cfg(windows)]
fn exclude_for_grab(hwnd: isize) {
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(hwnd as *mut _), WDA_EXCLUDEFROMCAPTURE);
    }
    // 2 帧：亲和性变更到合成表面刷新之间隔着一次队列，1 帧容易擦边
    wait_compose(2, Duration::from_millis(120));
}

/// 还原为「任何截图工具都能拍到窗口」的默认状态。
#[cfg(windows)]
fn include_back(hwnd: isize) {
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(hwnd as *mut _), WDA_NONE);
    }
}

#[cfg(not(windows))]
fn exclude_for_grab(_hwnd: isize) {}

#[cfg(not(windows))]
fn include_back(_hwnd: isize) {}

/// 抓底图期间把另一个窗口（控制中心）也排除掉。
///
/// 主窗口是 `WDA_EXCLUDEFROMCAPTURE` 的常客，控制中心却是普通顶层窗口：
/// 不处理的话，开着控制中心刷新底图，玻璃卡下面会糊出一块窗口影子。
#[cfg(windows)]
pub fn exclude_hwnd(hwnd: isize) {
    exclude_for_grab(hwnd);
}

#[cfg(windows)]
pub fn include_hwnd(hwnd: isize) {
    include_back(hwnd);
}

#[cfg(not(windows))]
pub fn exclude_hwnd(_hwnd: isize) {}

#[cfg(not(windows))]
pub fn include_hwnd(_hwnd: isize) {}

#[cfg(windows)]
fn grab_screen(scale_down: u32, sigma: f32, raw: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, HGDIOBJ,
        ROP_CODE, SRCCOPY,
    };

    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err("拿不到屏幕尺寸".into());
        }

        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("GetDC 失败".into());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let hbm = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(mem, HGDIOBJ(hbm.0));

        // CAPTUREBLT：把分层窗口（桌面图标、部分组件）一起抓进来
        let rop = ROP_CODE(SRCCOPY.0 | CAPTUREBLT.0);
        let ok = BitBlt(mem, 0, 0, w, h, Some(screen), 0, 0, rop).is_ok();

        if !ok {
            let _ = SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(hbm.0));
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            return Err("BitBlt 失败".into());
        }

        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h;
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = 0; // BI_RGB

        let mut buf = vec![0u8; (w * h * 4) as usize];
        let lines = GetDIBits(
            mem,
            hbm,
            0,
            h as u32,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bi,
            DIB_RGB_COLORS,
        );

        let _ = SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(hbm.0));
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);

        if lines == 0 {
            return Err("GetDIBits 失败".into());
        }

        // BGRA → RGBA，并补上不透明 alpha
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let img = image::RgbaImage::from_raw(w as u32, h as u32, buf)
            .ok_or_else(|| "位图尺寸不匹配".to_string())?;

        // 自检截图要原图，不走降采样和模糊
        if raw {
            let mut png = Vec::new();
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
                .map_err(|e| format!("编码 PNG 失败: {e}"))?;
            return Ok(png);
        }

        let small = image::imageops::resize(
            &img,
            (w as u32 / scale_down).max(1),
            (h as u32 / scale_down).max(1),
            image::imageops::FilterType::Triangle,
        );
        // 降采样后再模糊：4K 上一步到位会慢好几倍，视觉结果几乎一样。
        // sigma = 0 表示不在这里模糊 —— 模糊交给前端的 CSS filter，
        // 这样「模糊强度」变成可调参数，改它不需要重新抓整屏。
        let out = if sigma > 0.0 {
            image::imageops::blur(&small, sigma)
        } else {
            small
        };

        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(out)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| format!("编码 PNG 失败: {e}"))?;
        Ok(png)
    }
}

/// 抓桌面底图，返回 data URL。
///
/// `include_window = true` 用于自检截图（要看见窗口本身）：窗口默认就对截图
/// 可见，什么都不用切。`include_window = false` 才是给玻璃底图用的：
/// 瞬时排除自己 → BitBlt → 立刻还原，等合成帧而不是盲等。
///
/// 只出 1/3 降采样、**未模糊**的原图：模糊由前端 CSS `filter: blur()` 完成。
/// 这样模糊半径是一个 CSS 变量，调它不产生任何抓屏成本；也意味着底图 PNG
/// 的熵比模糊版高、体积更大，这是这一层取舍的代价。
#[cfg(windows)]
pub fn snapshot(hwnd: isize, include_window: bool) -> Result<String, String> {
    if !include_window {
        exclude_for_grab(hwnd);
    }
    let result = grab_screen(3, 0.0, false);
    if !include_window {
        include_back(hwnd);
    }
    let png = result?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// 原始像素（不模糊），供自检截图使用
#[cfg(windows)]
pub fn raw_png(hwnd: isize, include_window: bool) -> Result<Vec<u8>, String> {
    if !include_window {
        exclude_for_grab(hwnd);
    }
    let result = grab_screen(1, 0.0, true);
    if !include_window {
        include_back(hwnd);
    }
    result
}

#[cfg(not(windows))]
pub fn raw_png(_hwnd: isize, _include_window: bool) -> Result<Vec<u8>, String> {
    Err("仅支持 Windows".into())
}

#[cfg(not(windows))]
pub fn snapshot(_hwnd: isize, _include_window: bool) -> Result<String, String> {
    Err("仅支持 Windows".into())
}

/* ===================== 干净截图辅助 =====================
   自检截图时，桌面上往往还开着别的窗口，挡住小组件。
   这里只做一件事：把别人的窗口临时收起来，拍完原样放回去。
   仅在 FY_SHOT_CLEAN=1 时启用，正常使用不会碰任何窗口。
   ======================================================= */

#[cfg(windows)]
mod clean {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible, ShowWindow, GW_OWNER, SW_MINIMIZE, SW_RESTORE, SW_SHOWMAXIMIZED,
    };

    struct Collector {
        me: u32,
        hidden: Vec<(isize, bool)>, // (hwnd, 原来是不是最大化)
    }

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut Collector);
        if !IsWindowVisible(hwnd).as_bool() {
            return TRUE;
        }
        if GetWindowTextLengthW(hwnd) == 0 {
            return TRUE;
        }
        // 只处理没有 owner 的顶层窗口；GetWindow 对「无 owner」返回 Err(NULL)，
        // 所以 Err 恰恰说明这是我们要处理的普通窗口
        let has_owner = GetWindow(hwnd, GW_OWNER)
            .map(|h| !h.0.is_null())
            .unwrap_or(false);
        if has_owner {
            return TRUE;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == state.me {
            return TRUE;
        }
        if IsIconic(hwnd).as_bool() {
            return TRUE; // 已经最小化的不用管，也不该被我们恢复
        }
        let zoomed = windows::Win32::UI::WindowsAndMessaging::IsZoomed(hwnd).as_bool();
        let _ = ShowWindow(hwnd, SW_MINIMIZE);
        state.hidden.push((hwnd.0 as isize, zoomed));
        TRUE
    }

    pub fn hide_others() -> Vec<(isize, bool)> {
        let mut state = Collector {
            me: unsafe { GetCurrentProcessId() },
            hidden: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(Some(cb), LPARAM(&mut state as *mut _ as isize));
        }
        state.hidden
    }

    pub fn restore(list: &[(isize, bool)]) {
        for (hwnd, zoomed) in list.iter().rev() {
            let h = HWND(*hwnd as *mut _);
            let _ = unsafe {
                ShowWindow(h, if *zoomed { SW_SHOWMAXIMIZED } else { SW_RESTORE })
            };
        }
    }
}

/// 收起其它窗口，返回恢复用的句柄列表
#[cfg(windows)]
pub fn hide_other_windows() -> Vec<(isize, bool)> {
    clean::hide_others()
}

#[cfg(windows)]
pub fn restore_windows(list: &[(isize, bool)]) {
    clean::restore(list)
}

#[cfg(not(windows))]
pub fn hide_other_windows() -> Vec<(isize, bool)> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn restore_windows(_list: &[(isize, bool)]) {}
