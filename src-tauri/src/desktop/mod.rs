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

/// 用 ShellExecuteW 打开文件 / 文件夹 / 快捷方式。
///
/// 以前是 `cmd /c start "" <path>`：cmd 本身是以 CREATE_NO_WINDOW 起的，
/// `start` 派生新进程时会继承「不要显示窗口」的启动信息，于是资源管理器窗口
/// 在后台建好、又立刻按隐藏状态显示——用户看到的就是「点了没反应」。
/// ShellExecuteW 直接交给外壳去执行默认动作，不经过 cmd，也就没有这层污染。
///
/// 返回 Err 时前端会弹 toast，别再让失败静默。
#[cfg(windows)]
pub fn open_path(path: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let op = HSTRING::from("open");
    let file = HSTRING::from(path);
    let ret = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(op.as_ptr()),
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // 返回值 > 32 才算成功；<= 32 是错误码（2 找不到文件、5 拒绝访问、31 无关联程序）
    let code = ret.0 as isize;
    log_launch(&format!("open {path} → {code}"));
    if code > 32 {
        return Ok(());
    }

    // 外壳拒绝时退回 explorer：至少文件夹还能开
    let fell = std::process::Command::new("explorer")
        .arg(path)
        .creation_flags(0)
        .spawn();
    log_launch(&format!(
        "  fallback explorer {path} → {}",
        match &fell {
            Ok(_) => "ok".to_string(),
            Err(e) => e.to_string(),
        }
    ));
    fell.map(|_| ()).map_err(|e| format!("打开失败（{code}）：{e}"))
}

#[cfg(not(windows))]
pub fn open_path(path: &str) -> Result<(), String> {
    let _ = path;
    Err("仅支持 Windows".into())
}

pub fn reveal_path(path: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .creation_flags(0)
            .spawn();
    }
}
