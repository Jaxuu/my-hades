# Phase 1 · Data Model：实体、字段与校验规则（M19 · `027-hud-boon-ui`）

> 决策见 [`research.md`](./research.md)；接口契约见 [`contracts/`](./contracts/)；验收剧本见 [`quickstart.md`](./quickstart.md)。
> **总原则**：本特性的全部实体都是**表现层只读视图**或**声明式 UI 元数据**。**没有任何实体进入 `World` / `snapshot()`**，也没有任何字段参与模拟。

---

## 1. 实体总览

| # | 实体 | 归属 | 是否进 `World` | 生命周期 |
|---|---|---|---|---|
| E1 | **祝福元数据（BoonMeta）** | `client/assets/boons.json`（表现层数据） | 否 | 构建期固化，进程内只读 |
| E2 | **品质（Rarity）** | 枚举（表现层） | 否 | 常量 |
| E3 | **祝福目录（BoonCatalog）** | 表现层模块 | 否 | 进程内只读（懒加载一次） |
| E4 | **卡面视图（BoonCardView）** | 渲染期派生 | 否 | 每帧按需重建（值比较） |
| E5 | **HUD 视图（HudView）** | 渲染期派生 | 否 | 每帧按需重建（值比较） |
| E6 | **已拥有祝福视图（OwnedBoonView）** | 渲染期派生 | 否 | 每次 Tab 打开时重建 |
| E7 | **只读探针集合（ReadOnlyProbes）** | 逻辑层既有导出 | 否（**只读**） | 不拥有 |
| E8 | **UI 资产槽（UiAssetSlot）** | `--ui-*` 自定义属性 + 清单 | 否 | 构建期固化 |

---

## 2. E1 · 祝福元数据（`client/assets/boons.json`）

```jsonc
{
  "zeus_strike":      { "rarity": "epic",      "icon": "lightning",
                        "description": "攻击命中时在目标处引发 {damage} 点雷电伤害" },
  "dionysus_strike":  { "rarity": "epic",      "icon": "grape",
                        "description": "命中使目标中毒：每 {intervalSeconds} 秒每层 {damagePerStack} 点伤害，最多 {maxStacks} 层" },
  "poseidon_dash":    { "rarity": "legendary", "icon": "trident",
                        "description": "冲刺时在原地引发冲击波，造成 {damage} 点伤害并击退 {knockbackForce}" },
  "hp_up":            { "rarity": "common",    "icon": "heart",
                        "description": "生命上限 +{amount}" },
  "dash_up":          { "rarity": "common",    "icon": "boot",
                        "description": "冲刺冷却 -{reduction} 帧（下限 10）" }
}
```

> 品质分配**已由用户裁定**（U1 · 2026-10-03，采纳技术总监建议）；`icon` 为**纯 CSS 字形 token**（U3，非资产 id）；`description` 中的数值**不是**数据，而是占位符（见 §4）。

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| *(键)* | string | ✅ | MUST 命中 `REWARD_POOL` 的 id 之一 | 与逻辑层祝福目录一一对应 |
| `rarity` | `"common"\|"epic"\|"legendary"` | ✅ | 枚举内 | 蓝 / 紫 / 金；**纯外观** |
| `icon` | string | ✅ | MUST 属于 **CSS 字形 token 白名单** | **纯 CSS 字形 token**（非资产 id）；缺失回退 `◆` |
| `description` | string | ✅ | 非空；可含 `{key}` 占位符 | 描述**模板**，不含字面数值 |

**校验规则**

| # | 规则 | 时机 | 违反后果 |
|---|---|---|---|
| V1 | id 集合 **恰好等于** `REWARD_POOL` 的 id 集合（无悬空 / 无缺失） | **测试期** | 测试失败（D15） |
| V2 | `rarity` 属于枚举 | 测试期 + 运行期降级 | 运行期回退 `common` |
| V3 | `icon` 属于 **CSS 字形 token 白名单** | 测试期 | 测试失败 |
| V4 | `description` 非空且所有占位符键可被解析 | 测试期 | 测试失败 |
| V5 | **`src/**` MUST NOT import `boons.json`** | 测试期 | 测试失败（D1 护栏） |
| V6 | 数据表 MUST NOT 出现在 `src/data/bundled.ts` 的加载列表 | 测试期 | 测试失败 |

> **为什么校验在测试期而非运行期**：宪法规定 `step()` 内零 IO、零校验、零抛错；且表现层 MUST NOT 让游戏崩溃（FR-050）。故「响亮失败」放在测试期，「运行期降级」兜底。

---

## 3. E2 · 品质（Rarity）

| 值 | 中文 | 颜色（草案，见 `design/ui-art-direction.md`） | 多通道标识 |
|---|---|---|---|
| `common` | 蓝 | `--rarity-common` | 单线边框 |
| `epic` | 紫 | `--rarity-epic` | 双线边框 + 角标 |
| `legendary` | 金 | `--rarity-legendary` | 三线边框 + 光晕 + 角标 |

**不变量**：品质**不**出现在任何模拟组件、`snapshot()` 或随机数调用中（FR-016 / FR-031）。三色 MUST 两两可区分（SC-003 / SC-014）。

---

## 4. E4 · 卡面视图（BoonCardView）— 渲染期派生

| 字段 | 来源（只读） | 说明 |
|---|---|---|
| `id` | `findRewardDraft(world).pendingRewards[i]` | 逻辑层已抽出的选项（**UI 不抽取**） |
| `label` | `getRewardDefinition(id).label` | 既有显示名（逻辑层唯一来源） |
| `rarity` | `BoonCatalog.get(id)?.rarity ?? 'common'` | 数据表；缺失降级 |
| `iconGlyph` | `BoonCatalog.get(id)?.icon ?? '◆'` | **CSS 字形 token**；缺失降级为 `◆` |
| `description` | `renderDescription(BoonCatalog.get(id)?.description, resolveNumbers(id))` | 模板 + 只读数值注入 |

**数值注入表（`resolveNumbers`，全部只读）**

| 祝福 | 来源 | 注入键 |
|---|---|---|
| `zeus_strike` | `DataManager.getModifierConfig('zeus_strike')` | `damage`=20, `radius`=1 |
| `poseidon_dash` | `DataManager.getModifierConfig('poseidon_dash')` | `damage`=5, `radius`=3, `knockbackForce`=40 |
| `dionysus_strike` | `POISON_STATUS_SPEC` | `damagePerStack`=4, `intervalSeconds`=0.5, `maxStacks`=5, `durationSeconds`=2 |
| `hp_up` | `HP_UP_AMOUNT` | `amount`=20 |
| `dash_up` | `DASH_UP_COOLDOWN_REDUCTION` | `reduction`=10 |

**不变量**：`description` 中出现的每个数值 MUST 等于逻辑层对应字段的当前值（SC-004）。占位符无法解析时，回退为**不含该数值**的安全描述（绝不渲染 `undefined` / `NaN`）。

---

## 5. E5 · HUD 视图（HudView）

| 字段 | 来源（只读） | 边界 |
|---|---|---|
| `hp` | `HealthComponent.hp`（玩家） | `0 ≤ hp ≤ maxHp` |
| `maxHp` | `HealthComponent.maxHp` | `maxHp = 0` ⇒ 比例按 `0` 处理（不除零） |
| `hpRatio` | `hp / maxHp`（`maxHp=0` ⇒ `0`） | `[0,1]` |
| `dashReady` | `DashStatsComponent.cooldownRemaining === 0` | boolean |
| `dashProgress` | `1 - cooldownRemaining / cooldownTicks`（`cooldownTicks=0` ⇒ `1`） | `[0,1]` |
| `gold` | `readGold(world)` | ≥ 0 |

**不变量**：HUD 视图**只读**（FR-005 / FR-033）；玩家不存在或无组件时，HUD 显示零值而非崩溃（玩家可能在 hub / 终局状态）。

---

## 6. E6 · 已拥有祝福视图（OwnedBoonView）

| 字段 | 来源（只读） |
|---|---|
| `ids` | `ModifierComponent.modifiers`（玩家，已升序去重） |
| 每项的 `label` / `rarity` / `iconId` / `description` | 同 §4 的卡面视图派生（复用同一纯函数） |

**不变量**：面板列出的集合 MUST 等于玩家实际持有的 `modifiers` 集合（SC-005）；空集合 ⇒ 明确空状态（FR-024）。

---

## 7. E7 · 只读探针集合（ReadOnlyProbes）

**本特性允许使用的全部逻辑层读取面**（白名单）：

| 用途 | 探针 |
|---|---|
| 生命 | `HealthComponent`（`getComponent`） |
| 冲刺 | `DashStatsComponent`（`getComponent`） |
| 金币 | `readGold(world)` |
| 已拥有祝福 | `ModifierComponent`（`getComponent`） |
| 三选一选项 | `findRewardDraft(world)?.pendingRewards` |
| 显示名 | `getRewardDefinition(id)` |
| 终局 / 营地 | `isRunFailed` / `isRunWon` / `isInHub` |
| 数值（描述用） | `DataManager.getModifierConfig` / `POISON_STATUS_SPEC` / `HP_UP_AMOUNT` / `DASH_UP_COOLDOWN_REDUCTION` |
| 帧事件（可选反馈） | `ClientEventBridge`（hit / death / dash） |

**禁止面（黑名单）**：`world.addComponent` / `applyDamage` / `grantReward` / `addModifier` / `selectReward`（写）/ `sim.step` / `world.rng` / 任何 `snapshot()` 以外的写路径。**UI 把玩家意图交回组合根，由组合根转成输入事件。**

---

## 8. E8 · UI 资产槽（UiAssetSlot）

沿用 M16 既有 `--ui-*` 槽位并**新增**若干槽（追加，不替换）：

| 槽 | 用途 | 默认 |
|---|---|---|
| `--ui-panel-hud` | HUD 面板九宫格（含**金币牌**复用） | `none` |
| `--ui-frame-health` / `--ui-frame-dash` | 生命条外框 / 冲刺外框 | `none` |
| `--ui-frame-boon-common` / `-epic` / `-legendary` | 品质卡片框体（品质色烘进线描） | `none` |
| `--ui-panel-status` | Tab 面板九宫格 | `none` |
| `--ui-rule` | 铜色分隔线 | `none` |

> **生命填充**为 CSS 换色（三态），**非资产**。**祝福图标无槽位**：用户裁定 U3（纯 CSS 占位，不新增图标资产）⇒ `--ui-icon-boon-*` 与 `--ui-boon-placeholder` **不存在**；图标由 `icon` 字形 token 经 CSS 渲染。新增槽位共 **7 个**，以 [`design/ui-art-direction.md`](../design/ui-art-direction.md) 附录 A 为唯一权威。

**不变量**：任一槽为 `none` ⇒ 纯 CSS 回退（FR-050）；槽位**只增不减**，既有槽位名不变（D8 / FR-042）。

---

## 9. 明确**不引入**的数据

- ❌ **不**新增任何 `src/` 组件、字段或系统。
- ❌ **不**把品质 / 图标 / 描述写入 `World` 或 `snapshot()`。
- ❌ **不**新增随机源；`World.rng` 的调用序列与改动前**逐 Tick 相同**。
- ❌ **不**修改 `REWARD_POOL` / `draftRewards` / `modifiers.json` / `POISON_STATUS_SPEC`。
- ❌ **不**新增运行时依赖。
