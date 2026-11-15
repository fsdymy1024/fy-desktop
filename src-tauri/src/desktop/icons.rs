//! 真实图标提取。
//!
//! 走 `IShellItemImageFactory::GetImage` —— 这是资源管理器自己在用的接口，
//! `.lnk` 由 Shell 自己解析目标，不用我们碰 COM 的 IShellLink。
//! 结果按 (路径 + 修改时间) 哈希缓存成 PNG，第二次启动直接读盘。

use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[cfg(windows)]
mod win {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
    };

    fn com_ready() {
        // 幂等：重复初始化只是返回 S_FALSE；失败（已在别的套间）也无所谓
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        }
    }

    /// HBITMAP(32bpp, 预乘 alpha) → RGBA8
    unsafe fn hbitmap_to_rgba(hbm: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
        let mut bm = BITMAP::default();
        let got = GetObjectW(
            hbm.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut core::ffi::c_void),
        );
        if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth as u32, bm.bmHeight as u32);

        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w as i32;
        // 负高度 = 自上而下，省掉一次翻转
        bi.bmiHeader.biHeight = -(h as i32);
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = 0; // BI_RGB

        let mut buf = vec![0u8; (w * h * 4) as usize];
        let hdc = GetDC(None);
        let lines = GetDIBits(
            hdc,
            hbm,
            0,
            h,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            &mut bi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        if lines == 0 {
            return None;
        }

        // GDI 给的是 BGRA 且 alpha 预乘过，转回直通 alpha，否则半透明边缘会发黑
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
            let a = px[3] as u32;
            if a > 0 && a < 255 {
                for c in 0..3 {
                    px[c] = ((px[c] as u32 * 255) / a).min(255) as u8;
                }
            }
        }
        Some((w, h, buf))
    }

    pub fn extract(path: &str, px: u32) -> Option<Vec<u8>> {
        com_ready();
        let wide = HSTRING::from(path);
        let factory: IShellItemImageFactory =
            unsafe { SHCreateItemFromParsingName(&wide, None).ok()? };
        let hbm = unsafe {
            factory
                .GetImage(
                    SIZE {
                        cx: px as i32,
                        cy: px as i32,
                    },
                    SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK,
                )
                .ok()?
        };
        let rgba = unsafe { hbitmap_to_rgba(hbm) };
        unsafe {
            let _ = DeleteObject(hbm.into());
        }
        let (w, h, data) = rgba?;
        let img = image::RgbaImage::from_raw(w, h, data)?;

        // 统一缩到 64px，卡片里按需缩放，避免每张图标都存 256px
        let img = image::imageops::thumbnail(&img, 64, 64);
        let mut png = Vec::new();
        let dynimg = image::DynamicImage::ImageRgba8(img);
        dynimg
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(png)
    }
}

fn cache_dir() -> PathBuf {
    let dir = crate::config::config_path().join("icons");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn cache_key(path: &str) -> String {
    let meta = std::fs::metadata(path).ok();
    let mtime = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let size = meta.map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(path.to_lowercase().as_bytes());
    hasher.update(mtime.to_le_bytes());
    hasher.update(size.to_le_bytes());
    let d = hasher.finalize();
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// 返回 data URL。命中缓存则不碰 COM，冷启动 70 个图标也只要一次全量。
pub fn data_url(path: &str) -> Option<String> {
    let key = cache_key(path);
    let file = cache_dir().join(format!("{key}.png"));

    let png = if let Ok(bytes) = std::fs::read(&file) {
        bytes
    } else {
        #[cfg(windows)]
        {
            let bytes = win::extract(path, 64)?;
            let _ = std::fs::write(&file, &bytes);
            bytes
        }
        #[cfg(not(windows))]
        {
            return None;
        }
    };

    let b64 = base64::engine::general_purpose::STANDARD.encode(png);
    Some(format!("data:image/png;base64,{b64}"))
}

/// 图标缓存失效时（换了图标、换了文件）按目录整体清掉
pub fn clear_cache() {
    let dir = cache_dir();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}
