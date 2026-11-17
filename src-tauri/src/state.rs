//! 进程内共享状态。

use crate::config::Config;
use std::sync::{Mutex, MutexGuard};

/// 统一取锁。
///
/// 以前各处都写 `lock().unwrap_or_else(|p| p.into_inner())`：锁中毒（持锁线程 panic）
/// 时静默拿到可能写坏一半的状态继续跑，问题被藏起来。这里至少留一条日志，
/// 让「配置自己变回去了」这类怪事有迹可循。
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(p) => {
            eprintln!("[state] 锁中毒：持锁线程 panic 过，按内部值继续（如遇异常请重启）");
            p.into_inner()
        }
    }
}

#[derive(Default)]
pub struct HitState {
    /// 需要接收鼠标的区域，物理像素、屏幕坐标
    pub regions: Vec<[f64; 4]>,
    /// 前端强制接管（拖拽、编辑、组件库打开时）
    pub force: bool,
    /// 当前是否处于穿透状态，只在变化时才调系统 API
    pub ignoring: bool,
    /// 托盘菜单的矩形（物理像素）。Some 时后台轮询全局左键，
    /// 落在它外面就推 `menu:outside` 让前端收起菜单——
    /// 点在别的应用或任务栏上时，我们的窗口根本收不到事件，只能靠后端。
    pub menu: Option<[f64; 4]>,
    /// 菜单刚弹出的那一拍左键可能还按着（托盘那一下），
    /// 等看到一次「抬起」再开始判「按下」，否则菜单会立刻被自己关掉。
    pub menu_armed: bool,
    /// 上一轮轮询时左键是否按下，用来取按下的上升沿
    pub last_down: bool,
}

/// 控制中心还没加载完时先攒着的「打开哪一页 / 弹哪个框」请求。
///
/// 托盘点击与桌面卡片双击都可能比 hub 的 WebView 先到；只发事件会丢，
/// 所以命令里同时存一份，页面启动时通过 `hub_boot` 取走。
#[derive(Default)]
pub struct HubPending(pub Mutex<Option<serde_json::Value>>);

pub struct AppState {
    pub cfg: Mutex<Config>,
    /// 界面缩放比，由屏幕宽度推出，前端也按同一公式算
    pub scale: Mutex<f64>,
    pub hit: Mutex<HitState>,
    /// 设计坐标系尺寸（= 窗口 CSS 像素 / 缩放）
    pub design: Mutex<(f64, f64)>,
}

impl AppState {
    pub fn new(cfg: Config) -> Self {
        Self {
            cfg: Mutex::new(cfg),
            scale: Mutex::new(1.0),
            hit: Mutex::new(HitState::default()),
            design: Mutex::new((1920.0, 1080.0)),
        }
    }

    pub fn config(&self) -> Config {
        lock(&self.cfg).clone()
    }

    /// 改配置并立刻落盘。每次写入都把 `rev` 推一格，前端据此判断自己的副本是否过期。
    pub fn with_config<R>(&self, f: impl FnOnce(&mut Config) -> R) -> R {
        let mut guard = lock(&self.cfg);
        let r = f(&mut guard);
        guard.rev = guard.rev.wrapping_add(1);
        crate::config::save(&guard);
        r
    }

    /// 直接替换整份配置（已校验过的），同样推进 `rev`。
    pub fn replace_config(&self, mut next: Config) -> Config {
        let mut guard = lock(&self.cfg);
        next.rev = guard.rev.wrapping_add(1);
        guard.rev = next.rev;
        *guard = next.clone();
        crate::config::save(&guard);
        next
    }
}
