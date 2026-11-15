//! 真毛玻璃的地基：抓一张「不含自己」的桌面底图。
//!
//! WebView2 的 `backdrop-filter` 在透明窗口上不会去模糊桌面（和 Electron 一样），
//! 所以 v0.1 只能拿噪点假装磨砂。这里的做法是把桌面真实像素抓下来，
//! 模糊后交给前端当每张卡片的背景 —— 卡片下面是什么，透出来的就是什么。
//!
//! 关键一步是 `WDA_EXCLUDEFROMCAPTURE`：让窗口对截图 API 隐形，
//! 于是 BitBlt 拍到的是纯桌面，不需要「隐藏窗口→截图→显示窗口」的闪烁。

use base64::Engine;

#[cfg(windows)]
use windows::Win32::Foundation::HWND;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SetWindowDisplayAffinity, SM_CXSCREEN, SM_CYSCREEN, WDA_EXCLUDEFROMCAPTURE,
    WDA_NONE,
};

/// 让窗口从截图里消失。抓底图前必须调，否则每张卡片都会透出自己。
#[cfg(windows)]
pub fn exclude_from_capture(hwnd: isize) {
    unsafe {
        let _ = SetWindowDisplayAffinity(HWND(hwnd as *mut _), WDA_EXCLUDEFROMCAPTURE);
    }
}

#[cfg(windows)]
fn toggle_affinity(hwnd: isize, exclude: bool) {
    unsafe {
        let _ = SetWindowDisplayAffinity(
            HWND(hwnd as *mut _),
            if exclude { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE },
        );
    }
}

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
        // 降采样后再模糊：4K 上一步到位会慢好几倍，视觉结果几乎一样
        let blurred = image::imageops::blur(&small, sigma);

        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(blurred)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| format!("编码 PNG 失败: {e}"))?;
        Ok(png)
    }
}

/// 抓桌面底图，返回 data URL。
///
/// `include_window = true` 时临时关掉截图排除，用于自检截图（要看见窗口本身）。
#[cfg(windows)]
pub fn snapshot(hwnd: isize, include_window: bool) -> Result<String, String> {
    if include_window {
        toggle_affinity(hwnd, false);
    }
    let result = grab_screen(3, 13.0, false);
    if include_window {
        toggle_affinity(hwnd, true);
    }
    let png = result?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    Ok(format!("data:image/png;base64,{b64}"))
}

/// 原始像素（不模糊），供自检截图使用
#[cfg(windows)]
pub fn raw_png(hwnd: isize, include_window: bool) -> Result<Vec<u8>, String> {
    if include_window {
        toggle_affinity(hwnd, false);
        // DWM 要合成一帧之后窗口才会重新出现在截图里。
        // 取消排除后立刻 BitBlt，抓到的还是「窗口仍然隐形」的上一帧，
        // 表现就是偶尔截出来的图上一个组件都没有。
        std::thread::sleep(std::time::Duration::from_millis(180));
    }
    let result = grab_screen(1, 0.0, true);
    if include_window {
        toggle_affinity(hwnd, true);
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

#[cfg(not(windows))]
pub fn exclude_from_capture(_hwnd: isize) {}

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
