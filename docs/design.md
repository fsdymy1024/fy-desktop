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

尺寸**不再自由拖拉**。所有组件共用一套格子，边长取自一个基准值 `a = 120`：

| 档位 | 尺寸 | 用途 |
| --- | --- | --- |
| 小 | a × a = 120×120 | 只留最要紧的一两项 |
| 中 | 2a × a = 240×120 | 默认档，功能完整 |
| 大 | 2a × 1.5a = 240×180 | 只有备忘录用 |

为什么不再自由缩放：v0.5 里每张卡都是手拉出来的「大概这么大」，204×104、216×128、
250×136 混在一起，看着就是没对齐。改成三档之后，两张「中」并排一定严丝合缝，
竖着叠也一定等距——对齐这件事从「靠眼」变成「靠数」。

v0.7 起「大」只留给备忘录：其余组件多出来的 60px 高度只够把同样的内容排得松一点，
在桌面上却是实打实多占一块地方。

| 组件 | 小 | 中 | 大 | 小号砍掉什么 |
| --- | --- | --- | --- | --- |
| 天气 | ✓ | ✓（默认） | ✗ | 逐时预报整行收起，只留今天的气温 / 天气 / 高低温 |
| 模拟时钟 | ✓ | ✓（默认） | ✗ | 表盘收起，只留数字时间 + 日期 |
| 数字时钟 | ✓（默认） | ✓ | ✗ | — |
| 网络 | ✓ | ✓（默认） | ✗ | 走势图、延迟 / IP 行、在线点都收起 |
| 系统监视 | ✓ | ✓（默认） | ✗ | 进度条、走势图、运行时长都收起，只留三个百分比 |
| 日历 | ✗ | ✓（唯一档） | ✗ | 整月网格塞不进 120×120，干脆不给小号 |
| 备忘录 | ✗ | ✓（默认） | ✓ | 同上 |

档位与内容的对应写在 CSS 里（`.card[data-kind="x"][data-size="s"] …`），
只有 `data-size` 一个属性，切换档位不用重建组件——但表盘、走势图这类画在 canvas/svg
里的东西得靠 `onSizeChange()` 重画一次。

小号不是「把中号缩小」，是删掉次要信息。120 宽扣掉 24px 内边距只剩 96：
「23:29」+ 秒在这个宽度下会顶出卡片（实测 34px 字号超 11px），所以小号时钟把字号
降到 26px。这类「差几个像素」的问题只能靠 `FY_SHOT_RECT` 裁到单卡看。

档位的允许集合在后端 `config::sizes_for()` 与前端 `REGISTRY[kind].sizes` 各写一份，
两边必须一致：后端用它决定旧配置归位与默认值，前端用它渲染右键菜单与组件库分组。

归档时把旧配置里已取消的档位按**档位距离**归位（`l → m`）——不能按宽高比算，
240×180 的 1.33 反而更接近 1:1 的「小」。归位后再往下让位消除重叠，只挪 y 不挪 x，
免得把用户排好的列拆开。

### 4.3.1 右键菜单是组件的唯一入口

v0.6 之前，换尺寸和移除要靠编辑态里卡片右上角那颗工具条。小号卡只有 120 宽，
工具条本身就会压住标题，而且三个 18px 的小按钮在桌面上很难点准。

v0.7 把「这张卡的所有设置」收进右键菜单：

| 菜单项 | 作用 |
| --- | --- |
| `组件名 · 档位 宽×高` | 只读标题，告诉你现在是什么档 |
| `✓/　小/中/大　宽×高` | 只列该组件支持的档位，当前档打勾并禁用 |
| 调整布局… | 进编辑态：卡片可拖动（吸 8px 网格 + 参考线），Esc 退出 |
| 添加组件… | 打开组件库 |
| 移除组件 | 至少保留一个，只剩一张时禁用 |

所以编辑态现在只剩「拖动」一件事：没有工具条、没有拉角把手（收纳面板右下角
那个把手还在，面板尺寸仍是自由的）。虚线框就是「现在可以拖」的全部提示。

组件库按档位分三段（小 / 中 / 大），每段列出支持该档的组件，预览迷你卡按该档
真实比例画（a×a / 2a×a / 2a×1.5a）。点「小」组里的天气，加出来就是小号——
v0.6 只能按默认档加，想用小号得先加再改。

组件库、右键菜单、编辑条、弹层的配色都挂在同一个 `--pop-*` / `--gal-*` 变量组上，
由 `body[data-material]` 赋值。深色材质下不会弹出一块白板：
亮色浮层贴在深色卡片旁边，比没有浮层还刺眼。

### 4.3.2 图标

`assets/icon.svg` 是唯一的源：深色圆角方（`#3f3832 → #14110f` 对角渐变）+ 顶部
一层暖白高光 + 白色粗体 `fy`，与「石墨」材质同族。`npm run icon` 调
`tauri icon` 一次生成 ico / png / icns；NSIS 的 `installerIcon` 显式指向
`icons/icon.ico`，安装程序与开始菜单里都是同一枚图标。

SVG 里的 `fy` 是文字而不是路径，依赖渲染端的字体。`tauri icon` 用 resvg，
能读到系统的 Segoe UI；但字形墨迹并不在画布正中（`y` 有下降部、`f` 没有），
所以外面套了一层 `translate/scale/translate` 把墨迹框挪到正中、并缩到画布的 78%，
否则字母会顶到圆角边缘。

快捷方式**不**直接取 exe 的内嵌图标：资源管理器的图标缓存按「文件路径」记，
exe 换了图标但路径没变，缓存命中旧图，桌面快捷方式会一直显示上一版的图标
（v0.7.0 用户实测复现）。所以安装时额外把一份 `fy-desktop.ico` 装进
`%LOCALAPPDATA%\fy-desktop\`，并用 NSIS 的 `NSIS_HOOK_POSTINSTALL` 钩子重建
桌面 / 开始菜单快捷方式、把 `IconLocation` 显式指到这个 ico——缓存键跟着路径走，
新图标立刻生效；钩子里再跑一次 `ie4uinit.exe -show`，让已打开的桌面重读图标。

### 4.3.3 关于页、更新与签名

托盘 →「关于 fy-desktop…」打开关于面板（浮层配色走 `--pop-*`，跟材质走）：
版本号、更新源链接、检查更新按钮、自动更新开关（存进配置 `auto_update`）。

更新链路刻意做得比 `tauri-plugin-updater` 轻：发布流程就是「打完包把
`fy-desktop_x.y.z_x64-setup.exe` 挂到一个 GitHub release 上」，所以直接读
`api.github.com/repos/fsdymy1024/fy-desktop/releases/latest`，从 assets 里挑
带 `setup` 的 exe 拿直链。发现新版本只发一条 toast，不弹窗抢焦点；
「下载并安装」= 下载到临时目录 → `/S` 静默装 → 自己退出。**不做静默替换**：
桌面常驻程序自己换自己的 exe，装到一半失败就再也起不来。

签名用 Tauri 的 `signCommand` 挂自定义签名器（`scripts/sign.ps1`）：
signtool 不在 PATH 里（Windows SDK 只在带版本号的目录下），脚本自己找；
证书按 `FY_SIGN_THUMBPRINT` → `scripts/sign.env.json` 的顺序取，都没有就
**跳过签名而不是报错**——没证书的机器照样出包。当前是一枚本机生成的自签
证书（`scripts/make-cert.ps1`），签名真实有效、文件可校验，但证书链不在
受信任根里，Windows 仍会显示「未知发布者」；要消掉得买 OV/EV 证书，
到时候把指纹换进 `sign.env.json` 即可，构建脚本一行不用改。

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
20. **`cmd /c start` 在无窗口进程里派生出「隐藏的窗口」** → 「打开收纳文件夹」两个入口
    （面板按钮、托盘菜单）都表现为点了没反应。原因是 cmd 自己是以 `CREATE_NO_WINDOW` 起的，
    `start` 派生新进程时会继承「不要显示窗口」的启动信息，于是资源管理器窗口建好又立刻
    按隐藏状态显示。改成 `ShellExecuteW`（返回值 >32 才算成功），并保留 `explorer` 兜底、
    写 `launch.log`、前端 toast——「点了没反应」这种报障，没有日志就只能猜。
21. **`forecast_days=1` 会把「未来 6 小时」截成「今天剩下的小时」** → 22 点以后 hourly
    数组只剩 2 格。这不是边界情况，一天有一半时间会撞上。取 2 天数据、用接口返回的
    `current.time`（`timezone=auto`，就是当地时刻）对齐当前小时，再连取 6 格。
    顺带记一个：`<svg>` 不写 `height` 时的**默认对象高度是 150px**，弹性布局里它会通过
    `min-height: auto` 变成行的最小高度，把同一张卡里后面的行挤出去——必须显式 `min-height: 0`。
22. **`invoke` 失败是静默的** → 后端返回 `Result::Err` 时前端只拿到一个 rejected promise，
    页面上什么都不会发生，用户只能描述「点了没反应」。凡是会打开外部程序、改动文件系统的
    命令，失败都要走 toast（`guardOpen`），否则排查只能靠猜。
23. **一个「隐藏的」资源管理器窗口会把后续所有打开请求都吃掉** → 这是第 20 条的真凶。
    `ShellExecuteW` 在 explorer 已运行时**不新建窗口**，而是给已有窗口发导航消息；如果那个
    窗口是隐藏的（`cmd /c start` 留下的），文件夹就被导航进了一个看不见的窗口，返回值还是 42
    「成功」——日志上一切正常，屏幕上什么都没有。实测：调用前 `EnumWindows` 里有一个
    `IsWindowVisible == false` 的 `CabinetWClass`，调用后窗口数 +0。
    改法：`explorer.exe /n,<path>` 强制开新窗口，再轮询 `CabinetWClass` 找新出现的 HWND，
    `ShowWindow(SW_SHOWNORMAL)` + `SetForegroundWindow` 兜住「建好了但是隐藏的」。
    验证方式也是这条思路：枚举窗口看**新旧差集**和 `IsWindowVisible`，不能只看返回值。
24. **近白底放在深色壁纸上必然刺眼，靠调透明度救不回来** → 「原色」一直想做「素纸」，
    从 `rgba(252,247,240,.94)` 调到 `rgba(237,232,224,.9)` 用户还是说刺眼。亮色面在暗背景
    上的对比度是 10:1 级别，压不透明度只会变灰、不会变暗。最终改成深灰实底
    `rgba(43,40,37,.82)` + 浅字，对比度反而更高、又不抢视线。材质之间要有**明暗差**才分得开。
25. **自由缩放和「对齐」是矛盾的** → 拖角能拉成任意宽高，等于每张卡都是独一无二的尺寸，
    永远差几个像素。改成三档预设（a / 2a / 2a×1.5a）后，宽高只有 3 种取值，横竖自然对齐。
    产品层面的教训：能用一个离散集合表达的东西，别给连续自由度。
26. **`closest('[data-mat]')` 会命中自己** → 组件库的根节点 `.gal` 也带 `data-mat`
    （给 CSS 按材质换底色用），于是点击事件冒泡到 `#gallery` 时，`closest` 一路向上
    找到了 `.gal`，任何一次点击都被当成「点了材质按钮」并 `return`。表现是「点添加没
    任何反应」，而且不报错。改成只认具体类名 `.matbtn`：**给容器挂状态属性时，别再用
    同一个属性名做事件委托的判定依据。**
27. **图标里的文字不会自动视觉居中** → `text-anchor="middle"` 居中的是**字宽**，不是
    墨迹：`fy` 里 `f` 没有下降部、`y` 有，实际包围盒偏上偏左。直接写会顶到圆角边缘。
    用一次 `translate/scale/translate` 把墨迹框搬到画布正中（缩到 78%），四周留白才均匀。
28. **伪元素会盖住元素的 background** → 玻璃卡片的白膜原来写在 `.surface` 的
    `background: var(--fill)` 里，底图写在 `::before` 里。但定位伪元素永远画在
    元素背景**之上**，底图一铺就把白膜整个盖死了——「玻璃」实际渲染出来的就是
    壁纸原样，和「暮色」毫无区别，用户切材质等于没切。改法：白膜必须是
    `::before` 自己的 `background-image` 的**第一层**（`linear-gradient(var(--veil), …), var(--shot)`），
    多层 background 的第一层画在最上面。**「一层在元素上、一层在伪元素上」这种
    叠层结构，永远要检查谁先画谁后画。**
29. **自适应明暗会和材质选择器打架** → 原来有一套「采样底图，偏暗就把卡片翻成
    深色 + 浅字」的规则（`body[data-tone="dark"]`），本意是保证可读性，但它把
    「玻璃」也一起翻了——壁纸一暗，玻璃渲染出来就是石墨色，用户视角就是
    「选了玻璃没生效」。材质的身份只能由用户决定，不能交给壁纸亮度：玻璃=浅色
    雾面，要深色选暮色/石墨。整个采样链路（canvas 采样 + data-tone + CSS 覆盖）
    直接删掉。
30. **资源管理器的图标缓存按路径记，不认文件内容** → exe 换了图标但路径没变，
    桌面快捷方式会一直显示旧图标（签名信息都对、exe 里也确实嵌着新图标，
    就是不显示）。给快捷方式一个**独立的 ico 文件**当 `IconLocation`，缓存键变了，
    新图标立刻出现；NSIS 钩子里再跑 `ie4uinit.exe -show` 兜底。
31. **PowerShell 5.1 按 ANSI 读没有 BOM 的 .ps1** → 脚本里的中文注释全部变成
    乱码，乱码里如果出现 `"` 就直接语法错误，脚本一行都跑不了。仓库里的
    `.ps1` 必须存成 UTF-8 **带 BOM**；同理，给 `Get-Content` 读的 JSON 配置
    别写中文（或统一 `-Encoding UTF8`）。另外 5.1 不支持 `?.` 这类 7 语法，
    脚本要按 5.1 的语法写。

## 10. 后续路线

| 版本 | 内容 |
| --- | --- |
| v0.8.1 | 格子内拖拽排序、图标白底抠除（`SIIGBF_BIGGERSIZEOK` + 边缘检测） |
| v0.9.0 | 多屏支持、备忘录可编辑、模糊强度可调 |
| v1.0.0 | 正式代码签名证书（替换自签）、GitHub 仓库与 release 流程跑通 |
