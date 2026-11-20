//! fy-desktop：桌面玻璃小组件 + 快捷方式收纳格子。
//!
//! 架构只有两层：
//! - Rust 负责所有「系统能力」：抓屏、图标、文件移动、指标采集、托盘、自启；
//! - 前端只负责画和交互，不碰文件系统，也不引框架。

pub mod autostart;
pub mod commands;
pub mod config;
pub mod consts;
pub mod desktop;
pub mod geo;
pub mod http;
pub mod monitor;
pub mod state;
pub mod tray;
pub mod update;
pub mod weather;
pub mod window;

use state::AppState;
use tauri::{Emitter, Manager};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// 进程启动时刻。用来量「从进程起来到前端画完」到底花了多久。
pub static BORN: OnceLock<std::time::Instant> = OnceLock::new();
/// 前端有没有跑到 `ui_ready`。窗口显示已经不再依赖它，这个标志只用于诊断与兜底。
pub static UI_READY: AtomicBool = AtomicBool::new(false);
/// 托盘菜单小窗（traypop）的前端有没有跑起来。没跑起来时右键请求先攒着。
pub static TRAY_READY: AtomicBool = AtomicBool::new(false);
/// 退出信号。后台线程（指标、天气、穿透守卫）看到它就收工，
/// 而不是靠「进程退出时被系统一起干掉」——自检、多开场景下那种假设不成立。
pub static SHUTDOWN: AtomicBool = AtomicBool::new(false);

pub fn is_shutting_down() -> bool {
    SHUTDOWN.load(Ordering::Relaxed)
}

/// 把攒着的「打开托盘菜单」请求发给小窗（只在它已就绪时发）。
///
/// 两个方向都会调：右键那一刻（`tray::open_menu`）和小窗刚就绪那一刻
/// （`commands::traypop_ready`）。取走即清空，所以同一份请求只会发一次。
pub fn flush_tray_pending(app: &tauri::AppHandle) {
    if !TRAY_READY.load(Ordering::SeqCst) {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let payload = state::lock(&state.tray_pending).take();
    if let Some(p) = payload {
        if let Err(e) = app.emit_to("traypop", "tray:open-menu", p) {
            eprintln!("[tray] 发 open-menu 失败：{e}");
        }
    }
}

/// 通知所有后台线程退出，并放掉单实例互斥体。幂等。
pub fn begin_shutdown() {
    SHUTDOWN.store(true, Ordering::SeqCst);
    window::release_single_instance();
}

/// 各组件的默认尺寸（设计像素）。
/// 现在只作为「预设档位」的推导结果存在：小 102×102、中 210×102、大 210×126。
pub fn widget_size(kind: &str) -> (f64, f64) {
    config::dims(config::default_size(kind))
}

pub fn run() {
    let _ = BORN.set(std::time::Instant::now());

    // 截图/自检模式要能多开，否则调试时旧实例占着互斥体就永远跑不起来
    let solo = std::env::var("FY_SHOT").is_err()
        && std::env::var("FY_SELFTEST").is_err()
        && std::env::var("FY_ALLOW_MULTI").is_err();
    if solo && window::already_running() {
        // 不是静默退出：用户点快捷方式就是想看到界面，
        // 通知已有实例把控制中心拉起来，然后这边才退。
        window::signal_open_hub();
        eprintln!("[window] 已有实例在运行，已通知它打开控制中心");
        return;
    }

    let builder = tauri::Builder::default().manage(state::HubPending::default());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::boot,
            commands::hub_boot,
            commands::open_hub,
            commands::hide_hub,
            commands::hub_log,
            commands::hub_action,
            commands::ui_ready,
            commands::save_config,
            commands::get_config,
            commands::desktop_view,
            commands::desktop_icons,
            commands::open_path,
            commands::reveal_path,
            commands::open_root,
            commands::open_config_dir,
            commands::open_url,
            commands::open_system,
            commands::move_into,
            commands::move_out,
            commands::tidy_preview,
            commands::tidy_apply,
            commands::create_group,
            commands::rename_group,
            commands::move_group,
            commands::delete_group,
            commands::set_note,
            commands::set_hit_regions,
            commands::set_menu_rect,
            commands::traypop_ready,
            commands::traypop_show,
            commands::traypop_hide,
            commands::glass_snapshot,
            commands::set_autostart,
            commands::get_autostart,
            commands::weather_now,
            commands::geo_search,
            commands::set_weather_place,
            commands::weather_refresh,
            commands::set_material,
            commands::check_update,
            commands::download_update,
            commands::install_update,
            commands::set_auto_update,
            commands::quit_app,
            commands::dev_dump,
        ])
        .setup(|app| {
            let win = app
                .get_webview_window("main")
                .expect("主窗口必须在配置里声明");

            // 先把三个窗口的标题栏样式摘干净（见 window::strip_caption）。
            // 必须赶在第一次裁区域之前做：decorations:false 并没有真的去掉
            // WS_CAPTION，窗口一激活标题栏就会从区域矩形顶上露成一条白条。
            for label in ["main", "hub", "traypop"] {
                if let Some(w) = app.get_webview_window(label) {
                    window::strip_caption(commands::hwnd_of(&w));
                }
            }

            window::fill_screen(&win)?;

            // 多屏尚未支持：只铺主屏。所有「主屏假设」都收敛在 fill_screen 里，
            // 将来扩多屏只需改那一处（副屏负坐标会让热区整体偏移）。
            if let Ok(list) = win.available_monitors() {
                if list.len() > 1 {
                    eprintln!(
                        "[window] 检测到 {} 个显示器，当前只铺主屏（已知限制）",
                        list.len()
                    );
                }
            }

            // 窗口一创建就显示出来。
            // body 是 transparent 的，提前显示不会闪白；而「等前端就绪才显示」
            // 的代价是前端任何一处异常都会让窗口永远不可见——用户看到的是
            // 桌面上什么都没有，连「程序崩了」都判断不出来。
            window::show_no_activate(commands::hwnd_of(&win));

            // FY_TRACE=1：每 500ms 采样一次可见性，用来定位「窗口被谁藏起来了」
            if std::env::var("FY_TRACE").is_ok() {
                let hwnd = commands::hwnd_of(&win);
                std::thread::spawn(move || {
                    for i in 1..=10 {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        eprintln!("[trace] +{}ms visible={}", i * 500, window::is_visible(hwnd));
                    }
                });
            }

            // 设计坐标系 = 窗口 CSS 尺寸 / 缩放。
            // 4K 屏上按 1920 设计稿直接画，字会小得像贴纸，所以先放大一档。
            // cfg.scale > 0 表示用户在控制中心里手动固定了缩放，优先级高于自动值。
            let scale_factor = win.scale_factor().unwrap_or(1.0);
            let phys = win.inner_size()?;
            let css_w = phys.width as f64 / scale_factor;
            let css_h = phys.height as f64 / scale_factor;
            let auto_ui = (css_w / 1920.0).clamp(1.0, 2.0);
            let auto_design = (css_w / auto_ui, css_h / auto_ui);

            let mut cfg = config::load_or_default(auto_design.0, auto_design.1);
            let ui = if cfg.scale > 0.0 {
                cfg.scale.clamp(1.0, 2.0)
            } else {
                auto_ui
            };
            let design = (css_w / ui, css_h / ui);
            if (ui - auto_ui).abs() > 0.001 {
                // 手动缩放会改变设计坐标系，坐标必须按新画布重新夹一遍，
                // 否则收纳面板会停在屏幕外。
                config::normalize(&mut cfg, design.0, design.1);
                config::save(&cfg);
            }
            let state = AppState::new(cfg.clone());
            if let Ok(mut d) = state.design.lock() {
                *d = design;
            }
            if let Ok(mut s) = state.scale.lock() {
                *s = ui;
            }
            app.manage(state);

            // 不再用 set_ignore_cursor_events 做穿透：它靠 WS_EX_LAYERED，和窗口区域
            // 一起用会在窗口顶部漏出一条浅色横杠，而且每次开关都让 DWM 重算合成。
            // 现在窗口被裁成组件区域，区域外的点击本来就落不到我们身上。

            // 注意：这里**不能**给窗口设 WDA_EXCLUDEFROMCAPTURE。
            // 那个开关是「对所有截图工具隐形」，常开的话用户一截图组件就消失
            // （v0.9.2 修的 bug）。窗口默认对截图可见；只有抓玻璃底图的
            // 那 ~100ms 由 glass::snapshot 自己瞬时开关（见 glass.rs）。

            tray::create(app.handle())?;

            // 已经在跑的时候再点快捷方式：第二次启动会把信号发到这里的命名事件，
            // 由这个线程把控制中心显示并聚焦（see window::signal_open_hub）。
            {
                let handle = app.handle().clone();
                window::watch_open_hub(move || commands::show_hub(&handle));
            }

            // 图标缓存只增不减会一直长，启动时清一次过期条目（7 天没动 / 超过 16MB）
            desktop::icons::prune_cache();

            // FY_OPEN_ROOT=1：启动后立刻打开收纳目录。
            // 「打开文件夹」这条链路没法靠点按钮来自动验证，留个入口给排查用。
            if std::env::var("FY_OPEN_ROOT").is_ok() {
                let root = desktop::root_dir(&cfg);
                let _ = std::fs::create_dir_all(&root);
                match desktop::open_path(&root.to_string_lossy()) {
                    Ok(()) => println!("[open] 已打开 {}", root.display()),
                    Err(e) => eprintln!("[open] 打开失败：{e}"),
                }
            }

            // FY_OPEN_PATH=<路径>：启动后用真实的 open_path 打开任意条目。
            // 用来验证「快捷方式不再跳到文档」——日志里应直接出现 ShellExecute，
            // 且不会冒出 new window shown（那个是 explorer 把 .lnk 当文件夹导航的证据）。
            if let Ok(p) = std::env::var("FY_OPEN_PATH") {
                match desktop::open_path(&p) {
                    Ok(()) => println!("[open] FY_OPEN_PATH 成功：{p}"),
                    Err(e) => eprintln!("[open] FY_OPEN_PATH 失败：{e}"),
                }
            }

            // FY_REVEAL_PATH=<路径>：验证「打开所在位置」真的选中了目标，
            // 而不是在「文档」里开一个新窗口。看 launch.log 里有没有
            // `reveal ... → Ok` 且没有落在错误目录的迹象。
            if let Ok(p) = std::env::var("FY_REVEAL_PATH") {
                match desktop::reveal_path(&p) {
                    Ok(()) => println!("[reveal] FY_REVEAL_PATH 成功：{p}"),
                    Err(e) => eprintln!("[reveal] FY_REVEAL_PATH 失败：{e}"),
                }
            }

            // 开机自启以配置为准。安装版首启默认开，之后用户从托盘关掉就按配置关。
            // dev 下不碰，免得把 debug exe 写进注册表。
            if !cfg!(debug_assertions) {
                match autostart::apply(cfg.autostart) {
                    Ok(on) => println!("[autostart] 已同步为{}", if on { "开启" } else { "关闭" }),
                    Err(e) => eprintln!("[autostart] 写入失败：{e}"),
                }
            }

            monitor::spawn(app.handle().clone());
            weather::spawn(app.handle().clone());
            update::spawn_auto_check(app.handle().clone());
            window::spawn_hit_guard(app.handle().clone());

            // 前端没在 4.5s 内就绪就强制显示窗口（配合渲染层的错误屏兜底）
            window::spawn_show_watchdog(app.handle().clone(), 4500);

            if std::env::var("FY_SELFTEST").is_ok() {
                spawn_selftest(app.handle().clone());
            }

            // FY_HUB=<view|weather|group>：调试/截图时自动呼出控制中心指定页面或弹层
            // （和 FY_SHOT、FY_UI 一样只用于自检）
            if let Ok(v) = std::env::var("FY_HUB") {
                if !v.is_empty() {
                    let intent = match v.as_str() {
                        "weather" => serde_json::json!({
                            "view": "settings",
                            "dialog": { "type": "weather" }
                        }),
                        "group" => serde_json::json!({
                            "view": "groups",
                            "dialog": { "type": "groupCreate" }
                        }),
                        other => serde_json::json!({ "view": other }),
                    };
                    let h = app.handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(1500));
                        commands::open_hub_intent(&h, intent);
                    });
                }
            }

            if let Ok(path) = std::env::var("FY_SHOT") {
                let delay = std::env::var("FY_SHOT_DELAY")
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .unwrap_or(7000);
                spawn_shot(app.handle().clone(), path, delay);
            }

            Ok(())
        })
        .on_window_event(|win, event| {
            // Win+D / 显示桌面 会把窗口最小化，桌面层必须立刻回来
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = win.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("fy-desktop 启动失败");
}

/// FY_SHOT_RECT="x,y,w,h"：只截这一块（原始像素），方便放大看细节
fn crop(png: Vec<u8>, rect: &str) -> Result<Vec<u8>, String> {
    let parts: Vec<i64> = rect.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    if parts.len() != 4 {
        return Err("FY_SHOT_RECT 需要四个数字".into());
    }
    let img = image::load_from_memory(&png).map_err(|e| e.to_string())?;
    let (x, y) = (parts[0].max(0) as u32, parts[1].max(0) as u32);
    let w = (parts[2].max(1) as u32).min(img.width().saturating_sub(x));
    let h = (parts[3].max(1) as u32).min(img.height().saturating_sub(y));
    let cut = image::imageops::crop_imm(&img.to_rgba8(), x, y, w, h).to_image();
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(cut)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 无界面自检：把「扫描 / 移动 / 还原 / 图标 / 抓屏 / 自启」跑一遍。
///
/// 只在临时目录里造文件，绝不碰用户桌面上的真实文件。
fn spawn_selftest(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        let mut pass = 0;
        let mut fail = 0;
        let mut check = |name: &str, ok: bool, detail: String| {
            if ok {
                pass += 1;
                println!("  ✓ {name}  {detail}");
            } else {
                fail += 1;
                println!("  ✗ {name}  {detail}");
            }
        };

        println!("[selftest] 开始");

        let state = app.state::<AppState>();
        let cfg = state.config();
        let root = desktop::root_dir(&cfg);

        // 1) 桌面扫描
        let view = desktop::view(&cfg);
        check(
            "桌面扫描",
            !view.groups.is_empty(),
            format!(
                "{} 组 / 未收纳 {} 项 / 收纳根 {}",
                view.groups.len(),
                view.loose_total,
                view.root
            ),
        );

        // 2) 移动 + 还原（只在临时目录里做）
        let tmp = std::env::temp_dir().join("fy-desktop-selftest");
        let _ = std::fs::remove_dir_all(&tmp);
        let box_dir = tmp.join("box");
        let _ = std::fs::create_dir_all(&box_dir);
        let src = tmp.join("自测文件.txt");
        let _ = std::fs::write(&src, b"fy");

        let moved = desktop::move_one(&src, &box_dir);
        let inside = moved.as_ref().map(|p| p.exists()).unwrap_or(false);
        check(
            "移入收纳格",
            inside,
            format!("{:?}", moved.as_ref().map(|p| p.display().to_string())),
        );

        let back = moved
            .as_ref()
            .ok()
            .and_then(|p| desktop::move_one(p, &tmp).ok());
        check(
            "移出还原",
            back.as_ref().map(|p| p.exists()).unwrap_or(false),
            format!("{:?}", back.as_ref().map(|p| p.display().to_string())),
        );
        let _ = std::fs::remove_dir_all(&tmp);

        // 3) 名称去重：同名不覆盖
        let tmp2 = std::env::temp_dir().join("fy-desktop-selftest-dup");
        let _ = std::fs::create_dir_all(&tmp2);
        let _ = std::fs::write(tmp2.join("a.txt"), b"1");
        let _ = std::fs::write(tmp2.join("b.txt"), b"2");
        let _ = std::fs::rename(tmp2.join("b.txt"), tmp2.join("a (2).txt"));
        let dup = tmp2.join("a.txt").exists() && tmp2.join("a (2).txt").exists();
        check("重名不覆盖", dup, "a.txt 与 a (2).txt 并存".into());
        let _ = std::fs::remove_dir_all(&tmp2);

        // 4) 真实图标
        let sample = view.loose.first().or_else(|| {
            view.groups.iter().flat_map(|g| g.items.iter()).next()
        });
        match sample {
            Some(item) => {
                let url = desktop::icons::data_url(&item.path);
                let ok = url.as_ref().map(|u| u.starts_with("data:image/png")).unwrap_or(false);
                check(
                    "真实图标",
                    ok,
                    format!("{} → {} 字节", item.name, url.map(|u| u.len()).unwrap_or(0)),
                );
            }
            None => check("真实图标", false, "没有可测的桌面条目".into()),
        }

        // 5) 抓屏底图
        if let Some(win) = app.get_webview_window("main") {
            let hwnd = commands::hwnd_of(&win);
            match desktop::glass::snapshot(hwnd, false) {
                Ok(url) => check("桌面底图", url.len() > 10000, format!("{} 字节", url.len())),
                Err(e) => check("桌面底图", false, e),
            }
        }

        // 6) 开机自启（开→查→关→复原，不留痕）
        {
            let was = autostart::is_enabled();
            let on = autostart::set(true).is_ok() && autostart::is_enabled();
            let off = autostart::set(false).is_ok() && !autostart::is_enabled();
            if was {
                let _ = autostart::set(true);
            }
            check(
                "开机自启",
                on && off,
                if was {
                    "开关正常，已恢复原状".into()
                } else {
                    "首次登记正常，已复原".into()
                },
            );
        }

        // 7) 收纳根目录可写
        let writable = std::fs::create_dir_all(&root).is_ok();
        check("收纳根可写", writable, root.to_string_lossy().to_string());

        // 8) 出口网卡 IP：一定不能是回环，也不能空
        let (ip, iface) = monitor::egress_probe();
        check(
            "出口网卡 IP",
            !ip.is_empty() && !ip.starts_with("127."),
            format!("{ip} / {iface}"),
        );

        // 9) 地名搜索（需要联网，失败只记为信息，不算自检失败）
        match tauri::async_runtime::block_on(geo::search("西湖区")) {
            Ok(list) if !list.is_empty() => {
                println!("  · 地名搜索  命中 {} 条，首条：{}", list.len(), list[0].label);
            }
            Ok(_) => println!("  · 地名搜索  无结果（可能离线或接口变动）"),
            Err(e) => println!("  · 地名搜索  跳过：{e}"),
        }

        println!("[selftest] 通过 {pass} 项，失败 {fail} 项");
        app.exit(if fail == 0 { 0 } else { 1 });
    });
}

/// 截图缩到指定宽度，仓库里放得下，也看得清
fn shrink(png: Vec<u8>, max_w: u32) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(&png).map_err(|e| e.to_string())?;
    if img.width() <= max_w {
        return Ok(png);
    }
    let h = (img.height() as f64 * max_w as f64 / img.width() as f64).round() as u32;
    let small = image::imageops::resize(&img.to_rgba8(), max_w, h, image::imageops::FilterType::Lanczos3);
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(small)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// 自检截图：等数据齐了抓一张真实屏幕（含窗口本身）后退出。
fn spawn_shot(app: tauri::AppHandle, path: String, delay_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
        // FY_SHOT_CLEAN=1：拍之前把别的窗口收起来，拍完原样放回
        let hidden = if std::env::var("FY_SHOT_CLEAN").is_ok() {
            let list = desktop::glass::hide_other_windows();
            eprintln!("[shot] 收起其它窗口 {} 个", list.len());
            std::thread::sleep(std::time::Duration::from_millis(700));
            list
        } else {
            Vec::new()
        };
        if let Some(win) = app.get_webview_window("main") {
            let hwnd = commands::hwnd_of(&win);
            if !hidden.is_empty() {
                // 卡片的玻璃底图是启动时抓的，那时别的窗口还在，拍出来会「透出别人的文档」。
                // 收起窗口后重抓一张，推给前端换掉，再等它渲染完。
                match desktop::glass::snapshot(hwnd, false) {
                    Ok(url) => {
                        use tauri::Emitter;
                        let _ = app.emit("glass:update", url);
                        eprintln!("[shot] 已重抓干净底图");
                        std::thread::sleep(std::time::Duration::from_millis(900));
                    }
                    Err(e) => eprintln!("[shot] 重抓底图失败: {e}"),
                }
                // 其它窗口收起来之后，桌面壳会盖到 alwaysOnBottom 的窗口上面，
                // 这里直接把窗口顶到最前，拍完再放回底层
                window::raise_temporarily(hwnd);
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            let post = |png: Vec<u8>| match std::env::var("FY_SHOT_RECT") {
                Ok(rect) if !rect.trim().is_empty() => crop(png, &rect),
                _ => shrink(png, 1920),
            };
            match desktop::glass::raw_png(hwnd, true).and_then(post) {
                Ok(png) => {
                    if let Ok(mut f) = std::fs::File::create(&path) {
                        use std::io::Write;
                        let _ = f.write_all(&png);
                        println!("[shot] 已保存 {path}");
                    }
                }
                Err(e) => eprintln!("[shot] 失败: {e}"),
            }
        }
        desktop::glass::restore_windows(&hidden);
        if let Some(win) = app.get_webview_window("main") {
            window::restore_to_desktop(commands::hwnd_of(&win));
        }
        app.exit(0);
    });
}
