//! 暴露给前端的命令。命名统一 `域:动作`。

use crate::config::Config;
use crate::consts::MATERIALS;
use crate::desktop::{self, glass, icons, DesktopView};
use crate::state::{AppState, HubPending};
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
    /// 分组配色由后端下发。以前前端 organizer.js 和 commands.rs 各写一份，
    /// 加一个颜色就得改两处，迟早漂移。
    pub palette: Vec<String>,
    /// 本次是否自检截图模式（截图时要等数据齐了再拍）
    pub shot: bool,
    /// 调试：启动后自动打开某个弹层（FY_UI=place|group），配合截图核对用
    pub uitest: String,
}

#[tauri::command]
pub fn boot(state: State<'_, AppState>) -> Boot {
    let cfg = state.config();
    let design = *crate::state::lock(&state.design);
    let scale = *crate::state::lock(&state.scale);

    let autostart = crate::autostart::is_enabled();

    Boot {
        root: desktop::root_dir(&cfg).to_string_lossy().to_string(),
        config: cfg,
        design,
        scale,
        version: env!("CARGO_PKG_VERSION").into(),
        autostart,
        palette: crate::consts::GROUP_COLORS.iter().map(|c| c.to_string()).collect(),
        shot: std::env::var("FY_SHOT").is_ok(),
        uitest: std::env::var("FY_UI").unwrap_or_default(),
    }
}

/* ---------------------------- 控制中心（hub） ----------------------------
   控制中心是独立的普通窗口（label = hub）：托盘左键呼出，桌面上的卡片、
   收纳面板完全不受影响。它不直接改配置的布局部分——把「加组件 / 换尺寸 /
   换材质 / 换缩放」当意图发给 main，由桌面窗口用自己那套空位、吸附、热区
   逻辑执行，避免两份布局算法各自漂移。 */

#[derive(Serialize)]
pub struct HubBoot {
    pub config: Config,
    pub version: String,
    pub root: String,
    pub autostart: bool,
    pub palette: Vec<String>,
    /// 窗口还没加载完时攒下的「打开哪一页 / 弹哪个框」
    pub pending: Option<serde_json::Value>,
}

#[tauri::command]
pub fn hub_boot(state: State<'_, AppState>, pending: State<'_, HubPending>) -> HubBoot {
    let cfg = state.config();
    let pending = pending.0.lock().ok().and_then(|mut g| g.take());
    HubBoot {
        root: desktop::root_dir(&cfg).to_string_lossy().to_string(),
        autostart: crate::autostart::is_enabled(),
        palette: crate::consts::GROUP_COLORS.iter().map(|c| c.to_string()).collect(),
        version: env!("CARGO_PKG_VERSION").into(),
        config: cfg,
        pending,
    }
}

/// 显示并聚焦控制中心。托盘点击带来前台权限，set_focus 通常能生效。
///
/// 窗口在 tauri.conf.json 里声明，启动时以 visible:false 建好：
/// 运行时再建第二套 WebView2 会拿到一个不绘制内容的空白窗口（这台机器上实测），
/// 而两套窗口的 additionalBrowserArgs 不一致又会直接创建失败。
pub fn show_hub(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("hub") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 打开控制中心，可指定页面与要弹出的框。
/// 事件用于「窗口已加载」的常规路径，pending 用于「窗口还没加载完」的冷启动。
#[tauri::command]
pub fn open_hub(
    app: AppHandle,
    pending: State<'_, HubPending>,
    view: Option<String>,
    dialog: Option<serde_json::Value>,
) {
    let intent = serde_json::json!({ "view": view, "dialog": dialog });
    if let Ok(mut g) = pending.0.lock() {
        *g = Some(intent.clone());
    }
    open_hub_intent(&app, intent);
}

/// 命令与调试入口共用：先攒 pending（给还没加载完的页面），再广播并显示。
pub fn open_hub_intent(app: &AppHandle, intent: serde_json::Value) {
    if let Some(p) = app.try_state::<HubPending>() {
        if let Ok(mut g) = p.0.lock() {
            *g = Some(intent.clone());
        }
    }
    let _ = app.emit("hub:intent", &intent);
    show_hub(app);
}

/// 控制中心的日志出口。WebView2 的 console 不会进终端，自检时靠它确认脚本跑到哪一步。
#[tauri::command]
pub fn hub_log(msg: String) {
    eprintln!("[hub:js] {msg}");
}

#[tauri::command]
pub fn hide_hub(app: AppHandle) {
    if let Some(w) = app.get_webview_window("hub") {
        let _ = w.hide();
    }
}

/// 托盘左键：显示 / 收起。
///
/// Windows 下双击托盘会连发两次 Click——第一次收起、第二次又打开，
/// 用户看到的是闪一下。350ms 内的第二次点击只当作「确保显示」。
pub fn toggle_hub(app: &AppHandle) {
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

    let now = Instant::now();
    let double = {
        let m = LAST.get_or_init(|| Mutex::new(None));
        let mut g = crate::state::lock(m);
        let d = g
            .map(|t| now.duration_since(t) < Duration::from_millis(350))
            .unwrap_or(false);
        *g = Some(now);
        d
    };
    if double {
        show_hub(app);
        return;
    }
    if let Some(w) = app.get_webview_window("hub") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            show_hub(app);
        }
    } else {
        show_hub(app);
    }
}

/// 控制中心发来的操作。转发给桌面窗口执行（见上面注释）。
#[tauri::command]
pub fn hub_action(app: AppHandle, action: serde_json::Value) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.emit("hub:action", action);
    }
}

/// 把后端当前配置推给所有窗口。控制中心靠它刷新列表与选中态，
/// 桌面窗口靠它同步「开机自启 / 自动更新 / 天气地区 / 分组」这些后端改过的字段。
fn broadcast_config(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let _ = app.emit("config:changed", state.config());
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

/// 前端整份回传配置。返回值是「后端最终采纳的那份」，前端拿它刷新自己的 `rev`。
///
/// 两条写路径（前端整份回传 / 后端命令增量改）同时存在时，靠 `rev` 判断新鲜度：
/// 版本对不上说明中间有命令改过配置，这时分组与天气以后端为准——否则一次防抖
/// 回传就会把「刚建好的分组」「刚改完的地区」抹掉。
#[tauri::command]
pub fn save_config(app: AppHandle, state: State<'_, AppState>, mut config: Config) -> Config {
    let design = *crate::state::lock(&state.design);
    crate::config::normalize(&mut config, design.0, design.1);

    let stale = {
        let cur = crate::state::lock(&state.cfg);
        if config.rev != cur.rev {
            config.organizer.groups = cur.organizer.groups.clone();
            config.weather = cur.weather.clone();
            true
        } else {
            false
        }
    };
    if stale {
        eprintln!("[config] 回传的 rev 过期（{}），保留后端的分组与天气", config.rev);
    }
    let out = state.replace_config(config);
    broadcast_config(&app);
    out
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Config {
    state.config()
}

#[tauri::command]
pub fn desktop_view(state: State<'_, AppState>) -> DesktopView {
    desktop::view(&state.config())
}

/// 图标提取会走 COM，一次几十个要几百毫秒，放 blocking 线程池里跑。
/// 传空列表 = 「刷新」链路的一次空转：顺手清一遍过期缓存，把「只增不减」补上。
#[tauri::command]
pub async fn desktop_icons(paths: Vec<String>) -> Vec<(String, String)> {
    tauri::async_runtime::spawn_blocking(move || {
        if paths.is_empty() {
            icons::prune_cache();
            return Vec::new();
        }
        paths
            .into_iter()
            .filter_map(|p| icons::data_url(&p).map(|url| (p, url)))
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// 打开类命令的审计：路径是否落在「桌面 / 收纳根 / 配置目录」之内。
///
/// 这些命令仍然放行任意路径（用户可能就是想打开某个目录），但越界会留一行
/// 日志——真被注入时至少能在 launch.log 里看到痕迹。
fn audit_path(state: &AppState, kind: &str, path: &str) {
    let cfg = state.config();
    let p = std::path::Path::new(path);
    let allowed = desktop::is_within(p, &desktop::root_dir(&cfg))
        || desktop::desktop_dirs().iter().any(|d| desktop::is_within(p, d))
        || desktop::is_within(p, &crate::config::config_path())
        || desktop::is_within(p, &std::env::temp_dir());
    if !allowed {
        desktop::log_launch(&format!("[audit] {kind} 越界路径：{path}"));
    }
}

#[tauri::command]
pub fn open_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    audit_path(&state, "open", &path);
    desktop::open_path(&path)
}

#[tauri::command]
pub fn reveal_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    audit_path(&state, "reveal", &path);
    desktop::reveal_path(&path)
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    desktop::open_url(&url)
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
pub fn move_out(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<usize, String> {
    let n = desktop::move_out(&state.config(), &paths)?;
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
    // 分组名就是磁盘上的目录名，重名会让两个分组写进同一个文件夹
    if cfg
        .organizer
        .groups
        .iter()
        .any(|g| g.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("已经有叫「{name}」的分组了"));
    }
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
    broadcast_config(&app);
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
    if cfg
        .organizer
        .groups
        .iter()
        .any(|g| g.id != id && g.name.eq_ignore_ascii_case(&name))
    {
        return Err(format!("已经有叫「{name}」的分组了"));
    }
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
    broadcast_config(&app);
    Ok(())
}

/// 调整分组顺序。前端以前只在内存里交换数组再整份回传，配合防抖很容易和
/// 后端命令打架；改成命令式之后顺序由后端持有。
#[tauri::command]
pub fn move_group(app: AppHandle, state: State<'_, AppState>, id: String, delta: i32) -> Result<(), String> {
    let mut order_err = None;
    state.with_config(|c| {
        let arr = &mut c.organizer.groups;
        let Some(i) = arr.iter().position(|g| g.id == id) else {
            order_err = Some("分组不存在".to_string());
            return;
        };
        let j = i as i32 + delta;
        if j < 0 || j as usize >= arr.len() {
            order_err = Some("已经到头了".to_string());
            return;
        }
        arr.swap(i, j as usize);
    });
    if let Some(e) = order_err {
        return Err(e);
    }
    refresh(&app);
    broadcast_config(&app);
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
        moved = desktop::move_out(&cfg, &items)?;
        let _ = std::fs::remove_dir(&dir); // 空目录才删得掉，非空说明还有残留，留着更安全
    }
    state.with_config(|c| c.organizer.groups.retain(|g| g.id != id));
    refresh(&app);
    broadcast_config(&app);
    Ok(moved)
}

/// 备忘录正文写进配置（跟着 config.json 落盘）。
/// 以前在 localStorage 里：组件删了条目还留着、WebView2 清缓存就丢。
#[tauri::command]
pub fn set_note(state: State<'_, AppState>, id: String, text: String) {
    if id.trim().is_empty() {
        return;
    }
    // 正文只有前端会写，这里不推进 `rev`：否则用户每打几个字就发一次命令，
    // 每次都会把前端手里的版本号顶掉，后面的整份回传全被判成「过期」。
    let mut c = crate::state::lock(&state.cfg);
    if text.is_empty() {
        c.notes.remove(&id);
    } else {
        c.notes.insert(id, text);
    }
    crate::config::save(&c);
}

#[tauri::command]
pub fn set_hit_regions(state: State<'_, AppState>, rects: Vec<[f64; 4]>, force: bool) {
    crate::window::set_regions(&state, rects, force);
}

/// 托盘菜单打开/关闭时由前端上报菜单矩形（物理像素）。
/// 传 null 表示菜单已收起，后台不再监听全局左键。
#[tauri::command]
pub fn set_menu_rect(state: State<'_, AppState>, rect: Option<[f64; 4]>) {
    eprintln!("[menu] rect={rect:?}");
    let mut h = crate::state::lock(&state.hit);
    h.menu = rect;
    h.menu_armed = false;
    h.last_down = false;
}

/// 抓一张不含本窗口的桌面底图，给前端做毛玻璃背景
#[tauri::command]
pub fn glass_snapshot(app: AppHandle) -> Result<String, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "窗口不存在".to_string())?;
    let hwnd = hwnd_of(&win);

    // 控制中心开着时也要从底图里排除，否则玻璃卡会透出它的影子
    let hub = app
        .get_webview_window("hub")
        .filter(|w| w.is_visible().unwrap_or(false))
        .map(|w| hwnd_of(&w));
    if let Some(h) = hub {
        glass::exclude_hwnd(h);
    }
    let shot = glass::snapshot(hwnd, false);
    if let Some(h) = hub {
        glass::include_hwnd(h);
    }

    match shot {
        Ok(url) => Ok(url),
        Err(e) => {
            eprintln!("[glass] 抓屏失败: {e} (hwnd={hwnd:#x})");
            Err(e)
        }
    }
}

/// 改开机自启。注册表是唯一事实来源，改完把真实值写回配置：
/// 下次启动 `lib.rs` 会按 `cfg.autostart` 同步注册表，配置落后就会把用户的手动
/// 改动覆盖回去（比如用任务管理器禁用过启动项）。
#[tauri::command]
pub fn set_autostart(app: AppHandle, state: State<'_, AppState>, on: bool) -> Result<bool, String> {
    crate::autostart::set(on)?;
    let real = crate::autostart::is_enabled();
    if state.config().autostart != real {
        state.with_config(|c| c.autostart = real);
    }
    broadcast_config(&app);
    Ok(real)
}

/// 读系统的真实自启状态。托盘菜单打开时对一次账，
/// 免得「注册表里其实已经关了，菜单上还打着勾」。
#[tauri::command]
pub fn get_autostart(state: State<'_, AppState>) -> bool {
    let real = crate::autostart::is_enabled();
    if state.config().autostart != real {
        state.with_config(|c| c.autostart = real);
    }
    real
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
    broadcast_config(&app);
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
pub fn set_material(app: AppHandle, state: State<'_, AppState>, material: String) {
    if !MATERIALS.contains(&material.as_str()) {
        eprintln!("[config] 忽略非法材质：{material}");
        return;
    }
    state.with_config(|c| c.material = material);
    broadcast_config(&app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    // 先通知后台线程收工、放掉单实例互斥体，再退出
    crate::begin_shutdown();
    app.exit(0);
}

/* ------------------------------- 更新 ------------------------------- */

use crate::update::{self, Update};

#[tauri::command]
pub async fn check_update() -> Update {
    // 手动检查有 30s 冷却：连点几下不该连着打 GitHub
    update::check_throttled(update::MANUAL_COOLDOWN).await
}

/// 下载安装包。返回本地路径，前端拿到之后再问用户要不要现在装。
/// 下载过程会持续 emit `update:download`，关于页拿它画进度条。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    asset: String,
    version: String,
) -> Result<String, String> {
    update::download(&app, &asset, &version).await
}

/// 拉起安装程序并退出。装完由安装包自己重启（NSIS 的 run-after-install）。
#[tauri::command]
pub fn install_update(app: AppHandle, path: String) -> Result<(), String> {
    update::run_installer(&path)?;
    // 给安装程序一点时间起来，再退出，避免它抢不到文件锁
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(900));
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub fn set_auto_update(app: AppHandle, state: State<'_, AppState>, on: bool) {
    state.with_config(|c| c.auto_update = on);
    broadcast_config(&app);
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
    // 广播：控制中心开着时也要刷新分组计数
    let _ = app.emit("desktop:changed", ());
}

fn pick_color(i: usize) -> String {
    let c = crate::consts::GROUP_COLORS;
    c[i % c.len()].to_string()
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
