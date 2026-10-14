# OpenAI Model Search for SillyTavern

给 SillyTavern 两处下拉补上丢失的**搜索框**（用酒馆自带的 select2）：

| # | 下拉 | 元素 | 选择模式 | 谁在补 |
|---|---|---|---|---|
| 1 | Chat Completion 的 **OpenAI Model** | `#model_openai_select` | **单选**（保持不动） | PC + 手机 |
| 2 | 世界书弹窗的 **辅助 Lorebook** | `.character_extra_world_info_selector` | **多选**（保持不动） | 仅手机 / 触摸设备（PC 官方已挂） |

SillyTavern 自己就内置了 select2（自带搜索）：

- 上游 `public/scripts/openai.js` 已经给 OpenRouter / Aimlapi / ElectronHub /
  Chutes / NanoGPT 五个模型下拉挂上了——**唯独漏了 OpenAI 这一个**。
- 宿主 `script.js:9607` 给「辅助 Lorebook」挂 select2 时写在 `if (!isMobile())` 里，
  于是 **PC 有搜索、移动端没有**。

本扩展只补这两处缺口，不改动任何核心文件。

> **版本说明**：v1.2.0 曾把移动端改成「自定义全屏弹窗选择器」，真机上不如预期，
> 已按用户决定**回退**。当前 v1.0.1 = 两处都走 select2，与官方那五个下拉观感一致。

## 效果

下拉展开后顶部出现搜索框，输入即过滤：

![PC 搜索过滤](screenshots/PC-搜索过滤.png)

| 展开态 | 手机端 |
|---|---|
| ![PC 下拉展开](screenshots/PC-下拉展开.png) | ![手机搜索过滤](screenshots/手机-搜索过滤.png) |

## 安装

### 方式一：直接 clone（推荐，方便更新）

```bash
cd <SillyTavern>/public/scripts/extensions/third-party/
git clone https://github.com/<你的账号>/st-openai-model-search.git
```

刷新酒馆页面即可。更新时：

```bash
cd <SillyTavern>/public/scripts/extensions/third-party/st-openai-model-search
git pull
```

### 方式二：手动复制

把本仓库的 `manifest.json` 和 `index.js` 放到：

```
<SillyTavern>/public/scripts/extensions/third-party/st-openai-model-search/
```

然后在酒馆「扩展」面板确认已启用（本地扩展默认启用）。

## 使用

### OpenAI Model 下拉（单选）

- 打开 **API 连接**（插头图标）→ **Chat Completion** → 展开抽屉 → 点开「OpenAI Model」下拉
- 直接打字过滤，例如 `gpt-6` 只剩 GPT-6 系模型
- 选中后与原生下拉完全一致：设置照常保存、`change` 事件照常触发
- 切换 API / 刷新模型列表后**自动重新接管**，无需刷新页面
- **PC 与手机端均可用**（竖屏 / 横屏实测不溢出视口）

### 辅助 Lorebook 下拉（多选）

- 角色编辑 → 世界书弹窗 → **Additional Lorebooks**
- 手机上展开后同样有搜索框，输入即过滤
- **保持多选**：可连续勾选多个世界书，选完下拉不关闭（与 PC 上的官方行为一致）
- PC 端官方本来就挂了 select2，本扩展不重复挂载，只给官方那份补一个中文占位符
- 弹窗关闭再打开是全新 DOM，扩展持续监听并重新接管，无需刷新

## 实现要点

- **只补官方漏掉的一行**：复用官方 `openai.js` 对 OpenRouter 下拉完全相同的写法
  （`searchInputPlaceholder` + 酒馆输入框样式类 `text_pole`）
- **自包含兜底**：不假设宿主的 `select2-search-placeholder.js` 一定存在，
  挂载时绑 `select2:open`，每次展开自行设置占位符与样式类（重复设置无副作用）
- **幂等**：已挂载则跳过；元素未就绪时在 `APP_READY` 重试
- **动态同步**：`MutationObserver` 监听 option 变化（含运行期动态追加的
  External 分组），列表重建后自动 destroy + 重新挂载
- **移动端已启用**：官方 `openai.js` 用 `if (!isMobile())` 跳过 select2（移动端保持原生滚轮），
  本扩展默认在手机端**也启用**搜索，因为模型列表越长，手机上翻找越痛苦。
  如需恢复官方行为，把 `index.js` 顶部的 `ENABLE_ON_TOUCH` 改成 `false` 即可
- **设备判定**：主判据 `(hover: none) and (pointer: coarse)`；补位判据额外要求
  「窄窗口且不是精确指针设备」——Windows 触屏笔记本 `maxTouchPoints` 也大于 0，
  不排除的话桌面窗口一拖窄就会被判成移动端

### 辅助 Lorebook 的额外要点

宿主 `script.js:9591` 是从模板里 `clone()` 出这个 select 的，弹窗关闭后 DOM 被移除，
下次打开是一个**全新元素**——所以不能「挂一次就完事」：

- **持续监听**：`MutationObserver` 监听 `document.body`（`childList` + `subtree`，
  外加 `dialog` 的 `open`/`class` 属性变化），150ms 防抖后补挂；弹窗关了再开照样能挂上
- **跳过静态模板**：位于 `.template_element` 里的那份**绝不挂载**——
  宿主会 clone 它，一旦挂了，clone 出来的 select 带着 `select2-hidden-accessible`
  却没有真容器，会**永久失去搜索**
- **保持多选**：不动 `multiple` 属性，沿用官方的 `allowClear: true` +
  `closeOnSelect: false`，验证脚本里锁死了「`val()` 仍是数组 / 能连选多项」
- **`dropdownParent` 指向最近的 `dialog.popup`**，下拉不会被弹窗裁切；找不到就退化为不指定
- **容忍官方先挂载**：已挂过的只补装饰、不再叠一层容器

## 兼容性

| 项目 | 说明 |
|---|---|
| SillyTavern | 基于 `release` 分支 `public/scripts/openai.js` / `script.js` 核对；`loading_order: 999` 保证在宿主初始化后执行 |
| 依赖 | 复用酒馆已加载的 jQuery 与 select2 4.1.0-rc.0，不引入新依赖 |
| 主题/配色 | 跟随酒馆 `select2-overrides.css`，与 OpenRouter 下拉观感一致 |
| 移动端 | 两处均已启用；下拉最大高度取宿主的 300px，竖屏 / 横屏实测均不溢出视口 |

## 已知限制

- **iOS 自动缩放**：Safari 对字号小于 16px 的输入框，聚焦时会整页放大。
  默认配置下搜索框字号为 18px，不受影响；若你把字号调得过小可能触发，
  届时可自行给 `.select2-search__field` 补足 16px。
- 移动端用 select2 的小浮层，触摸目标比系统原生滚轮选择器小——这是与官方下拉一致的取舍；
  若更想要原生滚轮，把 `ENABLE_ON_TOUCH` 改成 `false` 即可完全恢复官方行为。
- 若你的主题对 `.select2-dropdown` 做了特殊覆盖，可能需要在主题侧一并调整。

## 验证

基于「真实 index.html + 宿主全部 CSS + select2 4.1.0-rc.0」的忠实复刻 harness，
4 个场景共 **216 项断言全部通过**（`PASS 216 / FAIL 0`）：
PC 1400 / 手机 390 / 手机 390 触摸 / 手机 844 横屏触摸。

覆盖：

- 搜索框出现、中文占位符、`text_pole` 样式类
- 打字过滤（真实键盘事件）与清空后恢复
- 零命中不误判（排除 select2 的 "No results found" 占位行）
- 选中后 `val()` 与 `change` 事件照常（openai.js 读写链路）
- 模型列表动态重建后自动接管
- **模型下拉保持单选**：无 `multiple` 属性、`multiple === false`、
  select2 渲染为 `--single` 容器（防回归锁）
- **辅助 Lorebook（PC + 移动端）**：挂上 select2、下拉内有搜索框、打字能过滤、
  **`multiple` 语义保持**（`val()` 是数组、能连选多项、选完不关闭）、
  弹窗关闭重开后能重新挂上、宿主先挂载时不叠第二层容器
- 静态模板里的同款 select 零误挂载；其它 131 个 select 零误伤；下拉不溢出视口
- 触摸模拟只认 `Emulation.setTouchEmulationEnabled`（hover/pointer features 实测无效），
  并额外断言「触摸模拟是否真的生效」

## 许可

MIT
