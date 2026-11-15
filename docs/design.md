# fy-desktop 设计文档

> 版本：v0.2.0 ｜ 最后更新：2026-11-15
>
> 对应实现：Rust 1.77+ / Tauri v2 / 原生 ESM（无前端框架）
>
> 真实渲染效果见 `docs/app-preview.png`；视觉基准稿（静态、无交互）见 `design/ui-demo.html`。

## 1. 设计语言

一句话：**暖橙强调 + 冷灰正文 + 真壁纸玻璃**。

参考 [atrium-desktop](https://github.com/wynter-yaxley/atrium-desktop) 的液态玻璃方向，但把「浮夸的折射」换成「安静的雾面」——
桌面小组件是背景角色，不该抢走窗口的注意力。

### 1.1 三条硬规则

| 规则 | 说明 |
| --- | --- |
| 一个组件只说一件事 | 天气不说系统、系统不说网络。禁止在卡片里塞次要信息 |
| 玻璃必须透出真实壁纸 | 做不到真模糊就别用半透明白底糊弄——那叫塑料，不叫玻璃 |
| 强调色只有一个 | 橙 `#e2622c` 只用于「当前值 / 今日 / 主操作」，其余全走中性灰。一屏两个橙色重点就失效了 |

## 2. 设计令牌

全部集中在 `src/renderer/css/app.css` 的 `:root`，换肤只改这里。

| 令牌 | 浅色（壁纸偏亮） | 深色（`body[data-tone="dark"]`） | 用途 |
| --- | --- | --- | --- |
| `--ink` | `rgba(26,22,19,.93)` | `rgba(255,250,244,.95)` | 主文字、数值 |
| `--ink2` | `rgba(26,22,19,.60)` | `rgba(255,250,244,.68)` | 标签、次要信息 |
| `--ink3` | `rgba(26,22,19,.40)` | `rgba(255,250,244,.45)` | 辅助、当月外日期 |
| `--fill` | `rgba(255,253,250,.86)` | `rgba(24,19,15,.78)` | 玻璃底色 |
| `--stroke` | `rgba(255,255,255,.52)` | `rgba(255,255,255,.14)` | 1px 内描边 |
| `--accent` | `#e2622c` | 同 | 强调色，唯一 |
| `--radius` | `17px` | 同 | 卡片圆角 |
| `--shadow` | 双层投影（44px + 8px） | 同，透明度加深 | 悬浮感 |

**尺寸基准**：设计坐标系固定 1920×1080，运行时整体 `transform: scale(ui)`，
`ui = (屏宽 CSS 像素 / 1920).clamp(1.0, 2.0)`。这样字号只需要按设计像素写一次。

**间距**：只有 4 的倍数。卡片内 padding 12/13，卡片间距 10，格位间距 7（格子需要更紧，属例外）。

> 踩过的坑：`ui` 上限从 1.75 提到 2.0 后，卡片在 4K 上终于不像贴纸了。
> 但同时暴露另一个问题——CSS 变量改变量不会触发子元素重算，切深色时子元素文字仍是黑色（见第 9 节）。

## 3. 玻璃是怎么做出来的

这是本项目最麻烦的一块，前后试过四种做法。

### 3.1 走过的弯路

| 方案 | 结果 |
| --- | --- |
| 半透明白底 + SVG 噪点 | v0.1 的做法。像磨砂塑料，完全看不出壁纸，一眼就发现「这不是毛玻璃」 |
| `DwmEnableBlurBehindWindow` | Win10 起只对窗口背景做高斯，透出的是**窗口后面**的内容；Win11 上 `ACCENT_ENABLE_BLURBEHIND` 已废弃，效果要么全黑要么全透明 |
| `SetWindowCompositionAttribute` 的 Acrylic | 桌面层窗口被系统特殊处理，实测不可靠，部分显卡驱动上直接黑屏 |
| **抓屏 + 离屏模糊（采用）** | 自己抓一张纯桌面，自己模糊，自己按坐标铺到卡片下。可控、跨版本稳定 |

### 3.2 现在的流程

```
① SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)   // 让自己对截图隐形
② BitBlt(screen, CAPTUREBLT)                              // 抓整屏，此时画面里没有本程序
③ image::resize(1/3)  →  imageops::blur(σ=13)             // 降采样再模糊，省一半以上时间
④ PNG 编码 → base64 data URL                              // 约 600–900 KB
⑤ 前端：卡片 background-image = 该 URL
        background-size     = 设计尺寸
        background-position = -卡片在设计坐标系里的坐标
```

关键点：

- **必须 `WDA_EXCLUDEFROMCAPTURE`**。否则截出来的图里有自己的白卡片，模糊后卡片下面是一层糊影，越看越脏。
- **降采样到 1/3 再模糊**。4K 全屏直接高斯 σ=13 要 200ms 以上；缩到 1280×720 再模糊只要 30ms 左右，
  肉眼看不出差别（本来就要糊）。
- **坐标对齐靠 `#stage` 的 scale**。卡片的 `left/top` 是设计像素，`background-position` 也用设计像素，
  两者在同一个被 `transform: scale` 的坐标系里，所以天然对齐，不用算 DPR。
- **明暗判定只做一次，按整屏**。早期逐卡片采样自己那块区域的平均亮度，结果同一块收纳面板里
  上半截浅玻璃下半截深玻璃，像拼贴。改成整屏平均亮度后统一了。
  采样方式：底图缩到 180 宽画进 canvas，`0.2126R + 0.7152G + 0.0722B` 求平均，阈值 0.52。

### 3.3 抓屏的副作用与处理

抓屏时屏幕上若还有其他窗口（浏览器、编辑器），模糊底图会带上它们的颜色，卡片就「透出别人的窗口」。
`FY_SHOT_CLEAN=1` 时先 `EnumWindows` 最小化所有可见顶层窗口，抓完再还原——只用于出宣传图。
日常不这么做：代价太大，而且用户桌面上本来就该有自己的窗口。

## 4. 布局系统

### 4.1 坐标系

三层：

| 层 | 单位 | 用途 |
| --- | --- | --- |
| 物理像素 | px | 抓屏、`GetCursorPos`、`SetWindowPos` |
| CSS 像素 | px | 窗口逻辑尺寸 = 物理 / DPR |
| 设计像素 | dp | = CSS / ui，所有组件坐标与尺寸都用它 |

**热区必须用物理像素上报**，因为 Rust 侧查询的是 `GetCursorPos` 的物理坐标。

### 4.2 默认布局

```
左列（x = 180）             右列
weather    y = 36          organizer  x = 屏宽 - 面板宽 - 36
clock      y = 178                    y = 36
calendar   y = 390                    h = 0（auto，随内容）
system     y = 552
network    y = 714
```

**左列为什么不贴边**：窗口在桌面层之下，桌面图标永远画在卡片上面。
图标第一列（含文字标签）约 130 设计像素宽，贴边就等于让图标压住整列卡片，
所以默认从 180 起排。图标特别多的桌面仍会重叠——这是 `alwaysOnBottom` 的固有代价，
把图标收进格子或手动拖走即可。

收纳面板高度写 `0` 表示「随内容」，CSS 用 `max-height: calc(100% - 36px)` 兜底，
避免固定整屏高留一大片空白。

### 4.3 组件尺寸

| 组件 | 默认 | 最小 | 内容重排方式 |
| --- | --- | --- | --- |
| 天气 | 296×128 | 248×112 | 逐时预报按可用宽度减少列数 |
| 模拟时钟 | 296×200 | 200×200 | 表盘按短边等比缩 |
| 数字时钟 | 208×90 | 160×80 | 字号随宽度 clamp |
| 日历 | 296×150 | 248×132 | 网格行高压缩，字号不变 |
| 系统监视 | 296×150 | 250×136 | 走势图高度弹性 |
| 网络 | 296×138 | 250×124 | 走势图高度弹性 |
| 备忘录 | 296×116 | 240×100 | 行数不变 |

缩放只在右下角把手做，比例自由（不锁等比），内容靠 flex 自适应。

### 4.4 分组的格子系统

收纳面板内部是 8 列网格，单元格 = 图标 40dp + 名称 2 行。
条目不足一行时补空单元格（`padCells`），否则最后一行的列宽会被撑开，看起来像错位。

## 5. 窗口与交互模型

### 5.1 窗口属性

| 属性 | 值 | 原因 |
| --- | --- | --- |
| `transparent` | true | 要露出壁纸 |
| `decorations` | false | 无边框 |
| `skipTaskbar` | true | 桌面常驻，不占任务栏 |
| `alwaysOnBottom` | true | 在桌面层之下，不挡图标与右键菜单 |
| `visible` | false | 等前端 `ui_ready` 再显示，避免白闪 |
| `shadow` | false | 全屏窗口加阴影会拖慢合成 |

启动链路：`setup` → 铺满主屏 → `exclude_from_capture` → 建托盘 → 起采样 → 保持隐藏；
前端 `boot()` 拿配置/布局/玻璃 → 渲染 → `ui_ready` → 后端 `show()` + `SW_SHOWNOACTIVATE`。

> 为什么必须等前端：开发中曾因 CSP 拦掉 `__TAURI__` 注入，窗口一直隐藏，界面全空却什么都看不到，排查很久。
> 现在 `bridge.js` 会把「`__TAURI__` 不存在」「事件监听被拒」直接画在页面上。

### 5.2 鼠标穿透

Tauri 的 `set_ignore_cursor_events(true)` 没有 Electron 的 `forward: true`——一旦穿透，
**自己也就收不到鼠标移动**了，无法靠前端判断「光标进来了」。

做法：前端上报热区，后端轮询。

```
前端：卡片移动/缩放/增删/折叠后 → set_hit_regions([{x,y,w,h}...], force)
后端：spawn_hit_guard 线程，每 30ms GetCursorPos
      命中任一矩形   → set_ignore_cursor_events(false)
      离开全部矩形   → set_ignore_cursor_events(true)
```

代价是 30ms 一次 `GetCursorPos`，开销可忽略（实测常驻 CPU < 1%）。
拖拽期间前端传 `force = true` 强制接管，避免拖到卡片外就断。

### 5.3 回到桌面层

按 Win+D（显示桌面）会把窗口最小化。`on_window_event` 只处理「点关闭 → 隐藏」，
显示桌面则靠守卫线程顺手查 `is_minimized`，是则 `restore_to_desktop()`（`SetWindowPos(HWND_BOTTOM)`）。

截图自检时反过来：先 `raise_temporarily()`（`HWND_TOPMOST`）把窗口顶上来，拍完 `restore_to_desktop()` 回底层。

## 6. 架构

```
┌──────────────────── 前端（WebView2，无框架 ESM） ────────────────────┐
│ main.js      启动编排、坐标变换、拖动/缩放、编辑态、提示             │
│ widgets.js   七个组件的 DOM 模板与数据绑定（mount 返回更新器）       │
│ organizer.js 收纳面板渲染、网格拖拽、右键菜单                        │
│ gallery.js   组件库面板                                              │
│ bridge.js    invoke / listen 薄封装 + 失败诊断                       │
└──────────────────────────────┬───────────────────────────────────────┘
                    invoke / emit（见 6.1）
┌──────────────────────────────┴───────────────────────────────────────┐
│ commands.rs   IPC 入口，只做参数校验与转发                           │
│ state.rs      AppState { cfg, scale, hit, design }                   │
│ window.rs     铺满、穿透守卫、置顶/回底                              │
│ monitor.rs    系统与网络采样（1s 心跳，emit("metrics")）             │
│ weather.rs    天气双源（15min，emit("weather")）                     │
│ autostart.rs  开机自启（HKCU）                                       │
│ tray.rs       托盘菜单（emit("tray:action")）                        │
│ desktop/      扫描、移动、图标、抓屏                                 │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.1 IPC 一览

| 命令 | 方向 | 说明 |
| --- | --- | --- |
| `boot` | → | 一次性返回配置、设计尺寸、缩放、版本、收纳根、自启状态 |
| `ui_ready` | → | 前端渲染完成，后端显示窗口 |
| `save_config` | → | 整份配置落盘（前端 320ms 防抖） |
| `desktop_view` | → | 扫描桌面，返回分组与未收纳条目 |
| `desktop_icons` | → | 批量取图标 data URL（每次 8 个，避免卡顿） |
| `move_into` / `move_out` | → | 移入分组 / 移回桌面 |
| `tidy_preview` / `tidy_apply` | → | 一键整理：先预览再执行 |
| `create_group` / `rename_group` / `delete_group` | → | 分组增删改 |
| `open_path` / `reveal_path` / `open_root` / `open_config_dir` | → | 打开、定位、开目录 |
| `set_hit_regions` | → | 上报热区（物理像素） |
| `glass_snapshot` | → | 抓屏并返回 base64 模糊底图 |
| `set_autostart` | → | 开关开机自启 |
| `weather_now` / `weather_refresh` | → | 取缓存 / 主动刷新 |
| `set_material` / `quit_app` / `dev_dump` | → | 材质、退出、诊断 |
| `metrics` / `weather` / `tray:action` / `autostart:changed` / `tauri://drag-drop` | ← | 后端推送 |

### 6.2 配置

`%APPDATA%\com.fy.desktop\config.json`

```jsonc
{
  "version": 2,
  "scale": 0,                    // 0 = 自动（按屏宽）
  "material": "glass",           // glass | dark | solid
  "glass": true,                 // 是否抓屏铺玻璃
  "show_labels": true,
  "autostart": true,
  "weather": { "lat": 31.23, "lon": 121.47, "city": "上海" },
  "widgets": [
    { "id": "weather-1", "kind": "weather", "x": 36, "y": 36, "w": 296, "h": 128 }
  ],
  "organizer": {
    "x": 768, "y": 36, "w": 520, "h": 0,
    "folded": ["archive"],
    "root": "",                  // 空 = <桌面>\fy-desktop
    "groups": [{ "id": "dev", "name": "开发工具", "color": "#3d8bf0" }]
  }
}
```

`version` 用于迁移。v0.2 **删掉了** v0.1 布局迁移：尺寸规范全变了，
把旧坐标按比例搬过来只会让卡片互相压叠，不如按新规范重排一遍。

## 7. 关键取舍

| 决策 | 选择 | 放弃的方案 | 理由 |
| --- | --- | --- | --- |
| 技术栈 | Rust + Tauri v2 | Electron | 内存从 ~180 MB 降到 ~60 MB，安装包从 80 MB 降到 1.9 MB；COM / GDI / Win32 直接可用，不用写 native addon |
| 玻璃 | 抓屏离屏模糊 | DWM / Acrylic API | 系统 API 在 Win11 桌面层不可靠，且无法控制模糊半径 |
| 收纳 | 真实文件夹 | 虚拟分组（v0.1） | 用户要的是「文件真的进去了」；虚拟分组只是界面幻觉，换台机器就没了 |
| 图标 | Shell COM 取图 | 首字色块（v0.1） | 真实图标是「收纳格看起来像真的」的关键一环 |
| 鼠标穿透 | 后端轮询热区 | 全窗口不穿透 | Tauri 没有 `forward`，前端无法感知穿透状态下的鼠标位置 |
| 自启 | 直连 `auto-launch` | `tauri-plugin-autostart` | 插件把模式写死 `Dynamic`，管理员身份下会误写 HKLM |
| 前端框架 | 无（原生 ESM） | React / Vue | 组件只有 7 个、状态简单；引框架首屏多 100ms 且增加维护面 |

## 8. 安全与权限

- `capabilities/default.json` 显式列出所需能力：`core:event:default`、窗口显示/隐藏/穿透/尺寸/位置。
  没列的 IPC 一律拒绝——这是 Tauri v2 相对 Electron 更硬的一层。
- `security.csp = null`：`withGlobalTauri` 注入的 `__TAURI__` 需要放行内联脚本。
  代价是失去 CSP 保护，收益是零配置可用；页面本身不加载任何外部资源，风险可控。
- 前端不碰文件系统：所有路径操作都在 Rust 侧，且都经过 `sanitize()` 与重名检测。
- 打开文件用 `cmd /c start` + `CREATE_NO_WINDOW`，路径整体作为参数传递，不拼字符串。

## 9. 踩过的坑

按发现顺序记录，都是真实卡住过的问题。

1. **CSP 拦掉 `__TAURI__`** → 界面全空白。现在失败会画到页面上，且窗口不再依赖前端才显示（见第 12 条）。
2. **Tauri v2 权限缺失** → 8 条 `event.listen not allowed`，指标/天气全不更新，界面看着「正常」但数据是 `--`。
3. **CSS 变量继承的是计算值** → 给 `.surface.on-dark` 改 `--ink` 后子元素仍是黑字，必须显式 `color: var(--ink)`。
4. **`EnumWindows` 收起 0 个窗口** → `GetWindow(hwnd, GW_OWNER)` 无 owner 时返回 `Err`，原判断写反了；
   改成 `map(|h| !h.0.is_null()).unwrap_or(false)` 后一次收起 7 个。
5. **最小化其它窗口后自己也消失** → `alwaysOnBottom` 窗口被桌面壳盖住；抓图前必须临时置顶，拍完回底。
6. **`sysinfo` 0.40 构造器返回 `Result`** → 十几个方法调用全部编译报错，要 `match` 出来再 `refresh_*`。
7. **`static WIFI: Mutex<(Link, Instant)>`** → `Instant::now()` 不是 const，只能 `Mutex<Option<..>>`。
8. **把 JS 正则写进 Rust** → `/(code|git)/.is_match()` 不是 Rust 语法；改 `&[&str]` + `contains`。
9. **布局迁移把旧尺寸搬过来** → 卡片互相压叠；直接删掉迁移，让默认布局重建。
10. **`tauri.conf.json` 的 NSIS 字段有白名单** → `shortcutName` / `createDesktopShortcut` 不在 v2 schema 里，
    写了直接报 `not valid under any of the schemas`；默认行为就是创建桌面快捷方式。
11. **NSIS 工具链走 GitHub** → 打包时会从 `github.com/tauri-apps/binary-releases` 下载 NSIS 与
    `nsis_tauri_utils.dll`。网络受限时先确认 `%LOCALAPPDATA%\tauri\NSIS\makensis.exe` 存在，
    或从 `downloads.sourceforge.net` 取官方 NSIS 手动放进去。
12. **`visible: false` 的窗口会被 Tauri 再藏一次（最坑的一个）** → 原设计是「等前端渲染完再显示，
    避免白底闪一下」。实际 Tauri 在 WebView 初始化完成后会再应用一次初始窗口状态：`ui_ready` 刚
    `ShowWindow` 出来，随即又被藏回去。时序取决于 WebView2 冷启动快慢，所以表现是**偶发**——
    重启后桌面上什么都没有，但进程活着、内存正常、日志一片干净。
    修法：`visible: true` + `setup` 里 `SW_SHOWNOACTIVATE`。`body` 本来就是 `transparent`，
    提前显示不会闪白，「优化」本身就是伪需求。
    推论：**窗口可见性不该依赖前端**。现在窗口与渲染层解耦，另加就绪看门狗把「前端多久没就绪」
    打进日志，避免同类问题再次变成「什么都没发生」。
13. **`WDA_EXCLUDEFROMCAPTURE` 恢复后要等一帧** → 截图前 `SetWindowDisplayAffinity(WDA_NONE)`
    后立刻 `BitBlt`，DWM 还没合成新帧，抓到的是窗口仍然隐形的上一帧，截图上就是「一个组件都没有」。
    等 180ms 再抓。这个现象极容易被误判成「渲染挂了」。
14. **多开写同一份 `config.json`** → 连点两次图标起两个实例，两组窗口叠在一起，谁写谁覆盖。
    命名互斥体 `Local\fy-desktop-single-instance` 保证单实例；`FY_SHOT` / `FY_SELFTEST` 下放行。
15. **`alwaysOnBottom` 的窗口会被 Chromium 当成后台视图卸载** → 系统始终认为桌面层窗口被遮住，
    Chromium 的遮挡计算把它归类为隐藏视图，触发后台节流，几分钟后卸载视图释放资源，恢复时重载整页。
    肉眼是「组件闪一下再回来」，代价是指标历史、玻璃底图全部重来。修法是 `additionalBrowserArgs`：
    `--disable-features=...,CalculateNativeWinOcclusion` + 三个 `--disable-*-backgrounding/throttling`。
    注意 Tauri 默认会传 `msWebOOUI,msPdfOOUI,msSmartScreenProtection`，自己设置这个字段时要一并写回。
    另外 `backgroundThrottling` 配置项在 Windows **不生效**（官方标注 Unsupported），别指望它。
    定位手段：`[ui] ready` 打 `nav=导航类型` 与 `boots=会话内启动次数`，
    `nav=reload` + `boots>1` 就是重载，`nav=navigate` + `boots=1` 才是真正的首帧。
16. **穿透窗口里的弹层「输入不进去」** → 窗口按热区穿透，弹层在屏幕中央、不在任何热区里，
    鼠标一点就穿到桌面，焦点跟着跑掉；输入框还在，但键盘再也不认。
    修法：弹层打开期间把 `force` 置真（整窗接管鼠标），关闭时还原；点遮罩不关闭，
    而是 `preventDefault` + 把焦点还给输入框。这条对所有模态都适用，不是单个弹层的问题。
17. **网卡枚举顺序 ≠ 路由顺序** → 「取第一个非回环 IPv4」在有 VMware / Hyper-V / WSL 的机器上
    会命中虚拟网卡（本机就排在 `以太网` 前面的两块 `vEthernet`）。正确做法是让内核回答：
    对 `223.5.5.5:80` 做一次 UDP `connect`（不发包），`local_addr()` 即出口地址，
    再拿它去 `Networks` 里反查网卡名。兜底扫描时按名字跳过 `vEthernet/vmware/tun/tap` 等。
18. **Open-Meteo 的地理编码不认中文** → `name=西湖区` 返回空，只有拼音/英文能命中，
    做不到区县级。改用 photon（OSM）：`q=西湖区` 直接返回 `state/city/name` 三段，
    正好拼成「浙江省 · 杭州市 · 西湖区」；注意它不支持 `lang=zh` 参数，传了会报错。
19. **`mount()` 早于 `place()`** → 组件在挂载时读 `clientHeight` 拿到 0，如果按「量一次尺寸画一次」
    的写法（模拟时钟表盘就是这样），尺寸会永远停在最小档，只有用户手动拉一下才恢复。
    改成每次 `tick` 对一次尺寸、首帧再补一次 `requestAnimationFrame`。

## 10. 后续路线

| 版本 | 内容 |
| --- | --- |
| v0.5.0 | 格子内拖拽排序、多屏支持、图标白底抠除（`SIIGBF_BIGGERSIZEOK` + 边缘检测） |
| v0.5.0 | 备忘录可编辑、模糊强度可调 |
| v1.0.0 | 自动更新（`tauri-plugin-updater`）、代码签名 |
