//! 进程内共享状态。

use crate::config::Config;
use std::sync::Mutex;

#[derive(Default)]
pub struct HitState {
    /// 需要接收鼠标的区域，物理像素、屏幕坐标
    pub regions: Vec<[f64; 4]>,
    /// 前端强制接管（拖拽、编辑、组件库打开时）
    pub force: bool,
    /// 当前是否处于穿透状态，只在变化时才调系统 API
    pub ignoring: bool,
}

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
        self.cfg
            .lock()
            .map(|c| c.clone())
            .unwrap_or_else(|p| p.into_inner().clone())
    }

    pub fn with_config<R>(&self, f: impl FnOnce(&mut Config) -> R) -> R {
        let mut guard = self.cfg.lock().unwrap_or_else(|p| p.into_inner());
        let r = f(&mut guard);
        crate::config::save(&guard);
        r
    }
}
