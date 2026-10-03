# M19 技术架构与接入方案 · 材质化 HUD 与祝福交互面板

**Task**: M19-T01-ENG ｜ **Milestone**: M19「UI 层重构」｜ **Feature**: `specs/027-hud-boon-ui`
**作者**: 程基岩（技术总监 / engineering-lead）｜ **状态**: 待评审（供 team-lead / 用户裁定）
**输入**: `specs/027-hud-boon-ui/spec.md`（已冻结）· `.specify/memory/constitution.md`（Principle I–VI）· 现有 `client/` 代码事实

> 本文是**施工图**：给出每个文件的落点、每个决策的理由、每个验收项的可执行证据路径。
> 硬约束贯穿全文：**`src/` 零改动 · 不新增运行时依赖 · 既有 948 例 100% 通过 · `typecheck:client` 通过 · `GameRenderer` 导入图不含 `howler` · 6 条冻结场景图契约（F1–F6）不被破坏**。

---

## 0.1 对齐说明（2026-10-03 · 与 art-director / quality-lead 文档收敛）

本版已与 `design/ui-art-direction.md`（美术方向）与 `design/quality-and-verification.md`（测试策略）**逐条对齐**，采纳其**已确认裁定**：

| 议题 | 采纳结论 | 来源 |
|---|---|---|
| 材质 HUD 容器 id | **`#hud-material`**（新 id）；`#hud` 保留为诊断块；`#gold` 复用为金币牌 | art §3 / QA §11.3（方案 b） |
| 新 DOM 钩子 | `hud-health`/`hud-dash`/`hud-gold` · `boon-card` · `boon-rarity-common\|epic\|legendary` · `status-panel`/`status-row`/`status-empty`；卡片子钩子 `boon-rarity-tag`/`boon-pips`/`boon-icon`/`boon-icon-frame--square\|cut\|crown`/`boon-desc` | art 附录 A / QA §11.4 / §11.7 / §11.8 |
| 品质色变量 | **新增** `--rarity-common\|epic\|legendary`（+`-bright`/`-deep`）；**不改** `--parchment/--gold/--blood/--stone-dark` | art §2.3.2 / QA §11.1 |
| 新 `--ui-*` 槽位 | `--ui-frame-health` · `--ui-frame-dash` · `--ui-frame-boon-*` · `--ui-panel-status` · `--ui-rule`（均默认 `none`）；**不含图标槽位** | art 附录 A + 用户裁定 ⑤ |
| 祝福图标 | **纯 CSS 占位、不新增图标资产**（用户裁定 ⑤）：`boons.json` 的 `icon` = **CSS 字形 token**；无 `ui.boon.*` 资产、无占位资产槽位 | team-lead U3 |
| 描述模板槽位 | `{damage}` / `{interval}` / `{dmgPerStack}` / `{maxStacks}` / `{knockback}` / `{amount}` / `{ticks}` | art 附录 C |
| 祝福表路径 | **`client/assets/boons.json`** | QA §2.0/§10 |
| 纯模型模块名 | `client/ui/{hud-model,quality,boon-presentation,status-panel}.ts`（+ 本方案增设 `boon-catalog.ts`） | QA §2.0/§10 |
| 生命三态阈值 | `ratio ≥ 0.66` / `0.33 ≤ ratio < 0.66` / `ratio < 0.33` | art §3.1 / Q2 |
| 体积预算 | **不设 UI 子预算**（用户裁定 ③）：仅受 M18 全局预算约束（单文件 ≤3 MiB / 总量 ≤12 MiB），保持 advisory | team-lead U2 |
| 测试套件 | 采用 QA 的 **S1–S10** 命名（本方案不另起套件名） | QA §2.1 |

**② 品质色承载面已闭合**（QA §11.2 / art §2.4）：采用**三层载体**——① 外层 3px `box-shadow` 品质环（主采样锚点）+ ② 品质 chip 背景 + ③ 每品质专属框体图（`--ui-frame-boon-*`）；③ 缺失时回退 `border-color` 实心框。SC-003 像素判据据此成立，本架构**无剩余外部依赖**。

---

## 0.2 摘要与决策登记（D1–D12）

一句话架构：**在 `client/` 内新增一层「DOM-free 的纯模型函数」，由 `UIManager` 作为唯一的 DOM 所有者与覆盖层调度器把它映射成 DOM。** 逻辑层照旧只被只读探针读取；`src/` 一个字节都不动。

| # | 决策 | 一句话理由 | 主要影响 |
|---|---|---|---|
| **D1** | HUD = **DOM/CSS**，绝不在 Pixi 画布内绘制 | 保 F1–F6；`ui_skin.test.ts` F6 明禁 `UIManager` 触 `pixi.js`；既有 `--ui-*` 皮肤与 `#hud`/`#gold` 都是 DOM | §5 |
| **D2** | 祝福数据表落 **`client/assets/boons.json`**（表现层所有），**不**放 `assets/data/`、**不走** `DataManager` | 纯表现元数据依 Principle V 属 `client/`；`assets/data/` 是引擎平衡表目录，混放会招致 `src/data/bundled.ts` 误载（FR-030/036） | §2 |
| **D3** | 表格读取 = **静态 JSON import** + 客户端 `boon-catalog` 校验/降级 | `resolveJsonModule=true` 已开；零依赖、零 fetch、对 `src/` 天然惰性 | §2 |
| **D4** | 描述数值 = **逻辑层只读派生**（`DataManager.getModifierConfig` / `RewardPool` 常量 / `POISON_STATUS_SPEC`），表现层**零数值字面量** | 单一来源，杜绝漂移（FR-014 / SC-004） | §4 |
| **D5** | 描述 = **`{slot}` 模板 + 运行时注入**；任一槽位无法解析 → 整体回退到安全无数字文案 | 永不输出 `undefined`/`NaN`（Edge Cases 第 3 条） | §4 |
| **D6** | `UIManager` 保留「**元素工厂 + 全部 class/id 字面量（含新增钩子） + 覆盖层优先级 + 监听生命周期**」的唯一所有权；纯模型外移 | 使 `tests/ui/ui_skin.test.ts` **零改动**，且满足 QA §11.4「新钩子在 `index.html` 与 `UIManager.ts` **两侧**存在」 | §1 §6 |
| **D7** | Tab 面板监听：**仅在 PLAYING 且无覆盖层时挂载**；离开即摘除；`destroy()` 摘除；有覆盖层时**不拦截 Tab**（让原生焦点遍历生效） | 满足 FR-025 + FR-052；且 `togglePanel()` 签名不含 `World`/`GameSimulator`（QA §10.4） | §1 §3 |
| **D8** | 面板「不暂停」= 纯 DOM 覆盖，**零 sim 写**；以**静态守卫 + 真 sim 逐 Tick 摘要**（QA S6）+ 浏览器探针证明 SC-006 | node 无 jsdom，无法实例化 DOM | §3 §7 |
| **D9** | 品质 = 静态声明式纯外观；`rarity → class + --rarity-* 变量`；**六通道**冗余编码（色/边框纹样/角标/中文标签/图标外框/动效） | FR-011/FR-016 + SC-014（色盲可辨 ≥90%） | §5 |
| **D10** | 祝福图标 = **纯 CSS 字形 token**（用户裁定 ⑤）：`boons.json` 的 `icon` 是 CSS token，`manifest.ts` **不新增**图标条目；未知 token 回退默认字形 | 零资产、零外部请求、天然满足降级；框体仍走既有 `manifest`/`AssetCatalog` 管线 | §2 §8 |
| **D11** | 测试策略：**DOM-free 纯模型用 node/vitest 单测（QA S1–S10）；DOM 行为用浏览器探针**；**不引入 jsdom** | 现行 `environment:'node'`、无 jsdom；加 jsdom 破坏测试栈约束 | §6 §7 |
| **D12** | 性能沿用**交错比值 ≤ 1.2** 口径；HUD 用**变更键守卫**使空闲帧零 DOM 写 | FR-056 / SC-013；FR-006 无闪烁 | §5 §7 |

---

## 1. 客户端分层与改动落点（逐文件）

### 1.1 现有分层（事实基线）

```
client/main.ts          ← 装配根（唯一 src↔client 缝合点；选 seed、存 save、装 bridge、applyUiSkin）
client/UIManager.ts     ← DOM 半边：draft/death/win/hub 四覆盖层 + #gold 文本
client/GameRenderer.ts  ← Pixi 半边（2618 行；F1–F6 场景图契约宿主）
client/GameLoop.ts      ← 实时→定 tick；每帧 drain bridge 一次
client/ClientEventBridge.ts ← hit/death/dash 三条 tee 总线
client/KeyboardInput.ts / AudioManager.ts / SaveStore.ts / bundled.ts
client/assets/{manifest,AssetCatalog,sprite-map}.ts
index.html              ← 内联 CSS 皮肤（--ui-* + 九宫格 border-image）
```

**关键约束发现（决定 §6 的测试策略）**：现有测试**没有任何一个实例化 `UIManager` 或使用 DOM**——`tests/ui/ui_skin.test.ts` 是**源码文本扫描**测试，`tests/render/interpolation.test.ts` 明确注释 `document is not defined`。测试环境是 `node`、`pool:'threads'`、**无 jsdom**。因此本方案把「能被 node 单测的纯模型」与「只能在浏览器验证的 DOM」**物理分离**（D11）。

### 1.2 目标分层（模块名与 QA §2.0/§10 对齐）

```
                 ┌──────────── 纯模型（DOM-free · 无 pixi · 无随机 · node 可单测，落 client/） ────────────┐
client/ui/boon-catalog.ts     loadBoonTable() / getBoonMeta(id) / validateBoonTable(poolIds)  读 boons.json + 降级
client/ui/quality.ts          qualityColor(rarity) / qualityLabel(rarity) / DEFAULT_QUALITY
client/ui/boon-presentation.ts buildBoonCard(id, logicNumbers) → { rarity, color, iconToken, description }
client/ui/hud-model.ts        readHudState(world) / buildHudView(inputs) → { hp, hpRatio, dash, gold, texts }
client/ui/status-panel.ts     buildStatusPanel(ownedIds) → { entries, isEmpty, scrollable }
                 └──────────────────────────────────────────────────────────────────────────────────────┘
                                            ▲ 被调用（单向，只读）
client/UIManager.ts   唯一 DOM 所有者：读模型 → 写 DOM；**全部 class/id 字面量（冻结 + 新增）都在这**；
                      覆盖层优先级链；Tab 监听生命周期；所有 <button> 的创建。
```

**为什么这样切分（D6 的核心）**：`tests/ui/ui_skin.test.ts` 按**源码文本**断言 `client/UIManager.ts` 必须含 10 个冻结 class + 6 个 M16 钩子，并且
`document.createElement('button')` 出现 **≥ 3 次**（F4，且**正则只认单引号字面量**）。
更关键的是 **QA §11.4** 要求新增钩子（`hud-*`/`boon-card`/`boon-rarity-*`/`status-*`）在 `index.html` 与 `UIManager.ts` **两侧**都存在。
因此：
- **`UIManager` 继续创建所有 `<button>` 并持有全部 class/id 字面量**（冻结 + 新增）；
- **纯模型模块只返回数据**（`rarity` 枚举、`hpRatio`、`description` 文本、`iconToken`），**不建 DOM、不含钩子字面量**。

这样 `ui_skin.test.ts` 既有 21 例**零改动**，且 QA 的新钩子断言两侧皆真。**不设独立的「DOM 视图」模块**——DOM 建造留在 `UIManager`（它本就是「DOM 半边」），避免钩子字面量散落导致两侧断言失败。

### 1.3 逐文件改动清单

| 文件 | 处置 | 具体内容 | 理由 |
|---|---|---|---|
| `client/UIManager.ts` | **扩展**（不重写既有分支语义） | ① 新增材质 HUD 更新路径写 `#hud-material` + `#gold`（写-变更守卫同 `renderedHud` 模式）；② `render(ids)` 给奖励按钮追加 `boon-card` + `boon-rarity-*` + 图标 + 描述（**按钮本体仍在此创建**）；③ 新增 Tab 面板编排（`renderPanel`/`clearPanel` + `panelOpen`）；④ Tab 监听生命周期（`attachPanelKey`/`detachPanelKey`）；⑤ `sync` 优先级链尾插入 panel。**全部冻结钩子字面量 + 新增钩子字面量都在本文件。** | 保 F4 与两侧断言；保 4 覆盖层分支语义 |
| `client/main.ts` | **微改** | ① `UIManagerOptions` 传入 `hudMaterial`（`#hud-material`）；② `applyUiSkin` 增列新 `--ui-*` 槽位（§2.5）；③ `installHud`（诊断块 `#hud`）**保持不动**（FR-007 分离）。 | 装配根职责不变 |
| `index.html` | **扩展 CSS/结构** | 新增 `#hud-material` 容器与 `.hud-*` / `.boon-card` / `.boon-rarity-*` / `.status-*` 样式、`--rarity-*` 变量、新 `--ui-*` 槽位（默认 `none`）；**保留全部冻结 id/class 与既有 `--ui-*`**；**不新增 `--font-*`**；`#hud, #keys, #gold {` 规则块**保持连续同序**。 | 冻结契约（FR-042 / T4 / T7） |
| `client/assets/boons.json` | **新增** | 表现层祝福元数据表（§2）。 | D2/D3 |
| `client/ui/boon-catalog.ts` | **新增** | 表读取 + 与 `REWARD_POOL` 交叉校验 + 降级；`getBoonMeta` **永不抛**。 | §2 |
| `client/ui/quality.ts` | **新增** | `qualityColor`/`qualityLabel`/`DEFAULT_QUALITY`（三色字面量）。 | §5.4 |
| `client/ui/boon-presentation.ts` | **新增** | `buildBoonCard(id, numbers)`：catalog + 逻辑数值 + 描述组装。 | §4 |
| `client/ui/hud-model.ts` | **新增** | `readHudState(world)` / `buildHudView(inputs)`：纯派生（含除零/边界守卫）。 | §3 §5 |
| `client/ui/status-panel.ts` | **新增** | `buildStatusPanel(ownedIds)`：已拥有祝福列表模型。 | §3 |
| `client/assets/manifest.ts` | **可选扩展（仅框体，不含图标）** | 若美术交付**框体**：追加 `ui.frame.boon-*` / `ui.frame.health\|dash` / `ui.panel.status` / `ui.rule.bronze` 的静态 import 条目（`visual(...)`）。**用户裁定 ⑤：不新增任何图标条目**（图标纯 CSS）。 | 复用删文件即构建失败 + 逐条目降级 |

> **禁止**：任何新模块 import `howler`；任何新模块 import `pixi.js`（F6 红线）。

---

## 2. 祝福数据表契约

### 2.1 位置裁定：`client/assets/boons.json`（**D2**）

| 候选 | 评价 |
|---|---|
| `assets/data/boons.json` | ✗ 该目录语义是「引擎平衡表」，全部经 `src/data/bundled.ts` 具名加载、`DataManager` 校验。放**纯表现元数据**进去会诱导 `src/` 误载（FR-030/036）。 |
| **`client/assets/boons.json`（采纳）** | ✓ 表现层所有、QA §2.0/§10 已建议此路径。`manifest.ts` 的「唯一资产导入点」不变量**范围不变**——它管的是**带许可的图片/音频二进制资产**，JSON 数据表是另一类（`assets/data/*.json` 亦是被 `client/bundled.ts` 直接 import 的数据表）。 |
| `client/boons/boons.json` | △ 亦合理，但为与 QA 收敛，取 `client/assets/boons.json`。 |

> **核实**：`readdirSync` 仅出现在 `tests/assets/licenses.test.ts`，且其扫描根为 `ART_SEARCH_DIRS`（美术资产目录），**不扫 `client/assets/`** ⇒ 新增 `client/assets/boons.json` 不触发任何资产许可/清单测试。

**读取方式（D3）**：`client/ui/boon-catalog.ts` 顶部
```ts
import boonsJson from '../assets/boons.json';   // resolveJsonModule=true；Vite 原生处理；零依赖、零 fetch
```
静态 import ⇒ 对 `src/` 天然惰性（`src/data/bundled.ts` 只具名加载它自己那几张表，**看不见**这张）。由 QA S7 断言「`src/**` 不 import `boons.json`」。

### 2.2 Schema 字段（槽位名对齐 art 附录 C）

```jsonc
{
  "zeus_strike":     { "rarity": "epic",      "icon": "bolt",
                       "description": "攻击命中时在目标处引发雷电，造成 {damage} 点伤害" },
  "dionysus_strike": { "rarity": "epic",      "icon": "grape",
                       "description": "命中使目标中毒：每 {interval} tick 造成 {dmgPerStack} 点伤害/层，最多 {maxStacks} 层" },
  "poseidon_dash":   { "rarity": "legendary", "icon": "wave",
                       "description": "冲刺时在原地引发冲击波，造成 {damage} 点伤害并击退 {knockback}" },
  "hp_up":           { "rarity": "common",    "icon": "heart",
                       "description": "生命上限 +{amount}" },
  "dash_up":         { "rarity": "common",    "icon": "boot",
                       "description": "冲刺冷却 −{ticks} tick" }
}
```

| 字段 | 类型 | 约束 | 缺省/降级 |
|---|---|---|---|
| `rarity` | `'common' \| 'epic' \| 'legendary'` | 声明式字面量；**不参与任何数值/随机**（FR-016） | 缺省 `common` |
| `icon` | `string`（**CSS 字形 token**，kebab-case） | 映射到 `.boon-icon-<token>`（CSS 绘制字形，**无资产**） | 缺省/未知 → 默认 token（§2.4） |
| `description` | `string`（含 `{slot}` 模板） | 槽位名 = §4 的数值键 | 缺省 → `getRewardDefinition(id).label` 兜底 |

**关键纪律**：`boons.json` 的描述**只含 `{slot}` 占位，不含任何效果数值字面量**。由 §6（QA S4 通道 A + 变异实验 M2）机器守护。

**图标派生（用户裁定 ⑤）**：`boon-presentation.buildBoonCard` 把 `icon` token **原样透传**为 `iconToken`（**不做资产查找**）；`UIManager` 据此加 class `.boon-icon-<token>`，字形由 CSS 绘制（伪元素 content / 形状）。未知或缺失 token ⇒ `iconToken = 'default'`（`.boon-icon-default`）。**不查询 `MANIFEST` / `AssetCatalog`，不 import 任何图标资产。**

### 2.3 与 `REWARD_POOL` 的一致性校验（防悬空 id，QA S7）

`REWARD_POOL`（`src/ecs/rewards/RewardPool.ts`）是**权威祝福目录**（5 条）；`boons.json` 是表现层影子表。校验在 **client 侧**完成，`src/` 不感知：

```ts
// client/ui/boon-catalog.ts
export function validateBoonTable(raw: unknown, poolIds: readonly string[]): BoonValidation {
  // 1) 悬空 id：表中出现但 REWARD_POOL 无此 id → 忽略 + console.warn（不影响抽取）
  // 2) 缺失 id：REWARD_POOL 有但表中无 → 记入 missing，getBoonMeta 走降级
  // 3) 非法 rarity → 归一到 'common'
  // 返回 { table, dangling: string[], missing: string[] }，永不抛
}
```
- 校验时机：**Bootstrap 期一次性**（`main.ts` 的 `bootstrapClientData()` 之后、`new Application()` 之前），与既有数据层同构。
- `poolIds` 来源：`REWARD_POOL.map(r => r.id)`。**不得**把 `boons.json` 的 id 反向喂给 `src/`。
- QA S7 断言**双向相等**：`set(boons.json 键) === set(REWARD_POOL.id)`。

### 2.4 降级矩阵（FR-017 / FR-035 / FR-050）

| 情形 | 表现 |
|---|---|
| `rarity` 未声明/非法 | `common` 外观（蓝） |
| `icon` 未声明/未知 token | **纯 CSS 默认字形**（`.boon-icon-default`：品质色描边 + `◆` 字符）——无资产依赖（用户裁定 ⑤） |
| 框体资产 degraded（`AssetCatalog` 报坏） | `border-image` 回退到 `border-color` 纯色框；图标外框由 CSS 绘制、**不依赖资产**，故卡片仍有「带品质刻口的空槽 + 可读文字」 |
| `description` 未声明 | `getRewardDefinition(id).label` |
| 描述模板槽位缺数值 | 安全无数字文案（§4.3） |
| 整表缺失/JSON 解析失败 | 全 5 条走降级；**游戏照常** |
| 悬空 id | 忽略 + warn；**抽取结果不变**（品质不参与抽取） |

### 2.5 新增 `--ui-*` 槽位（art 附录 A，全部默认 `none`）

`main.ts::applyUiSkin` 增列（走既有注入路径，`catalog.url(id)` 为 `undefined` 时**不 set** ⇒ 保留 `none` 降级）：

| 槽位 | 资产 id |
|---|---|
| `--ui-frame-health` | `ui.frame.health` |
| `--ui-frame-dash` | `ui.frame.dash` |
| `--ui-frame-boon-common` / `-epic` / `-legendary` | `ui.frame.boon-*` |
| `--ui-panel-status` | `ui.panel.status`（缺省回退 `--ui-panel-camp`） |
| `--ui-rule` | `ui.rule.bronze`（缺省回退 `--ui-bar-hud`） |

> **图标无槽位**（用户裁定 ⑤）：祝福图标为纯 CSS 字形，不经 `--ui-*` 资产注入；`manifest.ts` 不新增图标条目。

---

## 3. 只读探针与事件总线

### 3.1 每个表面读什么、怎么读

| 表面 | 探针（全部只读） | 备注 |
|---|---|---|
| **HUD·生命** | `playerId = world.query(PlayerInputComponent)[0]` → `world.getComponent(playerId, HealthComponent)` → `{hp, maxHp}` | 与 `main.ts::findPlayerId` 同法；**每帧重解析**（重启后是新实体） |
| **HUD·冲刺** | `world.getComponent(playerId, DashStatsComponent)` → `{cooldownRemaining, cooldownTicks}` | `cooldownRemaining <= 0` ⇒ 可用 |
| **HUD·金币** | `readGold(world)`（`InventoryComponent`） | 既有只读访问器，无钱包返 `0` |
| **卡片** | `findRewardDraft(world)?.pendingRewards` + `getRewardDefinition(id)?.label` + `getBoonMeta(id)` + `boonEffectNumbers(id)` | 触发/数量/时机**沿用既有**（FR-010） |
| **面板** | `world.getComponent(playerId, ModifierComponent)?.modifiers` → 已拥有 id 列表 | `modifiers` 已升序去重，天然稳定 |

### 3.2 事件桥的取舍（**不**新增桥消费方）

现状：`ClientEventBridge` 的 `hit/death/dash` 三条 tee 总线由 `GameLoop.syncFrame` **每帧 drain 恰好一次**，交给 `GameRenderer` 与 `AudioManager`。

**建议：HUD 的「受伤闪动 / 冲刺就绪」反馈走「状态差分观察」，而非事件桥。** 理由：
1. 桥已被 `GameLoop` **单次 drain**，加第二消费方需改 `GameLoop` 的 drain 契约——引入不必要的耦合面。
2. 项目已有先例：`installCoinChime`（金币增加）、`installHazardBlast`（hazard 计数下降）、`installTerminalSting`（状态边沿）**都是逐帧读状态、观测边沿**。
3. HUD 正确性**本就派生自状态**（冲刺可用 = `cooldownRemaining`），事件只用于**瞬时装饰**，用状态边沿（`hp` 下降 / `cooldownRemaining` 跨 0）即可，且天然与帧对齐。

> 若评审坚持用事件桥：**唯一可接受方式**是把 `UIManager.sync` 扩展为 `sync(world, meta?, frameEvents?)`（镜像 `GameRenderer.syncWorld`），并在 `main.ts` 的 ticker 回调里复用 `GameLoop` 已 drain 的结果——**不得**在 `GameLoop` 里 drain 两次。本方案默认**不采用**。

### 3.3 显式「零写 API」声明（FR-033，QA §10.4）

新增与改动的 UI 模块**只允许**出现下列 `src/` 依赖：

- 类型：`import type { World }`、`import type { EntityId }`
- 只读访问器：`readGold`、`readDarkness`、`findRewardDraft`、`currentRoomId`、`getRewardDefinition`、`isRewardId`、`findGameState`、`isRunFailed`、`isRunWon`、`isInHub`、`isRunOver`
- 组件**类**（仅用于 `getComponent`/`query`）：`HealthComponent`、`DashStatsComponent`、`ModifierComponent`、`PlayerInputComponent`
- 只读常量/规格：`REWARD_POOL`、`HP_UP_AMOUNT`、`DASH_UP_COOLDOWN_REDUCTION`、`MIN_DASH_COOLDOWN_TICKS`、`POISON_STATUS_SPEC`
- 只读数据：`DataManager.getModifierConfig`（读）
- **禁止**：`addComponent`、`applyDamage`、`addModifier`、`grantReward`、`applyStatusEffect`、`markRunFailed/Won/Hub`、`world.*` 任何 mutator、`sim.step`、`sim.inject`、`sim.restartRun`、`sim.enterHub`、`sim.purchaseMetaUpgrade`。

**`togglePanel()` 契约（QA §10.4）**：签名**不含** `World` / `GameSimulator`，内部**不调** `step` / `inject` / 任何写 API；面板模块**不 import** `GameSimulator`。由 QA S6 的结构断言 + 本方案 §6 的静态守卫共同锁死。

---

## 4. 数值化描述的防漂移机制

### 4.1 数值来源（单一来源 = 逻辑层，**零表现层字面量**）

| 祝福 | 逻辑层来源（只读） | 槽位（art 附录 C） |
|---|---|---|
| `zeus_strike` | `DataManager.getModifierConfig('zeus_strike')` → `{radius:1, damage:20, …}` | `{damage}` |
| `poseidon_dash` | `DataManager.getModifierConfig('poseidon_dash')` → `{radius:3, damage:5, knockbackForce:40, …}` | `{damage}`、`{knockback}`(=`knockbackForce`) |
| `dionysus_strike` | `POISON_STATUS_SPEC`（`src/ecs/components/StatusEffectComponent.ts`）→ `{damagePerStack:4, maxStacks:5, durationTicks:120, intervalTicks:30}` | `{interval}`、`{dmgPerStack}`、`{maxStacks}` |
| `hp_up` | `HP_UP_AMOUNT`（`src/ecs/rewards/RewardPool.ts`）= 20 | `{amount}` |
| `dash_up` | `DASH_UP_COOLDOWN_REDUCTION`=10（下限 `MIN_DASH_COOLDOWN_TICKS`=10） | `{ticks}` |

> **缺口（必须显式处理）**：`dionysus_strike` **不在** `modifiers.json`（它是状态 DoT，见 `StatusEffectComponent.ts` / `DionysusBlightModifier.ts`）。`DataManager.getModifierConfig` 对未知 id **会抛 `SchemaError`** ⇒ `boon-presentation.ts` 必须**先 `DataManager.hasModifier(id)` 再取**，缺则回退到该祝福自己的逻辑来源（此处即 `POISON_STATUS_SPEC`）。

### 4.2 描述组装

```ts
// client/ui/boon-presentation.ts —— 纯函数，无 DOM，无随机
export interface LogicNumbers { readonly [slot: string]: number }
export function boonEffectNumbers(id: string): LogicNumbers;
//   switch(id):
//     'zeus_strike'     → hasModifier ? { damage: cfg.damage } : {}
//     'poseidon_dash'   → hasModifier ? { damage: cfg.damage, knockback: cfg.knockbackForce } : {}
//     'dionysus_strike' → { interval: POISON_STATUS_SPEC.intervalTicks,
//                           dmgPerStack: POISON_STATUS_SPEC.damagePerStack,
//                           maxStacks: POISON_STATUS_SPEC.maxStacks }
//     'hp_up'           → { amount: HP_UP_AMOUNT }
//     'dash_up'         → { ticks: DASH_UP_COOLDOWN_REDUCTION }
//     default           → {}

export function renderBoonDescription(meta: BoonMeta, numbers: LogicNumbers, label: string): string;
//   1) 模板 = meta.description ?? label
//   2) 逐 {slot} 替换为 String(numbers[slot])（仅当 Number.isFinite）
//   3) 若模板仍含 '{' / 结果含 'NaN' / 含 'undefined' → 返回 label（安全无数字文案）
```

> 数值以 **tick** 表达（对齐 art 附录 C）；若未来需展示秒数，必须用**装配根注入的 `sim.fixedDeltaSeconds`** 换算，**不得硬编码 `1/60`**（Principle II）。

### 4.3 可测地保证与逻辑层一致（SC-004，QA S4 双通道）

QA `S4 boon_description_truth.test.ts` 采用**双通道，缺一不可**：
- **通道 A（字面量交叉校验）**：从描述里解析出的数字 == **两个独立来源**（JSON 文件 + `src` 导出常量）之值。**不得**用「同式重算」——那会恒真。
- **通道 B（行为断言，最强）**：真 sim 授予 `zeus_strike` → 驱动一次会命中的攻击 → 断言目标 hp 下降量 == 描述中的 N；`hp_up` → 授予后 `maxHp` 增量 == N；`poseidon_dash` → 冲刺观测击退 == 40。
- **反空真**：比对掉血前先断言 `hpBefore > hpAfter`。
- **变异实验 M2**：把 `boons.json` 的 `zeus_strike` 描述改成「999 点」⇒ 通道 A 必失败 ⇒ 备份 `cmp` 还原（**禁 `git checkout --`**）。

---

## 5. HUD 组件实现方式建议

### 5.1 明确推荐：**DOM / CSS（D1）**

| 维度 | DOM/CSS | Pixi 内绘制 | 结论 |
|---|---|---|---|
| **F1–F6 冻结场景图** | 零影响 | 需常驻节点 → 破坏 F1/F5/F6 | **DOM 胜** |
| **`ui_skin.test.ts` F6** | 合规 | 直接违反（断言 `UIManager` 不含 `pixi.js`/`Container`/`Graphics`） | **DOM 胜** |
| **既有 `--ui-*` 皮肤** | 直接复用九宫格 `border-image` | 需另造一套 Pixi 九宫格 | **DOM 胜** |
| **`#hud`/`#gold` 冻结 id** | 天然满足 | 需重构 | **DOM 胜** |
| **中文可读 / 键盘焦点 / 无障碍** | 浏览器原生 | 需手写 | **DOM 胜** |
| **每帧成本** | 变更键守卫 ⇒ 空闲帧零写 | 需管理 Pixi 对象池 | **DOM 胜（配合 D12）** |

**混合方案无必要**：没有任何一项 HUD 需求是 canvas 独有能力。

### 5.2 DOM 契约（`#hud-material` 新容器 + `#gold` 复用，art §3 / QA §11.3）

`index.html` 保留 `#hud`（诊断，`main.ts` 独占，**不动**）、`#gold`（冻结 id，改造为金币牌）、`#keys`（键位图例）。**新增**：

```html
<div id="hud-material"><!-- 新增：材质化 HUD 容器（生命条 + 冲刺环） -->
  <div class="hud-health"><!-- 生命条：track + fill + 读数 + 25% 刻度 --></div>
  <div class="hud-dash is-ready"><!-- 或 is-cooling：环形进度 + 符文 + 读数 --></div>
</div>
<div id="gold" class="hud-gold"><!-- 冻结 id 复用为材质金币牌：图标 + 数值 --></div>
```

**`UIManagerOptions` 新增**：`readonly hudMaterial?: HTMLElement | null;`（与既有 `hud?: HTMLElement | null` 同构；`null`/省略 ⇒ 不渲染该表面）。

**关键**：`#hud-material`、`hud-health`、`hud-dash`、`hud-gold`、`boon-card`、`boon-rarity-*`、`boon-rarity-tag`、`boon-pips`、`boon-icon`、`boon-icon-frame--*`、`boon-desc`、`status-*` 等钩子字面量**必须出现在 `UIManager.ts`**（D6 / QA §11.4），故由 `UIManager` 赋 class，纯模型只返回数据。

### 5.3 边界与守卫（对应 Edge Cases，QA S1）

- **生命比例**：`hpRatio = maxHp <= 0 ? 0 : clamp(hp / maxHp, 0, 1)` —— 防除零/反向条。
- **生命三态**（art §3.1）：`ratio ≥ 0.66` 健康 / `0.33 ≤ ratio < 0.66` 中 / `ratio < 0.33` 濒危。
- **冲刺边界**：`cooldownRemaining <= 0` ⇒ `dashState='ready'`, `dashProgress=1`；`cooldownRemaining === cooldownTicks` ⇒ `'cooling'`, `progress=0`；中值 ⇒ 分数进度。
- **金币极大**：`String(gold)` 不截断；`tabular-nums` 防跳动；CSS `min-width` 随内容增宽。
- **无闪烁（FR-006）**：变更键 `hudKey = ${hp}|${maxHp}|${cooldownRemaining}|${gold}`；相等则**直接 return，零 DOM 写**（沿用既有 `renderedHud` 守卫模式）。
- **浮点**：比例/进度断言一律 `toBeCloseTo(x, 9)`（QA §7）。

### 5.4 品质编码与三层载体（D9，SC-003/SC-014，art §2.4 / QA §11.2）

新增 CSS 变量（**只增不改**）：`--rarity-common: #3f6ea8` / `--rarity-epic: #8a5cd0` / `--rarity-legendary: #ffcd4a`（+ `-bright`/`-deep`/`-glow`）。`UIManager` 给卡片加 `boon-rarity-common|epic|legendary`，`quality.ts` 提供色值/标签。

**品质色三层载体**（QA §11.2 已闭合该风险）——`border-image-source` 非 `none` 时 `border-color` **不绘制**，故品质色由三层独立承载：

| 载体 | CSS | 受 `border-image` 影响 | 采样 |
|---|---|---|---|
| ① 外层 3px 品质环 | `box-shadow: 0 0 0 3px var(--rarity-<q>), 0 0 14px var(--rarity-<q>-glow)` | 否（绘在 border box 外） | ✅ **主锚点**（取内 1–2px 实心带，避 glow 衰减） |
| ② 品质 chip 背景 | `background: var(--rarity-<q>)` | 否 | ✅ 实心块（`.boon-rarity-tag`） |
| ③ 每品质专属框体图 | `border-image-source: var(--ui-frame-boon-<q>)`（品质色**烘进线描**） | 是（色已在图内） | ✅ |

- **降级**：③ 缺失 ⇒ `border-image-source: none` ⇒ `border-color: var(--rarity-<q>)` **正常绘制**实心品质边框（M16 降级路径保持）。
- **非颜色通道（`grayscale(1)` 仍可分，机器可断言）**：`.boon-rarity-tag` `textContent ∈ {普通,史诗,传说}` · `.boon-pips` 子元素数 1/2/3 · `.boon-icon-frame--square|cut|crown` 类名互异。
- **同品质同屏**（U1：`zeus_strike` 与 `dionysus_strike` 同为 Epic）靠 `.boon-icon` 字形 + 名称区分。

> 卡片子钩子（`boon-rarity-tag` / `boon-pips` / `boon-icon` / `boon-icon-frame--*` / `boon-desc`）由 `UIManager` 赋 class，随 `boon-card` 一并输出，供 QA 探针（§11.7）与 DOM 断言（§11.8）采样。

---

## 6. 测试改写方案（套件名对齐 QA S1–S10）

### 6.1 必须**零改动**（冻结契约，`git diff` 为空）

| 套件 | 冻结红线（engineering 必须守住） |
|---|---|
| `tests/ui/ui_skin.test.ts`（21 例） | 10 冻结 class + 5 冻结 id + 6 M16 钩子两侧存在；**F4** `UIManager.ts` 字面 `document.createElement('button')` **≥3**；**F6** 不含 `pixi.js`；F8 `--ui-*: none` ≥11。 |
| `tests/ui/text_readability.test.ts`（9 例） | **T4** `--font-(body\|mono)` **恰 2 个** ⇒ **禁新增任何 `--font-*`**；**T7** `#hud, #keys, #gold {` **连续同序**；T6 不改 `--parchment/--gold/--blood/--stone-dark`；T1/T2 无网络字体。 |
| `tests/render/camera_zoom_*.test.ts`（7）+ `tilemap_art.test.ts` F1–F6 | 场景图 6 契约 |
| `tests/harness/{render_art,camera_zoom}_lossless.test.ts` | 摘要 `f52dfdd4` |
| `tests/performance/*` | 比值口径 |
| `tests/data/*` · `tests/assets/*` | 数据/资产契约。**`licenses.test.ts` 保持零改动**（U2：**不新增任何体积上限断言**）；若美术新增框体资产，**至多**加「存在性 / 非空」断言（非体积上限，可选、非强制）。 |

### 6.2 **扩展**（只增 `it`，不改既有行）与**新增**（QA 定义）

| # | 文件 | 覆盖 | 关键断言要点 |
|---|---|---|---|
| S1 | `tests/ui/hud_model.test.ts` | FR-002/003/004 · SC-001 | 真 sim 驱动已知伤害/冲刺/金币 → 模型读数正确；`hp=0`/`maxHp=0` 边界；`rem=0⇒ready`/`rem=cool⇒cooling`；金币大值不截断 |
| S2 | `tests/ui/hud_persistence.test.ts` | FR-005/006/007 | source-string：`syncHud` 为 `sync` 首行无条件；写-变更护栏存在；`#hud-material` 与诊断 `#hud` 不同元素、读不同数据；新模块不含 `pixi.js` |
| S3 | `tests/ui/boon_presentation.test.ts` | FR-011/012/013/017/034 | 每 `REWARD_POOL` id 可构造卡片；`qualityColor` 三字面量两两不同；`iconToken` ∈ 已知 token 集合（未知则回退默认，**不依赖 `MANIFEST_IDS`**）；缺字段降级不抛；渲染分支不含 `rarity` 字面量 |
| S4 | `tests/ui/boon_description_truth.test.ts` | FR-013/014 · SC-004 | §4.3 双通道（交叉校验 + 真 sim 行为）；反空真；整数 `toBe` |
| S5 | `tests/ui/status_panel_model.test.ts` | FR-021/023/024 · SC-005 | 集合恰等（升序）；空状态明确；50 条可滚动不截断 |
| S6 | `tests/ui/tab_no_pause.test.ts` | FR-022 · SC-006 | 面板开/关两条轨迹逐 Tick 摘要相同；`togglePanel` 签名不含 `World`/`GameSimulator`、不含 `.step(`/`inject(`/`addComponent(`；反空真（`tick===TICKS ∧ entityCount>0`） |
| S7 | `tests/ui/boon_table_integrity.test.ts` | FR-030/031/035/036 · SC-003/007 | 表键 == `REWARD_POOL` id（双向）；`src/**` 不 import `boons.json`；固定 seed 抽取不变（品质不参与随机） |
| S8 | `tests/ui/ui_degradation.test.ts` | FR-050 · SC-010 | 注入「只坏一个 UI 资产」loader ⇒ `degradedIds()` 恰为该一个；降级下模型仍产出可用结果 |
| S9 | `tests/ui/ui_accessibility.test.ts` | FR-051/052 · SC-011/015 | 新 CSS 无 `@font-face`/字体扩展；新可交互元素是真 `<button>` 且被 `:focus-visible` + `outline:3px` 覆盖 |
| S10 | `tests/ui/ui_skin.test.ts`（**追加 `it`**） | FR-042 · SC-012 | M19 新钩子（`hud-*`/`boon-card`/`boon-rarity-*`/`status-*`）在 `index.html` 与 `UIManager.ts` **两侧**存在；10+5+6 冻结钩子仍在 |

> 新增 10 套件（含 S10 追加），用例总数**远超 948 下限**；两个既有 UI 文件 `git diff` **为空**（QA §1.4）。

### 6.3 本方案增补的静态守卫（工程侧，与 QA 互补）

`tests/ui/ui_readonly_guard.test.ts`（新）：静态扫描 `client/ui/*.ts` 与 `client/UIManager.ts`，断言：
- 不含 `pixi.js` / `howler` / `Container` / `Graphics`；
- 不含 §3.3 的写 API 字面量（`addComponent(`/`applyDamage(`/`applyStatusEffect(`/`.step(`/`.inject(`/`markRunFailed`/`markRunWon`/`markRunHub`/`grantReward(`）；
- 不含 `Math.random` / `Date.now` / `new Date`。

### 6.4 DOM 行为的验证方式（D11）

因测试环境无 jsdom，**不新增 jsdom**。DOM 行为（真实渲染、卡片三要素、Tab 开合、焦点环、降级）用**浏览器探针**（QA §6）验证：

- `production/m19-baseline.md`（改动前基线）· `production/m19-probe.mjs`（复用 `m18-probe.mjs` 骨架）· `production/m19-evidence.md` · 截图 `production/m19-shots/`。
- 视口矩阵（QA §6.1）：1920×1080 / 2560×1440 / 3840×1080 / 1080×1920 / 800×600。
- 探针断言：HUD 非纯文本（SC-001 客观部分）；三卡三要素（SC-002）；品质三色两两 ΔRGB ≥ 60（SC-003/014 客观部分）；Tab 开/关摘要一致（SC-006）；缺资产降级可玩（SC-010）；零外部请求（SC-011）；零 `pageerror`。

---

## 7. 无损与性能验证

### 7.1 无损（SC-006 / SC-007 / SC-008）

| 证据 | 方法 | 期望 |
|---|---|---|
| `src/` 零改动 | `git diff --stat -- src/` + `git status --short -- src/` | **均为空** |
| 快照摘要逐位 | 既有 `tests/harness/render_art_lossless.test.ts` + `camera_zoom_lossless.test.ts`（一行不改且通过）；+ 一次性 `production/m19-digest.mjs` 复核 | **`f52dfdd4`**（seed `0x12345678`、601 tick、FNV-1a over `listEntities()×listComponents()`） |
| 反向依赖 = 0 | `grep -rE "^\s*(import\|export) .*['\"].*client/" src/` | 无匹配 |
| 依赖集合不变 | `package.json` 的 `dependencies` | 恰为 `{howler, pixi.js}` |
| UI 零写 | `tests/ui/ui_readonly_guard.test.ts` + QA S6 | 通过 |
| 面板不改变模拟 | QA S6：`togglePanel` 开/关两条轨迹逐 Tick 摘要对比 | 差异 = 0 |

> **注意**：面板「不暂停」的**结构证明**（`togglePanel` 签名不含 sim、不调 `step`）比「全绿」更强——因为 M15 教训是「全绿但摘要变了」。摘要逐位自证是**唯一**放行依据。

### 7.2 性能（SC-013 / FR-056，QA §5）

- 口径：**交错比值**（同机、同场景、同脚本，连续 3 次中位数），**改动后 / 改动前 ≤ 1.2**。**禁绝对墙钟**（Principle IV）。
- Node 侧：`tests/performance/render_art_cost.test.ts`（预期 ≈1.0，因 M19 只加 DOM）。
- 浏览器侧：`production/m18-probe.mjs` 复用（5 视口 + 压测房）。
- HUD 成本特性：DOM，不在 Pixi 帧预算内；`hudKey` 守卫使**空闲帧零 DOM 写**。压测场景（~150 敌人）下 HUD 只读 3 个标量，O(1)。
- **护栏**：比值 > 1.2 ⇒ 优先怀疑「每帧无条件重建 HUD/Tab DOM」⇒ 回落写-变更/按需重建。

### 7.3 变异实验点（对齐 QA §3，每点：破坏 → 确认失败 → 备份逐字节还原，禁 `git checkout --`）

| # | 门控点 | 破坏 | 预期失败 |
|---|---|---|---|
| M1 | 品质色映射 | `qualityColor()` 恒返回 Common 色 | S3「三色两两不同」 |
| M2 | 描述数值来源 | `boons.json` 的 zeus 描述改成「999 点」 | S4 通道 A |
| M3 | Tab 不暂停 | `togglePanel()` 内部调 `sim.step(1)` | S6 摘要不一致 |
| M4 | 降级回退 | 缺字段分支改为抛错 | S3 的 FR-017 + S8 |
| M5 | 冻结钩子存活 | `UIManager.ts` 的 `is-death` 改名 | `ui_skin` F1 对应行 |

---

## 8. 风险与缓解

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| **体积预算**（FR-053/SC-016） | 新框体资产挤压预算 | **不设 UI 子预算**（用户裁定 ③）：仅受 M18 全局预算（单文件 ≤3 MiB / 总量 ≤12 MiB）约束，保持 advisory；图标**不占资产**（纯 CSS，用户裁定 ⑤）。 |
| **冻结钩子**（FR-042） | 重构误改名/删 `is-*`/`reward-button` | D6：`UIManager` 保留全部冻结 + 新增字面量；`ui_skin.test.ts` 零改动 + 变异 M5 证明守卫是活的 |
| **描述漂移**（FR-014/SC-004） | 表现层复制数值 | §4 单一来源 + S4 双通道 + 变异 M2 |
| **色盲可辨**（SC-014） | 仅靠蓝/紫/金 | §5.4 六通道编码 + `grayscale(1)` 验收 |
| **品质色被 `border-image` 覆盖**（QA §11.2） | 品质色仅落 `border-color` 会被白描 `border-image` 盖住、采样采到近白 | **已闭合**：三层载体（外层 `box-shadow` 品质环 + chip 背景 + 专属框体图），前两层恒绘制、恒可采样（§5.4）。 |
| **Tab 监听生命周期**（FR-025） | 终局/营地/销毁后残留监听 | D7：边沿式 attach/detach（镜像 `handleHubKey`）；`destroy()` 强摘 |
| **Tab 与键盘可达冲突**（FR-052） | 覆盖层内 Tab 被面板拦截 | D7：**有覆盖层时不拦截 Tab**（仅 PLAYING 且无覆盖层时接管 + `preventDefault`） |
| **面板与覆盖层互斥**（FR-026） | 三选一打开时 Tab 又开面板 | 优先级链：terminal > hub > draft > panel（art §6 / QA §11.3） |
| **`dionysus_strike` 数值缺口** | 误以为所有祝福都在 `modifiers.json` | §4.1：先 `hasModifier` 再取；DoT 走 `POISON_STATUS_SPEC`；S4 显式覆盖 |
| **表现表混入逻辑加载** | 后来者把 `boons.json` 加进 `src/data/bundled.ts` | D2 位置隔离 + §3.3 只读守卫 + S7 断言 + 代码评审 |
| **无 jsdom 导致 DOM 无法单测** | 试图在 node 实例化 UIManager | D11：纯模型/DOM 物理分离；DOM 用探针验证 |
| **source-string 测试脆弱**（QA R1） | 正则/字面量耦合易误伤 | 优先抽纯模型把断言移到行为；字符串断言只用于真契约；红线（F4/T4/T7/F6）写入本交接单 |
| **新增套件加剧 `stress.test.ts` G2 flaky**（QA R3） | 新套件抬高并发负载 | 新套件保持短足迹；G2 为既有已知负载敏感，验收报告区分「功能缺陷」与「负载敏感」 |

---

## 附录 A · 文件改动汇总

**新增（7）**
`client/assets/boons.json` · `client/ui/boon-catalog.ts` · `client/ui/quality.ts` · `client/ui/boon-presentation.ts` · `client/ui/hud-model.ts` · `client/ui/status-panel.ts` · 测试 10 套件（QA S1–S10）

**修改（3–4）**
`client/UIManager.ts` · `client/main.ts` · `index.html` · （可选）`client/assets/manifest.ts`（**仅框体资产，不含图标**——用户裁定 ⑤）

**`src/` 修改：0**（硬约束）

## 附录 B · 五道闸门（合并前必须全绿）

`npm test`（N ≥ 948，两个既有 UI 文件 `git diff` 为空）· `npm run typecheck` · `npm run typecheck:client` · `npm run lint` · `npm run build`

## 附录 C · 待用户/评审裁定项

1. ✅ **已裁定（用户 U1）**：rarity = `zeus_strike`=Epic · `dionysus_strike`=Epic · `poseidon_dash`=Legendary · `hp_up`=Common · `dash_up`=Common。
2. ✅ **已闭合（QA §11.2 / art §2.4）**：品质色**三层载体**——① 外层 3px `box-shadow` 品质环（主采样锚点）+ ② 品质 chip 背景 + ③ 每品质专属框体图（`--ui-frame-boon-*`）；③ 缺失回退 `border-color`。SC-003 像素判据成立（采样取 ① 内实心带或 ② chip 块）。
3. ✅ **已裁定（用户 U2）**：**不设 UI 子预算**，仅 M18 全局预算（≤3 MiB / ≤12 MiB），保持 advisory。
4. ✅ **已裁定（用户 U4）**：采纳「状态差分」驱动 HUD 反馈（理由见 §3.2）。
5. ✅ **已裁定（用户 U3）**：**纯 CSS 占位、不新增图标资产**；`boons.json` 的 `icon` 字段 = **CSS 字形 token**；**取消** `--ui-icon-boon-*`（5 个）与占位资产槽位；`manifest.ts` 不新增图标条目。
