//! 配置读写。
//!
//! 配置放在 `%APPDATA%\com.fy.desktop\config.json`。首次启动会尝试读取
//! v0.1（Electron 版本，`%APPDATA%\fy-desktop\config.json`）里的分组归属，
//! 免得老用户升级后桌面收纳全空。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const CONFIG_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WidgetCfg {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
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
    pub city: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub version: u32,
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
    }
}

impl Config {
    /// 首次运行的默认布局：左列小组件，右侧收纳面板。
    /// 坐标是「设计像素」——屏幕实际像素除以缩放比之后的坐标系。
    pub fn default_for(design_w: f64, design_h: f64) -> Self {
    let _ = design_h;
        let groups = default_groups();
        let org_w = (design_w * 0.40).clamp(430.0, 600.0).round();
        // 0 = 高度跟内容走。面板里 5 个分组通常只占半屏，
        // 固定成整屏高会留下一大片死白。
        let org_h = 0.0;
        let org_x = (design_w - org_w - 36.0).round();

        // 左列让开桌面图标的第一列（图标列含文字标签约 130 设计像素宽）。
        // 窗口在桌面层之下，图标永远画在卡片上面；默认位置贴边就等于让图标压住整列卡片。
        let col_x = 180.0;

        Self {
            version: CONFIG_VERSION,
            scale: 0.0,
            material: d_material(),
            widgets: vec![
                widget("weather", col_x, 36.0),
                widget("clock", col_x, 178.0),
                widget("calendar", col_x, 390.0),
                widget("system", col_x, 552.0),
                widget("network", col_x, 714.0),
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
        }
    }
}

fn widget(kind: &str, x: f64, y: f64) -> WidgetCfg {
    let (w, h) = crate::widget_size(kind);
    WidgetCfg {
        id: format!("{kind}-{}", next_seq()),
        kind: kind.into(),
        x,
        y,
        w,
        h,
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
