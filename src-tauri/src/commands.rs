//! 暴露给前端的命令。命名统一 `域:动作`。

use crate::config::Config;
use crate::desktop::{self, glass, icons, DesktopView};
use crate::state::AppState;
use crate::weather::{self, Weather};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize)]
pub struct Boot {
    pub config: Config,
    pub design: (f64, f64),
    pub scale: f64,
    pub version: String,
    pub root: String,
    pub autostart: bool,
    /// 本次是否自检截图模式（截图时要等数据齐了再拍）
    pub shot: bool,
    /// 调试：启动后自动打开某个弹层（FY_UI=place|group），配合截图核对用
    pub uitest: String,
}

#[tauri::command]
pub fn boot(state: State<'_, AppState>) -> Boot {
    let cfg = state.config();
    let design = *state.design.lock().unwrap_or_else(|p| p.into_inner());
    let scale = *state.scale.lock().unwrap_or_else(|p| p.into_inner());

    let autostart = crate::autostart::is_enabled();

    Boot {
        root: desktop::root_dir(&cfg).to_string_lossy().to_string(),
        config: cfg,
        design,
        scale,
        version: env!("CARGO_PKG_VERSION").into(),
        autostart,
        shot: std::env::var("FY_SHOT").is_ok(),
        uitest: std::env::var("FY_UI").unwrap_or_default(),
    }
}

/// 渲染层就绪次数。进程内累加，用来区分「就绪一次」和「页面被重建了 N 次」。
/// WebView2 在渲染进程被回收后会自动重新加载页面，前端看不出原因，
/// 只有把计数和导航类型打出来才能判断是重载还是崩溃恢复。
static READY_COUNT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 第一次渲染完成后才显示窗口，避免白底闪一下
#[tauri::command]
pub fn ui_ready(app: AppHandle, nav: Option<String>, boots: Option<u32>) {
    // 回归测试用：故意不显示，验证后端看门狗能把窗口捞回来
    if std::env::var("FY_NO_UI_READY").is_ok() {
        eprintln!("[ui] FY_NO_UI_READY：跳过显示");
        return;
    }
    if let Some(win) = app.get_webview_window("main") {
        let hwnd = hwnd_of(&win);
        crate::UI_READY.store(true, std::sync::atomic::Ordering::SeqCst);
        crate::window::show_no_activate(hwnd);
        let ms = crate::BORN.get().map(|t| t.elapsed().as_millis()).unwrap_or(0);
        let n = READY_COUNT.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        eprintln!(
            "[ui] ready #{n} +{ms}ms nav={} boots={} hwnd={hwnd:#x} pos={:?} size={:?} visible={}",
            nav.as_deref().unwrap_or("?"),
            boots.map(|b| b.to_string()).unwrap_or_else(|| "?".into()),
            win.outer_position().ok(),
            win.inner_size().ok(),
            crate::window::is_visible(hwnd)
        );
    }
}

#[tauri::command]
pub fn save_config(state: State<'_, AppState>, config: Config) {
    state.with_config(|c| *c = config);
}

#[tauri::command]
pub fn desktop_view(state: State<'_, AppState>) -> DesktopView {
    desktop::view(&state.config())
}

/// 图标提取会走 COM，一次几十个要几百毫秒，放 blocking 线程池里跑
#[tauri::command]
pub async fn desktop_icons(paths: Vec<String>) -> Vec<(String, String)> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .filter_map(|p| icons::data_url(&p).map(|url| (p, url)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    desktop::open_path(&path)
}

#[tauri::command]
pub fn reveal_path(path: String) {
    desktop::reveal_path(&path);
}

#[tauri::command]
pub fn open_root(state: State<'_, AppState>) -> Result<(), String> {
    let root = desktop::root_dir(&state.config());
    if let Err(e) = std::fs::create_dir_all(&root) {
        desktop::log_launch(&format!("open_root 建目录失败 {}：{e}", root.display()));
        return Err(format!("收纳目录不可用：{e}"));
    }
    desktop::open_path(&root.to_string_lossy())
}

#[tauri::command]
pub fn open_config_dir() -> Result<(), String> {
    desktop::open_path(&crate::config::config_path().to_string_lossy())
}

#[tauri::command]
pub fn move_into(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
    group: String,
) -> Result<usize, String> {
    let n = desktop::move_into(&state.config(), &paths, &group)?;
    refresh(&app);
    Ok(n)
}

#[tauri::command]
pub fn move_out(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    let n = desktop::move_out(&paths)?;
    refresh(&app);
    Ok(n)
}

#[derive(Serialize)]
pub struct TidyBucket {
    pub group: String,
    pub name: String,
    pub color: String,
    pub count: usize,
}

#[tauri::command]
pub fn tidy_preview(state: State<'_, AppState>) -> Vec<TidyBucket> {
    let cfg = state.config();
    let view = desktop::view(&cfg);
    desktop::classify(&cfg, &view.loose)
        .into_iter()
        .map(|(gid, paths)| {
            let g = cfg.organizer.groups.iter().find(|g| g.id == gid);
            TidyBucket {
                name: g.map(|g| g.name.clone()).unwrap_or_else(|| gid.clone()),
                color: g.map(|g| g.color.clone()).unwrap_or_default(),
                group: gid,
                count: paths.len(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn tidy_apply(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let cfg = state.config();
    let view = desktop::view(&cfg);
    let mut total = 0;
    for (gid, paths) in desktop::classify(&cfg, &view.loose) {
        total += desktop::move_into(&cfg, &paths, &gid)?;
    }
    refresh(&app);
    Ok(total)
}

#[tauri::command]
pub fn create_group(app: AppHandle, state: State<'_, AppState>, name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("分组名不能为空".into());
    }
    let cfg = state.config();
    let id = format!("g{}", now_ms());
    let color = pick_color(cfg.organizer.groups.len());
    let group = crate::config::GroupCfg {
        id: id.clone(),
        name: name.clone(),
        color,
    };
    let dir = desktop::group_dir(&desktop::root_dir(&cfg), &group);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败: {e}"))?;
    state.with_config(|c| c.organizer.groups.push(group));
    refresh(&app);
    Ok(id)
}

#[tauri::command]
pub fn rename_group(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("分组名不能为空".into());
    }
    let cfg = state.config();
    let root = desktop::root_dir(&cfg);
    let old = cfg
        .organizer
        .groups
        .iter()
        .find(|g| g.id == id)
        .ok_or_else(|| "分组不存在".to_string())?
        .clone();

    let from = desktop::group_dir(&root, &old);
    let mut next = old.clone();
    next.name = name;
    let to = desktop::group_dir(&root, &next);
    if from.exists() && from != to {
        std::fs::create_dir_all(to.parent().unwrap_or(&root)).ok();
        std::fs::rename(&from, &to).map_err(|e| format!("重命名目录失败: {e}"))?;
    }
    state.with_config(|c| {
        if let Some(g) = c.organizer.groups.iter_mut().find(|g| g.id == id) {
            g.name = next.name;
        }
    });
    refresh(&app);
    Ok(())
}

/// 删分组：格子里的东西先搬回桌面，绝不静默删文件。
#[tauri::command]
pub fn delete_group(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<usize, String> {
    let cfg = state.config();
    let root = desktop::root_dir(&cfg);
    let Some(group) = cfg.organizer.groups.iter().find(|g| g.id == id).cloned() else {
        return Err("分组不存在".into());
    };
    let dir = desktop::group_dir(&root, &group);
    let mut moved = 0;
    if dir.is_dir() {
        let items = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        moved = desktop::move_out(&items)?;
        let _ = std::fs::remove_dir(&dir); // 空目录才删得掉，非空说明还有残留，留着更安全
    }
    state.with_config(|c| c.organizer.groups.retain(|g| g.id != id));
    refresh(&app);
    Ok(moved)
}

#[tauri::command]
pub fn set_hit_regions(state: State<'_, AppState>, rects: Vec<[f64; 4]>, force: bool) {
    crate::window::set_regions(&state, rects, force);
}

/// 抓一张不含本窗口的桌面底图，给前端做毛玻璃背景
#[tauri::command]
pub fn glass_snapshot(app: AppHandle) -> Result<String, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "窗口不存在".to_string())?;
    let hwnd = hwnd_of(&win);
    match glass::snapshot(hwnd, false) {
        Ok(url) => Ok(url),
        Err(e) => {
            eprintln!("[glass] 抓屏失败: {e} (hwnd={hwnd:#x})");
            Err(e)
        }
    }
}

#[tauri::command]
pub fn set_autostart(on: bool) -> Result<bool, String> {
    crate::autostart::set(on)?;
    Ok(crate::autostart::is_enabled())
}

#[tauri::command]
pub fn weather_now(state: State<'_, AppState>) -> Option<Weather> {
    let _ = state;
    weather::latest()
}

/// 地名搜索：中文区县级也能命中（走 photon / OSM）
#[tauri::command]
pub async fn geo_search(q: String) -> Result<Vec<crate::geo::Place>, String> {
    crate::geo::search(&q).await
}

/// 换天气地区。写完立刻重拉一次，不用等 15 分钟的轮询周期。
#[tauri::command]
pub fn set_weather_place(
    app: AppHandle,
    state: State<'_, AppState>,
    label: String,
    name: String,
    lat: f64,
    lon: f64,
) -> Result<(), String> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("经纬度超出范围".into());
    }
    state.with_config(|c| {
        c.weather.lat = lat;
        c.weather.lon = lon;
        c.weather.city = name.clone();
        c.weather.admin = label.clone();
    });
    let cfg = state.config();
    tauri::async_runtime::spawn(async move {
        if let Some(w) = weather::fetch(&cfg).await {
            weather::store(&w);
            let _ = app.emit("weather", &w);
        } else {
            let _ = app.emit("weather:error", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub fn weather_refresh(app: AppHandle, state: State<'_, AppState>) {
    let cfg = state.config();
    tauri::async_runtime::spawn(async move {
        if let Some(w) = weather::fetch(&cfg).await {
            let _ = app.emit("weather", &w);
        }
    });
}

#[tauri::command]
pub fn set_material(state: State<'_, AppState>, material: String) {
    state.with_config(|c| c.material = material);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// 自检时把布局坐标落盘，方便无人值守核对
#[tauri::command]
pub fn dev_dump(json: String) {
    if let Ok(path) = std::env::var("FY_SHOT") {
        let target = std::path::Path::new(&path).with_extension("json");
        let _ = std::fs::write(target, json);
    }
}

fn refresh(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("desktop:changed", ());
    }
}

fn pick_color(i: usize) -> String {
    const C: [&str; 6] = [
        "#3d8bf0", "#b16ce0", "#2fa27c", "#e2712c", "#8d9aa6", "#d94f70",
    ];
    C[i % C.len()].to_string()
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub fn hwnd_of(win: &tauri::WebviewWindow) -> isize {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        let raw = win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let _ = HWND::default();
        raw
    }
    #[cfg(not(windows))]
    {
        let _ = win;
        0
    }
}
