//! 桌面收纳：分组 = 磁盘上的真实文件夹。
//!
//! v0.1 只在配置里记「谁属于哪组」，文件本身不动，格子名不副实。
//! 这一版把分组做成 `<桌面>\fy-desktop\<组名>` 实体目录：
//! 拖进格子就是真的把文件移进文件夹，双击就是真的打开。

pub mod glass;
pub mod icons;

use crate::config::{Config, GroupCfg};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub name: String,
    pub path: String,
    /// shortcut | folder | app | file
    pub kind: String,
    pub ext: String,
    /// 真实图标（data URL），由 icons 命令异步补上
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GroupView {
    pub id: String,
    pub name: String,
    pub color: String,
    /// 实体文件夹路径；虚拟分组为空
    pub folder: String,
    pub items: Vec<Item>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesktopView {
    pub root: String,
    pub groups: Vec<GroupView>,
    /// 桌面上还没收纳的条目
    pub loose: Vec<Item>,
    pub loose_total: usize,
}

const HIDDEN: u32 = 0x2;
const SYSTEM: u32 = 0x4;

fn is_hidden(md: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        let a = md.file_attributes();
        a & HIDDEN != 0 || a & SYSTEM != 0
    }
    #[cfg(not(windows))]
    {
        let _ = md;
        false
    }
}

pub fn desktop_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(p) = std::env::var("USERPROFILE") {
        let d = PathBuf::from(p).join("Desktop");
        if d.is_dir() {
            out.push(d);
        }
    }
    let public = PathBuf::from(r"C:\Users\Public\Desktop");
    if public.is_dir() {
        out.push(public);
    }
    out
}

pub fn primary_desktop() -> PathBuf {
    desktop_dirs()
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn root_dir(cfg: &Config) -> PathBuf {
    let root = cfg.organizer.root.trim();
    if root.is_empty() {
        primary_desktop().join("fy-desktop")
    } else {
        PathBuf::from(root)
    }
}

pub fn sanitize(name: &str) -> String {
    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let s: String = name
        .chars()
        .map(|c| if bad.contains(&c) { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches('.').to_string();
    if s.is_empty() {
        "未命名".into()
    } else {
        s
    }
}

pub fn group_dir(root: &Path, g: &GroupCfg) -> PathBuf {
    root.join(sanitize(&g.name))
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

fn kind_of(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return "folder".into();
    }
    match ext_of(&path.to_string_lossy()) {
        e if e == "lnk" || e == "url" => "shortcut".into(),
        e if e == "exe" || e == "msi" => "app".into(),
        _ => "file".into(),
    }
}

pub fn item_of(path: &Path) -> Option<Item> {
    let md = std::fs::metadata(path).ok()?;
    if is_hidden(&md) {
        return None;
    }
    let name = path.file_name()?.to_string_lossy().to_string();
    if name.eq_ignore_ascii_case("desktop.ini") || name.starts_with('~') {
        return None;
    }
    Some(Item {
        name: name.clone(),
        path: path.to_string_lossy().to_string(),
        kind: kind_of(path, md.is_dir()),
        ext: ext_of(&name),
        icon: None,
    })
}

fn hit_any(hay: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| hay.contains(n))
}

fn scan_dir(dir: &Path) -> Vec<Item> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in rd.flatten() {
        if let Some(it) = item_of(&e.path()) {
            out.push(it);
        }
    }
    sort_items(&mut out);
    out
}

fn sort_items(items: &mut [Item]) {
    items.sort_by(|a, b| {
        let af = (a.kind != "folder") as u8;
        let bf = (b.kind != "folder") as u8;
        af.cmp(&bf)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

/// 生成面板视图：每个分组读自己的文件夹，另外统计桌面上还没收纳的条目。
pub fn view(cfg: &Config) -> DesktopView {
    let root = root_dir(cfg);
    let _ = std::fs::create_dir_all(&root);

    let groups: Vec<GroupView> = cfg
        .organizer
        .groups
        .iter()
        .map(|g| {
            let dir = group_dir(&root, g);
            GroupView {
                id: g.id.clone(),
                name: g.name.clone(),
                color: g.color.clone(),
                folder: dir.to_string_lossy().to_string(),
                items: scan_dir(&dir),
            }
        })
        .collect();

    // 桌面散落项：排除收纳根目录自身，以及已经在某组文件夹里的
    let mut loose = Vec::new();
    for d in desktop_dirs() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p == root {
                continue;
            }
            if let Some(it) = item_of(&p) {
                loose.push(it);
            }
        }
    }
    sort_items(&mut loose);
    let loose_total = loose.len();

    DesktopView {
        root: root.to_string_lossy().to_string(),
        groups,
        loose,
        loose_total,
    }
}

/// 目标重名时追加 (2)(3)…，绝不覆盖已有文件。
fn unique_target(dir: &Path, name: &str) -> PathBuf {
    let mut target = dir.join(name);
    if !target.exists() {
        return target;
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for i in 2..999 {
        target = dir.join(format!("{stem} ({i}){ext}"));
        if !target.exists() {
            return target;
        }
    }
    target
}

pub(crate) fn move_one(src: &Path, dir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败: {e}"))?;
    let name = src
        .file_name()
        .ok_or_else(|| "非法路径".to_string())?
        .to_string_lossy()
        .to_string();
    let target = unique_target(dir, &name);
    // 同一卷时 rename 是移动；跨卷（极少见）退化成复制+删除
    match std::fs::rename(src, &target) {
        Ok(_) => Ok(target),
        Err(_) => {
            copy_recursive(src, &target)?;
            if src.is_dir() {
                std::fs::remove_dir_all(src).map_err(|e| format!("删除源目录失败: {e}"))?;
            } else {
                std::fs::remove_file(src).map_err(|e| format!("删除源文件失败: {e}"))?;
            }
            Ok(target)
        }
    }
}

fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
        for e in std::fs::read_dir(src)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            copy_recursive(&e.path(), &dst.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(src, dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

pub fn move_into(cfg: &Config, paths: &[String], group_id: &str) -> Result<usize, String> {
    let g = cfg
        .organizer
        .groups
        .iter()
        .find(|g| g.id == group_id)
        .ok_or_else(|| format!("分组不存在: {group_id}"))?;
    let dir = group_dir(&root_dir(cfg), g);
    let mut n = 0;
    for p in paths {
        let src = PathBuf::from(p);
        if !src.exists() {
            continue;
        }
        move_one(&src, &dir)?;
        n += 1;
    }
    Ok(n)
}

/// 移回桌面——「收纳」必须随时能反悔。
pub fn move_out(paths: &[String]) -> Result<usize, String> {
    let desktop = primary_desktop();
    let mut n = 0;
    for p in paths {
        let src = PathBuf::from(p);
        if !src.exists() {
            continue;
        }
        move_one(&src, &desktop)?;
        n += 1;
    }
    Ok(n)
}

/// 按名称关键词 + 扩展名猜分组，返回「哪个组会收走几个」。
pub fn classify(cfg: &Config, items: &[Item]) -> Vec<(String, Vec<String>)> {
    const DEV_WORDS: &[&str] = &[
        "code", "git", "docker", "postman", "dbeaver", "terminal", "powershell", "cmd",
        "python", "node", "idea", "webstorm", "navicat", "xshell", "winscp", "putty",
        "fiddler", "vscode", "studio", "dev",
    ];
    const DESIGN_WORDS: &[&str] = &[
        "photoshop", "illustrator", "figma", "sketch", "premiere", "blender", "adobe",
        "canva", "affinity", "axure", "procreate", "设计",
    ];
    const MEDIA_WORDS: &[&str] = &[
        "图片", "照片", "video", "movie", "music", "音乐", "photo", "image", "截图", "录屏",
    ];
    let mut buckets: Vec<(String, Vec<String>)> = Vec::new();
    let has = |id: &str| cfg.organizer.groups.iter().any(|g| g.id == id);
    let fallback = cfg
        .organizer
        .groups
        .iter()
        .find(|g| g.id == "archive")
        .or_else(|| cfg.organizer.groups.last())
        .map(|g| g.id.clone());

    for it in items {
        let n = it.name.to_lowercase();
        let mut gid: Option<String> = None;
        if has("dev") && hit_any(&n, DEV_WORDS) {
            gid = Some("dev".into());
        } else if has("design") && hit_any(&n, DESIGN_WORDS) {
            gid = Some("design".into());
        } else if has("media")
            && ((it.kind == "folder" && hit_any(&n, MEDIA_WORDS))
                || matches!(
                    it.ext.as_str(),
                    "png" | "jpg" | "jpeg" | "gif" | "webp" | "mp4" | "mkv" | "mov" | "mp3" | "flac" | "wav"
                ))
        {
            gid = Some("media".into());
        } else if has("docs")
            && matches!(
                it.ext.as_str(),
                "doc" | "docx" | "pdf" | "xls" | "xlsx" | "ppt" | "pptx" | "csv" | "md" | "txt"
            )
        {
            gid = Some("docs".into());
        }

        let key = gid.or_else(|| fallback.clone());
        if let Some(k) = key {
            match buckets.iter_mut().find(|(id, _)| *id == k) {
                Some(b) => b.1.push(it.path.clone()),
                None => buckets.push((k, vec![it.path.clone()])),
            }
        }
    }
    buckets
}

/// 打开动作留一行日志。
///
/// 这类失败是「点了没反应」，没有日志就只能猜——窗口打没打开，ShellExecute 回了
/// 一个什么码，只有它知道。日志和配置放一起，用户出事时能找到。
pub fn log_launch(msg: &str) {
    use std::io::Write;
    let dir = crate::config::config_path();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("launch.log"))
    {
        let _ = writeln!(f, "{} {msg}", now_text());
    }
}

fn now_text() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (h, m, s) = (((secs + 8 * 3600) % 86400) / 3600, (secs / 60) % 60, secs % 60);
    format!("[{h:02}:{m:02}:{s:02}]")
}

/// 资源管理器主窗口的类名。判断「有没有新窗口出现」只看这两类。
#[cfg(windows)]
fn explorer_windows() -> Vec<isize> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetClassNameW};

    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let out = &mut *(lparam.0 as *mut Vec<isize>);
        let mut buf = [0u16; 64];
        let n = GetClassNameW(hwnd, &mut buf).max(0) as usize;
        match String::from_utf16_lossy(&buf[..n]).as_str() {
            "CabinetWClass" | "ExploreWClass" => out.push(hwnd.0 as isize),
            _ => {}
        }
        BOOL(1)
    }

    let mut out: Vec<isize> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(cb), LPARAM(&mut out as *mut _ as isize));
    }
    out
}

#[cfg(windows)]
fn force_show(hwnd: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_SHOWNORMAL};
    unsafe {
        let h = HWND(hwnd as *mut _);
        let _ = ShowWindow(h, SW_SHOWNORMAL);
        let _ = SetForegroundWindow(h);
    }
}

#[cfg(windows)]
fn window_visible(hwnd: isize) -> bool {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    unsafe { IsWindowVisible(HWND(hwnd as *mut _)).as_bool() }
}

/// 起一个 explorer 进程，并保证它的窗口是**可见**的。
///
/// 为什么不能只用 ShellExecute：
/// 1. 机器上只要存在过一个「隐藏」的资源管理器窗口（v0.4 之前用 `cmd /c start`
///    打开过就会留下一个），ShellExecuteW 不会新建窗口，而是把那个**隐藏**窗口
///    导航过去，返回值还是 >32 的「成功」——用户看到的就是「点了没反应」。
/// 2. 无控制台进程派生的子进程可能继承「不显示窗口」的启动状态。
/// 所以这里自己起 explorer，再轮询新出现的窗口把它 ShowWindow + 置前。
///
/// `raw` 是**已经带好引号**的命令行片段。必须用 `raw_arg` 拼：`Command::arg`
/// 会给整个参数套一层引号（`"/select,C:\a b\x.lnk"`），explorer 按空格切开后
/// `/select,` 就失效了，于是新窗口落在「文档」而不是选中目标——v0.9.7 修的就是它。
///
/// `require_new = false` 用于 `/select,`：它会复用已有的窗口，不会产生新窗口，
/// 这时只把仍处于隐藏状态的资源管理器窗口亮出来即可，不算失败。
#[cfg(windows)]
fn spawn_explorer(raw: &str, require_new: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let before = explorer_windows();
    let mut cmd = std::process::Command::new("explorer");
    cmd.raw_arg(raw);
    // CREATE_NO_WINDOW：不闪控制台；窗口显示交给后面的 ShowWindow
    if let Err(e) = cmd.creation_flags(0x0800_0000).spawn() {
        log_launch(&format!("  explorer spawn 失败：{e}"));
        return Err(format!("启动资源管理器失败：{e}"));
    }

    // /n 需要等新窗口；/select 在已有可见窗口里定位时不用傻等 1.5 秒
    let rounds = if !require_new && before.iter().any(|h| window_visible(*h)) {
        8
    } else {
        25
    };

    for _ in 0..rounds {
        std::thread::sleep(std::time::Duration::from_millis(60));
        let fresh: Vec<isize> = explorer_windows()
            .into_iter()
            .filter(|h| !before.contains(h))
            .collect();
        if let Some(&h) = fresh.first() {
            force_show(h);
            // explorer 建窗后还要铺内容，等一拍再确认一次，免得刚置前又被内部逻辑拨回去
            std::thread::sleep(std::time::Duration::from_millis(140));
            force_show(h);
            log_launch(&format!("  new window {h:#x} shown"));
            return Ok(());
        }
    }

    if !require_new {
        let wins = explorer_windows();
        if wins.iter().any(|h| window_visible(*h)) {
            // 已有可见窗口：/select 已经在它里面定位好了。
            // 此时别去碰别的窗口——机器上可能还躺着一个隐藏的「此电脑」，
            // 无差别 ShowWindow 会把它也弹出来，反而添乱。
            return Ok(());
        }
        let hidden: Vec<isize> = wins.iter().copied().filter(|h| !window_visible(*h)).collect();
        if !hidden.is_empty() {
            for h in hidden {
                force_show(h);
            }
            log_launch("  reuse window, hidden one shown");
            return Ok(());
        }
    }
    Err("没有出现新的资源管理器窗口".into())
}

/// 打开文件 / 文件夹 / 快捷方式。
///
/// 必须按类型分流，不能一律塞给 `explorer /n`：
/// - **文件夹**才用 `/n` 强制开新窗口并置前——机器上可能残留隐藏的资源管理器
///   窗口，ShellExecute 会把导航送进那个看不见的窗口（v0.6 修的就是这个）。
/// - **快捷方式 / 普通文件**直接交给 ShellExecute，让 shell 按关联打开。
///   `/n` 的语义是「以文件夹方式开新窗口」，explorer 会把 `.lnk` 当成文件夹去
///   导航，结果是弹出「文档」而不是启动目标程序——v0.8.1 修的就是这个严重 bug。
///   而且这样也避免了「explorer 已启动一次 + fallback 又启动一次」的重复打开。
///
/// 返回 Err 时前端会弹 toast，别再让失败静默。
#[cfg(windows)]
pub fn open_path(path: &str) -> Result<(), String> {
    if std::path::Path::new(path).is_dir() {
        // 引号只包路径，别让 std 给整串套引号：路径里带空格时 explorer 会在空格处
        // 切分，"C:\Users\a b" 这种目录就会变成打开「文档」
        let ret = spawn_explorer(&format!("/n,\"{path}\""), true);
        log_launch(&format!("open(folder) {path} → {ret:?}"));
        if ret.is_ok() {
            return Ok(());
        }
        // 文件夹这条也保留回落：开新窗口失败时至少能让资源管理器打开
    }

    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op = HSTRING::from("open");
    let file = HSTRING::from(path);
    let code = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    }
    .0 as isize;
    // 返回值 > 32 才算成功；<= 32 是错误码（2 找不到文件、5 拒绝访问、31 无关联程序）
    log_launch(&format!("  ShellExecute → {code}  {path}"));
    if code > 32 {
        return Ok(());
    }
    Err(format!("打开失败（ShellExecute {code}）：{path}"))
}

#[cfg(not(windows))]
pub fn open_path(path: &str) -> Result<(), String> {
    let _ = path;
    Err("仅支持 Windows".into())
}

/// 用默认浏览器打开一个链接（只放行 http/https）。
///
/// 不能复用 open_path：那条路是「开资源管理器窗口」，喂给它一个 URL 会拿
/// explorer 去打开，行为不可控；这里直接交给 ShellExecute 的协议关联处理。
pub fn open_url(url: &str) -> Result<(), String> {
    let low = url.trim().to_ascii_lowercase();
    if !(low.starts_with("https://") || low.starts_with("http://")) {
        return Err(format!("只允许打开 http/https 链接：{url}"));
    }
    #[cfg(windows)]
    {
        use windows::core::{HSTRING, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op = HSTRING::from("open");
        let file = HSTRING::from(url);
        let code = unsafe {
            ShellExecuteW(
                None,
                PCWSTR(op.as_ptr()),
                PCWSTR(file.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        }
        .0 as isize;
        log_launch(&format!("url {url} → {code}"));
        if code > 32 {
            return Ok(());
        }
        return Err(format!("浏览器没有打开（ShellExecute {code}）"));
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".into())
}

pub fn reveal_path(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        // /select, 会在已有窗口里定位并选中；没有窗口时 explorer 自己开一个。
        // 引号只包路径：整串套引号会让空格把参数切断，explorer 于是打开「文档」。
        let r = spawn_explorer(&format!("/select,\"{path}\""), false);
        log_launch(&format!("reveal {path} → {r:?}"));
        r
    }
    #[cfg(not(windows))]
    Err("仅支持 Windows".into())
}
