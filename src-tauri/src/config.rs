//! 配置读写。
//!
//! 配置放在 `%APPDATA%\com.fy.desktop\config.json`。首次启动会尝试读取
//! v0.1（Electron 版本，`%APPDATA%\fy-desktop\config.json`）里的分组归属，
//! 免得老用户升级后桌面收纳全空。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

pub const CONFIG_VERSION: u32 = 4;

/// 最小吸附网格 / 最小缝隙（设计像素）。和前端 main.js 的 GRID / GAP 是同一套数。
pub const GRID: f64 = 6.0;

/// 小号边长（设计像素）。102 是 6 的整数倍，两张小卡并排的宽度才有意义。
pub const S: f64 = 102.0;

/// 中号 / 大号的宽度（设计像素）= 两个小号 + 一条最小缝隙，2 × 102 + 6 = 210。
/// 这样「两张小卡并排」与「一张中卡」占同样的宽度、留同样的缝。
pub const MW: f64 = 2.0 * S + GRID;

/// 尺寸档位 → 宽高（设计像素）
pub fn dims(size: &str) -> (f64, f64) {
    match size {
        "s" => (S, S),
        "l" => (MW, S + 24.0),
        _ => (MW, S),
    }
}

/// 某个组件允许的尺寸档位。
///
/// v0.7 起除备忘录外一律取消「大」：210×126 在桌面上太占地方，而多出来的
/// 24px 高度只够把同样的内容排松一点，读者并不会因此多看到信息。
/// 日历和备忘录塞不下 102×102，本来就没有「小」，所以日历只剩「中」一档。
pub fn sizes_for(kind: &str) -> &'static [&'static str] {
    match kind {
        "notes" => &["m", "l"],
        "calendar" => &["m"],
        _ => &["s", "m"],
    }
}

pub fn default_size(kind: &str) -> &'static str {
    match kind {
        // 数字钟只有一串时间，给中号纯属浪费桌面
        "digital" => "s",
        _ => "m",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetCfg {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    /// s | m | l。w/h 是它的推导结果，前端按档位重算，不单独调
    #[serde(default = "d_size")]
    pub size: String,
    pub w: f64,
    pub h: f64,
    /// glass | dusk | solid。空 = 跟随全局 cfg.material（老配置兼容）
    #[serde(default)]
    pub material: String,
}

fn d_size() -> String {
    "m".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCfg {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrganizerCfg {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub groups: Vec<GroupCfg>,
    #[serde(default)]
    pub folded: Vec<String>,
    /// 收纳根目录。空 = 桌面下的 fy-desktop 文件夹
    #[serde(default)]
    pub root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeatherCfg {
    pub lat: f64,
    pub lon: f64,
    /// 末级地名，卡片标题显示它（如「西湖区」）
    pub city: String,
    /// 完整行政区划，鼠标悬停时显示（如「浙江省 · 杭州市 · 西湖区」）
    #[serde(default)]
    pub admin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
    /// 配置版本号（乐观锁）。
    ///
    /// 前端是「整份配置 + 320ms 防抖」回传的，而后端命令（建分组、换地区、
    /// 改材质）也会直接改配置。两边同时写就会出现「整份回传把后端刚做的改动抹掉」。
    /// 每次后端落盘都 +1，前端回传时带上自己拿到的值，不一致就说明中间有人改过。
    #[serde(default)]
    pub rev: u64,
    /// 界面缩放。0 = 按屏幕宽度自动
    #[serde(default)]
    pub scale: f64,
    /// glass | dusk | solid
    #[serde(default = "d_material")]
    pub material: String,
    #[serde(default)]
    pub widgets: Vec<WidgetCfg>,
    pub organizer: OrganizerCfg,
    #[serde(default = "d_weather")]
    pub weather: WeatherCfg,
    #[serde(default)]
    pub autostart: bool,
    /// 是否用抓屏底图做真毛玻璃。老机器上抓屏失败时前端自动降级
    #[serde(default = "d_true")]
    pub glass: bool,
    #[serde(default = "d_true")]
    pub show_labels: bool,
    /// 时钟要不要显示秒。模拟时钟的秒针不受此开关影响
    #[serde(default = "d_true")]
    pub show_seconds: bool,
    /// 启动后自动去 GitHub 看一眼有没有新版本（只提示，不自动替换）
    #[serde(default = "d_true")]
    pub auto_update: bool,
    /// 备忘录内容，键是组件 id。
    ///
    /// 以前存在 WebView 的 localStorage 里：组件被移除后条目残留、WebView2 清理
    /// 缓存时正文直接丢，而其它状态都在 config.json 里——两套持久化策略不一致。
    #[serde(default)]
    pub notes: BTreeMap<String, String>,
}

fn d_material() -> String {
    "glass".into()
}
fn d_true() -> bool {
    true
}
fn d_weather() -> WeatherCfg {
    WeatherCfg {
        lat: 31.2304,
        lon: 121.4737,
        city: "上海".into(),
        admin: "上海市".into(),
    }
}

/// 收纳面板的宽度。
///
/// 格子是正方形、每排 7 个（organizer.js 的 COLS），所以宽度不能随手给：
/// 7 × 62 + 6 × 4(格子间隙) + 左右各 14(面板内边距) ≈ 486，
/// 每个格子正好落在 60 出头。给宽了格子会跟着长成大方块，收纳面板就白占地方。
pub fn org_width_for(design_w: f64) -> f64 {
    (design_w * 0.38).clamp(430.0, 520.0).round()
}

impl Config {
    /// 首次运行的默认布局：左列小组件，右侧收纳面板。
    /// 坐标是「设计像素」——屏幕实际像素除以缩放比之后的坐标系。
    pub fn default_for(design_w: f64, design_h: f64) -> Self {
    let _ = design_h;
        let groups = default_groups();
        let org_w = org_width_for(design_w);
        // 0 = 高度跟内容走。面板里 5 个分组通常只占半屏，
        // 固定成整屏高会留下一大片死白。
        let org_h = 0.0;
        let org_x = (design_w - org_w - 36.0).round();

        // 左列让开桌面图标的第一列（图标列含文字标签约 130 设计像素宽）。
        // 窗口在桌面层之下，图标永远画在卡片上面；默认位置贴边就等于让图标压住整列卡片。
        // 起点与间距都取吸附网格（6）的整数倍：竖排每张卡之间正好留出 6 的缝。
        let col_x = 186.0;

        Self {
            version: CONFIG_VERSION,
            rev: 1,
            scale: 0.0,
            material: d_material(),
            widgets: vec![
                widget("weather", col_x, 42.0),
                widget("clock", col_x, 150.0),
                widget("calendar", col_x, 258.0),
                widget("system", col_x, 366.0),
                widget("network", col_x, 474.0),
            ],
            organizer: OrganizerCfg {
                x: org_x,
                y: 36.0,
                w: org_w,
                h: org_h,
                groups,
                folded: vec!["archive".into()],
                root: String::new(),
            },
            weather: d_weather(),
            // 桌面小组件装完就该跟着系统起来，默认开；托盘里随时能关。
            autostart: true,
            glass: true,
            show_labels: true,
            show_seconds: true,
            auto_update: true,
            notes: BTreeMap::new(),
        }
    }
}

fn widget(kind: &str, x: f64, y: f64) -> WidgetCfg {
    let size = default_size(kind).to_string();
    let (w, h) = dims(&size);
    WidgetCfg {
        id: format!("{kind}-{}", next_seq()),
        kind: kind.into(),
        x,
        y,
        size,
        w,
        h,
        material: String::new(),
    }
}

fn next_seq() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

pub fn default_groups() -> Vec<GroupCfg> {
    vec![
        GroupCfg {
            id: "dev".into(),
            name: "开发工具".into(),
            color: "#3d8bf0".into(),
        },
        GroupCfg {
            id: "design".into(),
            name: "设计素材".into(),
            color: "#b16ce0".into(),
        },
        GroupCfg {
            id: "docs".into(),
            name: "常用文档".into(),
            color: "#2fa27c".into(),
        },
        GroupCfg {
            id: "media".into(),
            name: "影音图像".into(),
            color: "#e2712c".into(),
        },
        GroupCfg {
            id: "archive".into(),
            name: "归档".into(),
            color: "#8d9aa6".into(),
        },
    ]
}

pub fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join("com.fy.desktop")
}

fn file() -> PathBuf {
    config_path().join("config.json")
}

pub fn load_or_default(design_w: f64, design_h: f64) -> Config {
    let p = file();
    if let Ok(text) = std::fs::read_to_string(&p) {
        if let Ok(mut cfg) = serde_json::from_str::<Config>(&text) {
            // v3 → v4：格子改成正方形、每排 7 个。老配置的面板宽度（常见 600）
            // 会把 7 个格子拉成 78px 的大方块，所以按新算法重算一次宽度，
            // 右边缘保持不动，视觉上只是左边收窄一条。
            if cfg.version < 4 {
                let w = org_width_for(design_w);
                let right = cfg.organizer.x + cfg.organizer.w;
                cfg.organizer.w = w;
                cfg.organizer.x = (right - w).max(0.0);
            }
            cfg.version = CONFIG_VERSION;
            return cfg;
        }
        // 配置坏了不至于打不开：备份一份再重建
        let _ = std::fs::copy(&p, p.with_extension("json.bak"));
    }

    // v0.1（Electron 版）只做虚拟分组，没真正移动过文件，
    // 布局与尺寸规范也全变了，所以不做迁移，直接从默认布局开始。
    let cfg = Config::default_for(design_w, design_h);
    save(&cfg);
    cfg
}

pub fn save(cfg: &Config) {
    let dir = config_path();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(cfg) {
        // 先写临时文件再改名，避免掉电/崩溃留下半截 JSON
        let tmp = dir.join("config.json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join("config.json"));
        }
    }
}

/* ------------------------- 配置校验与归一化 ------------------------- */

fn clamp_num(v: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    if !v.is_finite() {
        return fallback;
    }
    v.clamp(lo, hi)
}

fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// 收纳根目录允许任意盘符的绝对路径，但不接受相对路径和 `..`：
/// 前者取决于进程 cwd（开机自启时是 system32），后者会跳出预期目录。
fn is_safe_root(p: &str) -> bool {
    let t = p.trim();
    if t.is_empty() {
        return true;
    }
    let path = std::path::Path::new(t);
    path.is_absolute()
        && !path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
}

/// 分组名会变成磁盘上的目录名，先洗一遍并去掉重名：
/// 两个分组同名就会写到同一个文件夹，之后改名/删除会互相打架。
fn normalize_groups(groups: &mut Vec<GroupCfg>) {
    let bad = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
    let mut seen_ids: Vec<String> = Vec::new();
    let mut seen_names: Vec<String> = Vec::new();
    groups.retain_mut(|g| {
        let name: String = g
            .name
            .chars()
            .map(|c| if bad.contains(&c) { '_' } else { c })
            .collect();
        let name = name.trim().trim_end_matches('.').to_string();
        if name.is_empty() {
            return false;
        }
        let id = g.id.trim().to_string();
        if id.is_empty() || seen_ids.iter().any(|x| x.eq_ignore_ascii_case(&id)) {
            return false;
        }
        let lower = name.to_lowercase();
        if seen_names.iter().any(|x| x.eq_ignore_ascii_case(&lower)) {
            return false;
        }
        seen_ids.push(id.clone());
        seen_names.push(lower);
        g.id = id;
        g.name = name;
        if !is_hex_color(&g.color) {
            let i = seen_ids.len() - 1;
            g.color = crate::consts::GROUP_COLORS[i % crate::consts::GROUP_COLORS.len()].to_string();
        }
        true
    });
}

/// 把前端回传的整份配置按「不信任」处理：越界坐标夹回屏幕、非法枚举回退默认、
/// 多余的字段丢掉。宁可丢一个字段，也不要一个坏值反复落盘。
pub fn normalize(cfg: &mut Config, design_w: f64, design_h: f64) {
    let dw = if design_w.is_finite() && design_w > 0.0 { design_w } else { 1920.0 };
    let dh = if design_h.is_finite() && design_h > 0.0 { design_h } else { 1080.0 };

    cfg.version = CONFIG_VERSION;
    cfg.scale = if cfg.scale == 0.0 {
        0.0
    } else {
        clamp_num(cfg.scale, 1.0, 2.0, 1.0)
    };
    if !crate::consts::MATERIALS.contains(&cfg.material.as_str()) {
        cfg.material = d_material();
    }

    let mut seen = std::collections::HashSet::new();
    cfg.widgets
        .retain(|w| !w.id.trim().is_empty() && !w.kind.trim().is_empty() && seen.insert(w.id.clone()));
    for w in cfg.widgets.iter_mut() {
        let allowed = sizes_for(&w.kind);
        if !allowed.contains(&w.size.as_str()) {
            w.size = default_size(&w.kind).to_string();
        }
        let (cw, ch) = dims(&w.size);
        w.w = cw;
        w.h = ch;
        w.x = clamp_num(w.x, 0.0, (dw - cw).max(0.0), 0.0).round();
        w.y = clamp_num(w.y, 0.0, (dh - ch).max(0.0), 0.0).round();
        if !w.material.is_empty() && !crate::consts::MATERIALS.contains(&w.material.as_str()) {
            w.material = String::new();
        }
    }

    normalize_groups(&mut cfg.organizer.groups);
    {
        let ids: Vec<String> = cfg.organizer.groups.iter().map(|g| g.id.clone()).collect();
        cfg.organizer
            .folded
            .retain(|id| ids.iter().any(|x| x == id));
    }

    let o = &mut cfg.organizer;
    o.w = clamp_num(o.w, 320.0, dw.max(320.0), org_width_for(dw)).round();
    o.h = if o.h > 0.0 {
        clamp_num(o.h, 260.0, dh.max(260.0), 0.0).round()
    } else {
        0.0
    };
    o.x = clamp_num(o.x, 0.0, (dw - o.w).max(0.0), 0.0).round();
    let oh = if o.h > 0.0 { o.h.min(dh) } else { dh * 0.5 };
    o.y = clamp_num(o.y, 0.0, (dh - oh).max(0.0), 0.0).round();
    // 收纳根：去掉首尾空白 → 不接受相对路径/`..` → 已存在但不是目录（盘符被拔掉、
    // 或被改成同名文件）就退回默认桌面，避免每次启动都对着一个死路径建目录失败
    let root = o.root.trim().to_string();
    o.root = if root.is_empty() || !is_safe_root(&root) {
        String::new()
    } else {
        let p = std::path::Path::new(&root);
        if p.exists() && !p.is_dir() {
            String::new()
        } else {
            root
        }
    };

    if !(-90.0..=90.0).contains(&cfg.weather.lat) || !(-180.0..=180.0).contains(&cfg.weather.lon) {
        cfg.weather = d_weather();
    }

    // 备忘录键跟着组件走：组件删了正文也不该一直躺在配置里
    let ids: Vec<String> = cfg.widgets.iter().map(|w| w.id.clone()).collect();
    cfg.notes.retain(|id, _| ids.iter().any(|x| x == id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Config {
        Config::default_for(1920.0, 1080.0)
    }

    #[test]
    fn normalize_clamps_widgets_into_screen() {
        let mut c = sample();
        c.widgets[0].x = 99_999.0;
        c.widgets[0].y = -50.0;
        c.widgets[0].size = "huge".into();
        normalize(&mut c, 1920.0, 1080.0);
        let w = &c.widgets[0];
        assert!(sizes_for(&w.kind).contains(&w.size.as_str()));
        assert!(w.x >= 0.0 && w.x + w.w <= 1920.0);
        assert!(w.y >= 0.0);
        assert_eq!((w.w, w.h), dims(&w.size));
    }

    #[test]
    fn normalize_rejects_bad_root_and_material() {
        let mut c = sample();
        c.organizer.root = r"..\..\Windows".into();
        c.material = "rainbow".into();
        normalize(&mut c, 1920.0, 1080.0);
        assert!(c.organizer.root.is_empty());
        assert_eq!(c.material, "glass");
    }

    #[test]
    fn normalize_drops_duplicate_groups() {
        let mut c = sample();
        c.organizer.groups.push(GroupCfg {
            id: c.organizer.groups[0].id.clone(),
            name: "  开发工具  ".into(),
            color: "nope".into(),
        });
        normalize(&mut c, 1920.0, 1080.0);
        let names: Vec<&str> = c.organizer.groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names.len(), 5, "重复 id / 名字的分组应该被丢掉");
    }

    #[test]
    fn normalize_drops_notes_of_removed_widgets() {
        let mut c = sample();
        let alive = c.widgets[0].id.clone();
        c.notes.insert(alive.clone(), "留着".into());
        c.notes.insert("ghost-1".into(), "该删".into());
        normalize(&mut c, 1920.0, 1080.0);
        assert!(c.notes.contains_key(&alive));
        assert!(!c.notes.contains_key("ghost-1"));
    }

    #[test]
    fn normalize_keeps_valid_weather() {
        let mut c = sample();
        c.weather.lat = 200.0;
        normalize(&mut c, 1920.0, 1080.0);
        assert!(c.weather.lat.abs() <= 90.0);
        assert!(c.weather.lon.abs() <= 180.0);
    }
}
