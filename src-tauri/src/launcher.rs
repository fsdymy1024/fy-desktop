//! 「系统入口」组件的入口白名单。
//!
//! 前端只能传 id，真正的命令字符串只存在于这里。ShellExecuteW 连协议 URI
//! 和可执行文件都能拉起来，所以必须保留这层白名单——不能让 WebView 传任意
//! 字符串变成「执行任意目标」。入口清单同时通过 boot 下发给两个窗口，
//! 卡片与控制中心用的是同一份数据，不再各写一份。

use serde::Serialize;

/// 卡片最多显示多少个常用位。控制中心超过这个数会拒绝保存。
pub const MAX_FAVORITES: usize = 10;

/// 一个入口真正交给 ShellExecute 的目标。
///
/// `file` 与 `params` 分开传，才能表达 `control.exe ncpa.cpl` 这种
/// 「宿主程序 + 参数」的启动方式；把两段拼成一个字符串会被当成文件路径。
#[derive(Debug, Clone, Copy)]
pub struct LaunchTarget {
    pub file: &'static str,
    pub params: &'static str,
}

/// (id, 名称, 说明, 展示用命令, 图标键)
///
/// 展示命令用于悬停提示，实际启动目标由 `target_for()` 解析：多数是
/// `ms-settings:` 协议 URI 或 Win+R 运行命令，`.cpl` 例外走 control.exe。
/// 最终都由 desktop::shell_execute 处理，失败会写 launch.log。
const ENTRIES: &[(&str, &str, &str, &str, &str)] = &[
    ("settings", "设置", "Windows 设置主页", "ms-settings:", "gear"),
    ("display", "显示", "分辨率、缩放、多显示器", "ms-settings:display", "monitor"),
    ("sound", "声音", "输出 / 输入设备与音量", "ms-settings:sound", "sound"),
    ("bluetooth", "蓝牙", "蓝牙设备", "ms-settings:bluetooth", "wifi"),
    ("wifi", "Wi-Fi", "无线网络列表", "ms-settings:network-wifi", "wifi"),
    ("colors", "颜色", "明暗模式与强调色", "ms-settings:colors", "palette"),
    ("taskbar", "任务栏", "任务栏与开始菜单", "ms-settings:taskbar", "apps"),
    ("apps", "安装的应用", "卸载与修改程序", "ms-settings:appsfeatures", "apps"),
    ("account", "账户", "账户信息与同步", "ms-settings:accounts", "user"),
    ("signin", "登录选项", "密码、PIN、Windows Hello", "ms-settings:signinoptions", "key"),
    ("update", "Windows 更新", "检查更新与更新时间", "ms-settings:windowsupdate", "update"),
    ("privacy", "隐私和安全", "权限与设备访问", "ms-settings:privacy", "shield"),
    ("date", "日期和时间", "时区与时间同步", "ms-settings:dateandtime", "clock"),
    ("notepad", "记事本", "快速记录文本", "notepad", "note"),
    ("calc", "计算器", "标准 / 程序员计算器", "calc", "calc"),
    ("paint", "画图", "简单图片编辑", "mspaint", "palette"),
    ("snip", "截图工具", "截图与录屏", "snippingtool", "scissors"),
    ("charmap", "字符映射表", "插入特殊字符", "charmap", "note"),
    ("osk", "屏幕键盘", "触控 / 应急输入", "osk", "keyboard"),
    ("magnify", "放大镜", "屏幕放大辅助", "magnify", "search"),
    ("mstsc", "远程桌面", "连接远程计算机", "mstsc", "remote"),
    ("explorer", "资源管理器", "打开文件管理器", "explorer", "folder"),
    ("cmd", "命令提示符", "传统命令行", "cmd", "terminal"),
    ("ps", "PowerShell", "脚本与自动化", "powershell", "terminal"),
    ("wt", "Windows 终端", "多标签现代终端", "wt", "terminal"),
    ("taskmgr", "任务管理器", "进程、性能与启动项", "taskmgr", "activity"),
    ("cleanmgr", "磁盘清理", "清理临时文件", "cleanmgr", "trash"),
    ("devmgr", "设备管理器", "驱动与硬件排查", "devmgmt.msc", "chip"),
    ("diskmgr", "磁盘管理", "分区与盘符", "diskmgmt.msc", "chip"),
    ("services", "服务", "启动 / 停止系统服务", "services.msc", "gear"),
    ("event", "事件查看器", "系统与应用日志", "eventvwr.msc", "note"),
    ("compmgmt", "计算机管理", "综合管理控制台", "compmgmt.msc", "apps"),
    ("taskschd", "任务计划程序", "定时任务", "taskschd.msc", "clock"),
    ("msconfig", "系统配置", "启动项与引导", "msconfig", "gear"),
    ("regedit", "注册表编辑器", "高级系统设置", "regedit", "terminal"),
    ("gpedit", "组策略", "专业版 / 企业版可用", "gpedit.msc", "shield"),
    ("net", "网络连接", "网卡与适配器", "ncpa.cpl", "network"),
];

#[derive(Debug, Clone, Serialize)]
pub struct LauncherEntry {
    pub id: String,
    pub name: String,
    pub desc: String,
    pub cmd: String,
    /// 设置 / 工具 / 管理，用于卡片浮层的分类筛选
    pub cat: String,
    pub icon: String,
}

/// 下发给前端的完整清单。命令字符串也一并下发，用于悬停提示——它只是
/// 展示用的文本，真正的启动仍然只走 `open_launcher_entry(id)`。
pub fn entries() -> Vec<LauncherEntry> {
    // ENTRIES 按设置 → 工具 → 管理 连续排列，分类只在这里推导一次。
    ENTRIES
        .iter()
        .enumerate()
        .map(|(i, (id, name, desc, cmd, icon))| LauncherEntry {
            id: (*id).into(),
            name: (*name).into(),
            desc: (*desc).into(),
            cmd: (*cmd).into(),
            cat: if i < 13 {
                "设置"
            } else if i < 25 {
                "工具"
            } else {
                "管理"
            }
            .into(),
            icon: (*icon).into(),
        })
        .collect()
}

pub fn is_valid(id: &str) -> bool {
    ENTRIES.iter().any(|(key, _, _, _, _)| *key == id)
}

pub fn target_for(id: &str) -> Option<LaunchTarget> {
    let cmd = ENTRIES
        .iter()
        .find(|(key, _, _, _, _)| *key == id)
        .map(|(_, _, _, cmd, _)| *cmd)?;

    // `ncpa.cpl` 在部分机器上没有注册 open 关联：直接 ShellExecuteW 会返回
    // 31（SE_ERR_NO_ASSOCIATION），但 Win+R 手动执行正常。交给控制面板宿主
    // 解析，避免依赖 `.cpl` 的文件关联。
    if cmd == "ncpa.cpl" {
        return Some(LaunchTarget {
            file: "control.exe",
            params: "ncpa.cpl",
        });
    }

    Some(LaunchTarget {
        file: cmd,
        params: "",
    })
}

/// 首次安装时的 10 个常用位（中号卡片 5×2）。
pub fn default_favorites() -> Vec<String> {
    [
        "settings", "display", "sound", "wifi", "mstsc", "notepad", "calc", "taskmgr", "snip",
        "cleanmgr",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect()
}

/// 前端回传的常用项按「不信任」处理：未知 id 丢掉、重名丢掉、最多 10 个；
/// 全被丢光时退回默认，避免卡片空着让用户以为组件坏了。
pub fn normalize_favorites(favorites: &mut Vec<String>) {
    let mut seen: Vec<String> = Vec::new();
    favorites.retain(|id| {
        if !is_valid(id) || seen.iter().any(|x| x == id) || seen.len() >= MAX_FAVORITES {
            return false;
        }
        seen.push(id.clone());
        true
    });
    if seen.is_empty() {
        *favorites = default_favorites();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_uses_control_panel_host() {
        let target = target_for("net").expect("网络连接入口应存在");
        assert_eq!(target.file, "control.exe");
        assert_eq!(target.params, "ncpa.cpl");
    }

    #[test]
    fn regular_entry_has_no_params() {
        let target = target_for("taskmgr").expect("任务管理器入口应存在");
        assert_eq!(target.file, "taskmgr");
        assert_eq!(target.params, "");
    }
}
