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
    // `.lnk` / `.url` 的图标来自它指向的目标，但目标换图标时 lnk 的 mtime 与大小
    // 往往都不变（缓存永远命中旧图）。快捷方式本体很小，直接把内容也哈希进去：
    // 改过目标 → 文件内容变 → 缓存键变 → 重新取图标。
    if matches!(
        Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
            .as_str(),
        "lnk" | "url"
    ) && size > 0
        && size < 64 * 1024
    {
        if let Ok(bytes) = std::fs::read(path) {
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(&bytes);
        }
    }
    let d = hasher.finalize();
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// 本进程内已经编码过的 data URL。
///
/// 同一个路径在一次会话里会被反复请求（重渲染收纳面板、刷新桌面），而 base64
/// 编码 + 读盘每次都要重新做一遍。命中这里就直接返回，不再碰磁盘与 IPC 序列化前的编码。
const MEMO_MAX: usize = 400;

fn memo() -> &'static Mutex<std::collections::HashMap<String, String>> {
    static M: OnceLock<Mutex<std::collections::HashMap<String, String>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 返回 data URL。命中缓存则不碰 COM，冷启动 70 个图标也只要一次全量。
pub fn data_url(path: &str) -> Option<String> {
    let key = cache_key(path);
    if let Some(hit) = crate::state::lock(memo()).get(&key) {
        return Some(hit.clone());
    }
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
    let url = format!("data:image/png;base64,{b64}");
    {
        let mut m = crate::state::lock(memo());
        if m.len() >= MEMO_MAX {
            m.clear();
        }
        m.insert(key, url.clone());
    }
    Some(url)
}

/// 图标缓存失效时（换了图标、换了文件）按目录整体清掉
pub fn clear_cache() {
    crate::state::lock(memo()).clear();
    let dir = cache_dir();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// 缓存上限：7 天没被写过（= 没被 Windows 访问过）的条目删掉，
/// 总量超过 16 MB 时按最旧优先删。桌面图标只增不减时缓存目录会一直长。
const CACHE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 3600);
const CACHE_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// 启动与「刷新桌面」时调用：清掉过期条目，并把总量压回上限。
pub fn prune_cache() {
    let dir = cache_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let mut kept: Vec<(std::time::SystemTime, u64, PathBuf)> = Vec::new();
    let mut total: u64 = 0;

    for e in rd.flatten() {
        let p = e.path();
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let at = md.modified().unwrap_or(now);
        let fresh = now.duration_since(at).map(|d| d < CACHE_MAX_AGE).unwrap_or(true);
        if !fresh {
            let _ = std::fs::remove_file(&p);
            continue;
        }
        total += md.len();
        kept.push((at, md.len(), p));
    }

    if total <= CACHE_MAX_BYTES {
        return;
    }
    // 最旧的先删，直到回到上限以内
    kept.sort_by_key(|(at, _, _)| *at);
    for (_, len, p) in kept {
        if total <= CACHE_MAX_BYTES {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_tracks_mtime_and_size() {
        let dir = std::env::temp_dir().join("fy-desktop-icon-key");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.txt");
        std::fs::write(&f, b"1").unwrap();
        let k1 = cache_key(&f.to_string_lossy());
        std::fs::write(&f, b"22").unwrap();
        let k2 = cache_key(&f.to_string_lossy());
        assert_ne!(k1, k2, "文件大小变化必须换缓存键");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
