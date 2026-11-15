//! 托盘。桌面常驻应用没有主窗口可关，托盘就是唯一的入口。

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    // 「编辑布局」不放在托盘里：它和「添加组件」挨在一起时看不出区别，
    // 而且进编辑态之后还是得回到卡片上操作。现在一切都在卡片右键菜单里。
    let add = MenuItem::with_id(app, "add", "添加组件…", true, None::<&str>)?;
    let glass = MenuItem::with_id(app, "glass", "刷新桌面底图", true, None::<&str>)?;
    let place = MenuItem::with_id(app, "place", "天气地区…", true, None::<&str>)?;
    let auto = CheckMenuItem::with_id(app, "autostart", "开机自启", true, false, None::<&str>)?;
    let secs = CheckMenuItem::with_id(app, "seconds", "时钟显示秒", true, true, None::<&str>)?;
    let root = MenuItem::with_id(app, "root", "打开收纳文件夹", true, None::<&str>)?;
    let conf = MenuItem::with_id(app, "conf", "设置文件…", true, None::<&str>)?;
    // 「关于」放最后一段：版本号和更新是低频操作，不占上面那一段常用区
    let about = MenuItem::with_id(app, "about", "关于 fy-desktop…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 fy-desktop", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &add,
            &glass,
            &place,
            &auto,
            &secs,
            &PredefinedMenuItem::separator(app)?,
            &root,
            &conf,
            &PredefinedMenuItem::separator(app)?,
            &about,
            &quit,
        ],
    )?;

    let auto_item = auto.clone();
    let secs_item = secs.clone();

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap())
        .tooltip("fy-desktop")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "add" => {
                let _ = app.emit("tray:action", "gallery");
            }
            "glass" => {
                let _ = app.emit("tray:action", "glass");
            }
            "place" => {
                let _ = app.emit("tray:action", "place");
            }
            "autostart" => {
                let now = crate::autostart::is_enabled();
                let after = if crate::autostart::set(!now).is_ok() {
                    crate::autostart::is_enabled()
                } else {
                    now
                };
                let _ = auto_item.set_checked(after);
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    state.with_config(|c| c.autostart = after);
                }
                let _ = app.emit("autostart:changed", after);
            }
            "seconds" => {
                let mut after = true;
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    after = state.with_config(|c| {
                        c.show_seconds = !c.show_seconds;
                        c.show_seconds
                    });
                }
                let _ = secs_item.set_checked(after);
                let _ = app.emit("clock:seconds", after);
            }
            "root" => {
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    let root = crate::desktop::root_dir(&state.config());
                    let _ = std::fs::create_dir_all(&root);
                    if let Err(e) = crate::desktop::open_path(&root.to_string_lossy()) {
                        eprintln!("[tray] 打开收纳文件夹失败：{e}");
                    }
                }
            }
            "conf" => {
                if let Err(e) = crate::desktop::open_path(&crate::config::config_path().to_string_lossy())
                {
                    eprintln!("[tray] 打开配置目录失败：{e}");
                }
            }
            "about" => {
                let _ = app.emit("tray:action", "about");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    // 托盘勾选状态以系统注册表为准，别只看配置
    let _ = auto.set_checked(crate::autostart::is_enabled());
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        let _ = secs.set_checked(state.config().show_seconds);
    }

    Ok(())
}
