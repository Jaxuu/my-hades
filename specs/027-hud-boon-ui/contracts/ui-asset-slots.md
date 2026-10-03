# Contract · UI 资产槽位登记（`--ui-*`）

**Owner**：表现层｜**关联**：FR-001/011/012/040/050/053 · D3/D8/D9 · [`design/ui-art-direction.md`](../design/ui-art-direction.md) 附录 A

---

## 1. 机制（沿用 M16，不改造）

- 全部 UI 贴图经 **CSS 自定义属性 `--ui-*`** 注入；`client/main.ts` 在资源加载完成后写入 `url(...)`。
- `index.html` 中每个 `--ui-*` 的**默认值为 `none`** ⇒ 无资产时回退纯 CSS 表现（**降级契约**，FR-050）。
- 九宫格框体 MUST 用 **`border-image`（`border-image-slice: 12`）**，MUST NOT 用 `background-size: 100% 100%`（会把框拉成黑条）。

## 2. 既有槽位（MUST 保留，名与语义不变）

`--ui-panel-hud` · `--ui-panel-reward` · `--ui-panel-camp` · `--ui-frame-reward-card` · `--ui-frame-talent-card` · `--ui-button-primary` · `--ui-overlay-death` · `--ui-overlay-win` · `--ui-frame-slot` · `--ui-frame-slot-inlay` · `--ui-bar-hud`

> 既有槽位**只增不减、不改名**（FR-042）。`ui_skin.test.ts` 断言「≥11 个 `none` 默认值」与 9 个槽位存在。

## 3. 本特性**新增**槽位（**7 个**，全部默认 `none`）

> 命名以 [`design/ui-art-direction.md`](../design/ui-art-direction.md) 附录 A 为**唯一权威**（技术总监文档已与之一致）。

### 3.1 HUD（FR-001…004）

| 槽位 | 用途 |
|---|---|
| `--ui-frame-health` | 生命条外框（九宫格） |
| `--ui-frame-dash` | 冲刺外框（九宫格） |

> 生命**填充**为 CSS 换色（健康 / 中 / 濒危三态），**非资产**；金币牌复用既有 `--ui-panel-hud`。

### 3.2 品质卡片（FR-011）

| 槽位 | 用途 |
|---|---|
| `--ui-frame-boon-common` | Common（蓝）卡片框体（**品质色烘进线描**，禁纯白描） |
| `--ui-frame-boon-epic` | Epic（紫）卡片框体 |
| `--ui-frame-boon-legendary` | Legendary（金）卡片框体 |

> ⚠️ **品质色的可见承载面（关键）**：`border-image` 一旦生效会**完全接管**边框绘制，`border-color` 不可见。故品质色 MUST 由**不被 `border-image` 覆盖**的属性承载，采用**三层独立载体**：① 框外 3px **`box-shadow` 品质环**（QA 像素采样主锚点）；② 卡片内**品质 chip 背景**；③ 每品质**专属框体图**。三者同时成立，使 SC-003 在 `grayscale(1)` 下仍可判定。详见 [`design/ui-art-direction.md`](../design/ui-art-direction.md) §2.4。

### 3.3 祝福图标 —— **无槽位（用户裁定 U3 · 2026-10-03）**

用户裁定 **纯 CSS 占位，不新增图标资产**。因此：

- **取消** `--ui-icon-boon-*`（5 个）与 `--ui-boon-placeholder`；
- 祝福图标改为**纯 CSS 字形/形状**方案，由 `boons.json` 的 `icon` 字段（**CSS 字形 token**，非资产 id）驱动；
- `client/assets/manifest.ts` **MUST NOT** 新增任何图标条目。

### 3.4 Tab 面板与覆盖层统一（FR-020/040）

| 槽位 | 用途 |
|---|---|
| `--ui-panel-status` | Tab 面板底板（九宫格） |
| `--ui-rule` | 铜色分隔线（统一覆盖层标题处理） |

## 4. 约束

| # | 约束 |
|---|---|
| C1 | 每个新增槽位 MUST 默认 `none` |
| C2 | 新增槽位 MUST NOT 改动任何既有槽位名 |
| C3 | 资产 MUST 经 `client/assets/manifest.ts`（**唯一引用点**）以 `?url` 静态导入 ⇒ 删文件即 `npm run build` 失败 |
| C4 | UI 纹理保持 `nearest`，MUST NOT 加入 `HD_WORLD_ART_IDS`（M18 的 `linear`+mipmap 只针对世界美术） |
| C5 | MUST NOT 新增任何 `--font-*` 变量（见 [`hud-and-overlay-ui.md`](./hud-and-overlay-ui.md) §10 红线 R-b） |
| C6 | 全部资产 MUST 为开放许可（CC0 / 公共领域 / 明确允许再分发）或本仓库原创 / 程序化生成，并逐项登记 `assets/art/LICENSES.md` |

## 5. 体积预算（用户裁定 U2：**不设 UI 子预算**）

| 口径 | 值 | 说明 |
|---|---|---|
| UI 资产 | 受 M18 **全局预算**约束：单文件 ≤ 3 MiB / 总量 ≤ 12 MiB | 本特性**不设**更紧的 UI 子预算 |
| 估算参考 | ≈80 KB（仅参考，**非断言**） | 美术总监估算；MUST NOT 落为 `licenses` / `manifest` 断言 |

> 用户于 2026-10-03 裁定「不设子预算」，故此前技术总监/美术总监的子预算建议**降级为估算参考**。
