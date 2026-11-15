# 版本控制规范

> 适用：`fy-desktop` 全部代码与文档 ｜ 工具：Git 2.40+

本规范约束三件事：**怎么提交**、**怎么编号**、**怎么发布**。目标不是流程好看，而是让 `git log` 本身能当变更记录读，让任何一次回滚都有明确边界。

## 1. 分支模型

采用「主干 + 短生命周期特性分支」，不引入 develop / release 分支。

```
main ──●──●──●──────────●──●──●─────────●──▶
        \      \        /        \      /
         \      ●──●──●          ●──●──●
        feat/network-widget     fix/tidy-restore
```

| 分支 | 用途 | 生命周期 | 保护 |
| --- | --- | --- | --- |
| `main` | 永远可运行、可截图、可演示 | 长期 | 不直接提交功能代码；合并前必须 `npm run smoke` 通过 |
| `feat/<scope>` | 新功能 | ≤ 3 天 | 从 `main` 切出，合并后删除 |
| `fix/<scope>` | 缺陷修复 | ≤ 1 天 | 同上 |
| `docs/<scope>` | 纯文档 | 随时 | 可直提 `main` |
| `chore/<scope>` | 构建、脚本、依赖 | 随时 | 可直提 `main` |

**分支命名**：`<type>/<kebab-scope>`，scope 用英文小写，例如 `feat/network-widget`、`fix/clipboard-paste`。禁止 `test`、`tmp`、`dev2` 这类无意义名字。

**合并方式**：`git merge --no-ff`。保留特性分支的分叉点，方便日后用 `git log --graph` 看清某个能力是哪一批提交带进来的。不 rebase 已推送的公共分支。

## 2. 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/)，**描述用中文，type 与 scope 用英文**。

```
<type>(<scope>): <简述>

[可选正文：为什么这么改，而不是改了什么]

[可选脚注：BREAKING CHANGE / Refs #12]
```

### 2.1 type

| type | 用于 | 出现在 CHANGELOG |
| --- | --- | --- |
| `feat` | 新增用户可见的能力 | ✅ 新增 |
| `fix` | 修复缺陷 | ✅ 修复 |
| `perf` | 性能优化 | ✅ 优化 |
| `refactor` | 不改变行为的重构 | ❌ |
| `docs` | 文档 | ❌ |
| `style` | 格式、空白、不影响逻辑 | ❌ |
| `chore` | 构建、脚本、依赖、配置 | ❌ |
| `test` | 测试 | ❌ |

### 2.2 scope

与本项目模块对应，必须从下表取：

| scope | 范围 |
| --- | --- |
| `boot` | 启动编排、`lib.rs` |
| `window` | 铺屏、穿透守卫、置顶/回底 |
| `tray` | 托盘 |
| `config` | 配置读写与默认布局 |
| `layout` | 布局计算、设计像素换算 |
| `sys` | 系统指标采样 |
| `net` | 网络采样 |
| `weather` | 天气双源 |
| `glass` | 抓屏、模糊、排除自身 |
| `icons` | Shell 图标提取与缓存 |
| `desk` | 桌面扫描 / 移动 / 分组 |
| `autostart` | 开机自启 |
| `ipc` | 命令与事件 |
| `ui` | 渲染层样式与交互 |
| `widget` | 小组件 |
| `organizer` | 收纳格子 |
| `build` | 打包、安装包、图标、脚本 |
| `docs` | 文档 |
| `deps` | 依赖 |
| `release` | 版本发布 |

### 2.3 示例

```
feat(net): 新增网络小组件数据采集
fix(desk): 修复移入重名文件被覆盖的问题
fix(autostart): 自启项改为只写 HKCU
docs(design): 补充抓屏毛玻璃的实现细节
chore(deps): 升级 tauri 至 2.12.5
refactor(config): 删除 v0.1 布局迁移
feat(build): 增加 NSIS 安装包与静默安装参数
```

### 2.4 硬性要求

1. **一次提交只做一件事**。混了格式化 + 逻辑改动的提交一律打回。
2. **标题不超过 50 个字符**（中文按 2 字符算），不以句号结尾。
3. **正文说"为什么"**。"修复 bug""优化代码"这类描述无信息量，禁止。
4. **破坏性变更必须写 `BREAKING CHANGE:` 脚注**，并同步升主版本号。
5. **不提交**：`node_modules/`、`src-tauri/target/`、`src-tauri/gen/`、构建产物、日志、本地配置、`docs/*.json` 截图元数据。
6. **不跳过钩子**：`--no-verify` 只在钩子本身故障时使用，且需在正文说明原因。

## 3. 版本号

遵循 [语义化版本](https://semver.org/lang/zh-CN/) `MAJOR.MINOR.PATCH`：

| 位 | 何时 +1 | 本项目示例 |
| --- | --- | --- |
| `MAJOR` | 破坏配置结构、破坏对外契约、需要用户手工迁移 | `config.json` 结构不兼容，或移除组件 |
| `MINOR` | 向下兼容的新能力 | 新增网络组件、换渲染引擎、新增材质、新增安装包 |
| `PATCH` | 向下兼容的修复 | 修天气回退失败、修格子补位错位 |

**0.x 阶段的约定**：`0.MINOR.PATCH`，MINOR 承担"能力批次"的含义，允许在 0.x 内做小幅破坏性调整，但**必须**在 CHANGELOG 里用 ⚠️ 标出，并提供配置迁移说明。

**版本号唯一来源**：三处必须一致，打包前用 `npm run check:version` 校验（缺失则手工核对）。

| 文件 | 字段 | 用途 |
| --- | --- | --- |
| `package.json` | `version` | npm 脚本与文档 |
| `src-tauri/Cargo.toml` | `[package] version` | 二进制内部版本 |
| `src-tauri/tauri.conf.json` | `version` | 安装包文件名与卸载项显示 |

`boot` 命令返回的 `version` 读 `CARGO_PKG_VERSION`，前端不硬编码。

**Git 标签**：`v<version>`，与 `package.json` 严格一致，打**附注标签**（`git tag -a`）而不是轻量标签，便于携带发布说明。

## 4. CHANGELOG

根目录 `CHANGELOG.md`，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的分类：

`新增 / 变更 / 修复 / 优化 / 移除 / 安全`

**维护时机**：每个 `feat` / `fix` 合并进 `main` 时追加到 `[Unreleased]`；发布时把 `[Unreleased]` 落成具体版本号并补日期。**不允许发布后再补写**——那样一定会漏。

**写法**：面向用户，说清"你现在能做什么了"，不写实现细节。反例：`重构 NetworkMonitor`；正例：`网络组件支持 Wi-Fi 与有线自动识别`。

## 5. 发布流程

```bash
# 1. 确认干净、版本号一致、能编译
git status                        # 工作区必须干净
npm run check:version             # package.json / Cargo.toml / tauri.conf.json
cargo build --release --manifest-path src-tauri/Cargo.toml

# 2. 无界面自检（8 项，只碰临时目录）
FY_SELFTEST=1 src-tauri/target/release/fy-desktop.exe

# 3. 落 CHANGELOG：[Unreleased] → [0.2.0] - 2026-XX-XX

# 4. 出图，作为发布证据与文档素材
npm run shot

# 5. 出安装包（NSIS）
npm run build                     # → src-tauri/target/release/bundle/nsis/*.exe

# 6. 安装验证（会改注册表与开始菜单，验完记得卸载）
"src-tauri/target/release/bundle/nsis/fy-desktop_0.2.0_x64-setup.exe" /S
"%LOCALAPPDATA%\fy-desktop\uninstall.exe" /S

# 7. 提交并打标签
git add -A
git commit -m "chore(release): v0.2.0"
git tag -a v0.2.0 -m "v0.2.0：Rust 重写、真毛玻璃、真实文件夹收纳、安装包"
git push origin main --follow-tags
```

> **打包环境提示**：Tauri 的 NSIS 打包器会去 GitHub 取 NSIS 工具链与 `nsis_tauri_utils.dll`。
> 网络受限时先确认 `%LOCALAPPDATA%\tauri\NSIS\makensis.exe` 存在；官方 NSIS 可从
> `downloads.sourceforge.net/project/nsis/NSIS%203/` 获取。

**回滚**：优先 `git revert <commit>` 生成反向提交，保留历史。`reset --hard` 只允许在未推送的本地分支使用。

**发布前检查清单**

- [ ] `npm run check:version` 三处一致
- [ ] `cargo build --release` 无警告
- [ ] `FY_SELFTEST=1` 8 项全过
- [ ] 安装包能装能卸，卸载后 `%APPDATA%\com.fy.desktop` 与收纳目录仍在
- [ ] 首启自启项落在 HKCU，HKLM 干净
- [ ] `npm run shot` 截图正常，无空白组件、无文字截断
- [ ] `CHANGELOG.md` 已落版本号与日期
- [ ] 配置结构若变更，`config.rs` 有迁移或字段级回退

## 6. 本仓库的提交历史约定

v0.1.0 是按模块分批提交的，历史可直接当作"这个项目怎么长出来的"来读：

| 提交 | 内容 |
| --- | --- |
| `chore: 初始化工程骨架` | `package.json`、图标生成脚本、`.gitignore`、许可 |
| `docs(design): 视觉基准稿与设计文档` | `design/ui-demo.html`（含网络组件）、`docs/design.md` |
| `feat(window): 透明桌面层窗口与托盘` | `main.js`、`window.js`、`tray.js`、`store.js`、`layout.js`、`preload.js` |
| `feat(net): 系统/网络/天气/桌面四条数据链路` | `services/*`、`ipc.js` |
| `feat(ui): 玻璃小组件渲染层` | `index.html`、`app.css`、`widgets.js`、`util.js`、`overlay.js`、`main.js` |
| `feat(organizer): 桌面收纳格子与整理还原` | `organizer.js` |
| `chore(tooling): 截图自检与冒烟测试` | `scripts/shot.mjs`、`scripts/smoke.js` |
| `docs: 需求、版本控制与变更日志` | `README.md`、`docs/requirements.md`、`docs/versioning.md`、`CHANGELOG.md` |

v0.2.0 是一次栈迁移，按「地基 → 能力 → 收尾」推进，历史同样可读：

| 提交 | 内容 |
| --- | --- |
| `feat(boot): 迁移到 Tauri v2 工程骨架` | `src-tauri/*`、`tauri.conf.json`、`capabilities/default.json` |
| `feat(glass): 抓屏 + 离屏模糊实现真毛玻璃` | `desktop/glass.rs`、`--shot` 裁切链路 |
| `feat(icons): Shell COM 提取真实图标` | `desktop/icons.rs` |
| `feat(desk): 收纳改为真实文件夹移动` | `desktop/mod.rs`、`move_into/move_out` |
| `feat(widget): 组件增删、拖动与拉角缩放` | `main.js`、`gallery.js` |
| `feat(build): NSIS 安装包与开机自启` | `tauri.conf.json`、`autostart.rs`、`tray.rs` |
| `fix(autostart): 自启项改为只写 HKCU` | `autostart.rs`、`Cargo.toml` |
| `docs: 按 v0.2.0 重写需求、设计与版本控制` | `README.md`、`docs/*`、`CHANGELOG.md` |

后续开发的提交应延续同一粒度：**一个模块一批提交，不把多个模块塞进一次提交**。
