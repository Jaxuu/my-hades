# Phase 1 · Data Model：真实 2D 美术与音效资产接入

**Feature**: `024-real-art-assets` · **Date**: 2026-10-01 · **Source**: [spec.md](./spec.md) 的 5 个关键实体

本模型描述**表现层**的数据结构。全部类型都是**表现层私有**（定义在 `client/assets/**`），**不进入 `src/`**，不进快照，不影响确定性。

---

## E1 · 资产清单条目 `AssetEntry`

规格中的「资产清单（本地）」。清单是**构建期静态生成**的（D2），因此它是代码而不是运行期数据。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | `string` | ✅ | 稳定标识，`kebab-case`，命名空间前缀：`player.*` / `enemy.*` / `tile.*` / `fx.*` / `ui.*` / `sfx.*` |
| `kind` | `'spritesheet' \| 'image' \| 'audio'` | ✅ | 决定加载器与回退路径 |
| `source` | `string` | ✅ | Vite 导入得到的产物 URL |
| `license` | `string` | ✅ | 许可标识（本项目恒为 `CC0-1.0`），指向 `LICENSES.md` 的条目 |
| `fallback` | `'graphics' \| 'silent'` | ✅ | 加载失败时的行为；`graphics` = 退回既有几何占位，`silent` = 静默 |

**校验规则**
- `id` 全局唯一；重复 ⇒ 构建期抛错（清单是模块，重复键在生成时即可检出）。
- `kind === 'audio'` 时 `fallback` 必须为 `silent`。
- 每个 `id` 必须能在 `assets/art/LICENSES.md` 或 `assets/audio/LICENSES.md` 中按 `id` 或 `source` 反查到来源（SC-010 = 100% 可追溯）。

**状态迁移（加载生命周期）**
```
declared ──load()──▶ loading ──ok──▶ ready
                        └──fail──▶ degraded   （该条目回退，其余条目不受影响）
```
`ready` 与 `degraded` 都是**终态**；一旦进入 `degraded` 不再重试（避免每帧重试造成抖动）。

---

## E2 · 玩家角色形象 `PlayerVisual`

规格中的「玩家角色形象」。**不新增数据**，全部字段都是对既有组件的**只读投影**。

| 字段 | 来源（只读） | 说明 |
|---|---|---|
| `spriteId` | 常量 `player.base` | 玩家只有一种形象 |
| `action` | `StateComponent.state`（`ActionState`） | 见 E4 映射 |
| `facing` | `TransformComponent.facingRadians` | 量化到 4 向（`down` / `up` / `left` / `right`） |
| `x` / `y` | `PreviousTransformComponent` ↔ `TransformComponent` 按 `alpha` 插值 | **沿用既有插值**，本特性不改 |
| `hitFlash` | `isFrozen(world,id)` ∨ `state === HITSTUN` | 沿用既有 `HIT_FLASH_TINT` 语义 |
| `isDying` | `isDead(world,id)` | 沿用既有死亡 FX 生命周期 |

**校验规则**
- `facing` 量化必须是**纯函数**且对 `±PI` 接缝稳定（不抖动）。
- `action` 取不到（组件缺失）时回退 `idle`，不抛错。

---

## E3 · 敌人类别形象 `EnemyVisual`

规格中的「敌人类别形象」。核心是 D3 的**能力签名分类器**。

| 字段 | 来源（只读） | 说明 |
|---|---|---|
| `enemyType` | **签名分类器**（见下表） | `grunt` / `elite` / `raider` / `bomber` / `gunner` / `unknown` |
| `spriteId` | `enemy.<enemyType>` | 查 E1 清单 |
| `action` / `facing` / `hitFlash` / `isDying` | 同 E2 | 与玩家同一套投影 |

**签名分类表（冻结，纯函数）**

| 优先级 | 条件（只读组件） | 结果 |
|---|---|---|
| 1 | `PlayerInputComponent` 存在 | （玩家，不走此表） |
| 2 | `ArmorComponent` ∧ `HazardCasterComponent` | `gunner` |
| 3 | `ArmorComponent` ∧ ¬`HazardCasterComponent` | `elite` |
| 4 | ¬`ArmorComponent` ∧ `HazardCasterComponent` | `bomber` |
| 5 | ¬`ArmorComponent` ∧ ¬`HazardCasterComponent` ∧ `AIControllerComponent` | `raider` |
| 6 | 以上皆不满足 | `grunt` |
| 7 | 实体不是战斗单位（无 `FactionComponent`） | `unknown`（不渲染，沿用既有 skip） |

**校验规则**
- 分类必须**完备**：对当前 `assets/data/enemies.json` 的 5 类敌人逐一断言得到正确类型（这是 FR-005 的机器可执行形式）。
- 分类必须**确定性**：同一组件集合恒得同一结果；不得依赖遍历顺序、时间或随机。
- 未命中任何规则 ⇒ `unknown` ⇒ 回退通用敌人形象（不崩溃、不隐形）。

**状态迁移**：`enemyType` 在实体生命周期内**不变**（能力组件在 spawn 时挂载，运行期不增删）⇒ 分类**只在视图创建时计算一次**，不每帧重算。

---

## E4 · 动画状态映射 `AnimationState`

规格中的「动作状态」。**从模拟状态到动画名的纯映射**（`client/assets/sprite-map.ts`）。

| 模拟状态（`ActionState`） | 动画名 | 备注 |
|---|---|---|
| `IDLE` | `idle` | 待机 |
| `MOVING` | `move` | 移动 |
| `DASHING` | `dash` | 冲刺 |
| `ATTACKING` | `attack` | 攻击 |
| `HITSTUN` | `hit` | 受击 |
| `DEAD` | `death` | 死亡（配合既有淡出/缩小 FX） |

**映射规则**
- 未知/缺失状态 ⇒ `idle`（**总函数**，无 `undefined` 分支）。
- 动画名与朝向正交组合成纹理键：`<spriteId>.<action>.<facing>`；缺失该组合时回退到 `<spriteId>.<action>.down`，再缺失回退 `<spriteId>.idle.down`。
- 动画**不改变**任何模拟状态；播放进度由真实帧 delta 驱动（D4）。

---

## E5 · 局内特效与掉落物资产 `FxVisual`

规格中的「局内特效与掉落物资产」。

| 元素 | 来源（只读） | 资产 |
|---|---|---|
| 命中火花 | `HitEvent`（既有 `ClientEventBridge`） | `fx.spark`（Particle Pack） |
| 冲刺拖尾 | `DashEvent` | `fx.dash-trail` |
| 危险预警 | `HazardComponent.delayTicks / totalDelayTicks` | `fx.hazard-ring`（**进度仍由组件驱动**，本特性不改逻辑） |
| 伤害数字 | 既有 `detectDamage` 的 HP 下降沿 | 字体样式化（D7） |
| 掉落物 `GOLD` | `PickupComponent.kind` | `ui.icon.gold` |
| 掉落物 `HEAL` | `PickupComponent.kind` | `ui.icon.heal` |
| 掉落物 `DARKNESS` | `PickupComponent.kind` | `ui.icon.darkness` |

**校验规则（对应 FR-017 的「不可混淆」）**
- `GOLD` / `HEAL` / `DARKNESS` 三者的图标在**去色**后仍两两可区分（形状差异，非仅色相差异）。
- 「应拾取」（掉落物）与「应躲避」（危险预警）在**形状语言**上必须不同类（圆润 vs 尖锐/环状），不依赖颜色。

---

## E6 · 界面资产集 `UiAsset`

规格中的「界面资产集」。界面是 DOM（D5），因此槽位以 **CSS 类钩子**为契约（详见 [contracts/ui-asset-slots.md](./contracts/ui-asset-slots.md)）。

| 界面面 | 现有类钩子 | 资产槽位 |
|---|---|---|
| HUD 数值 | `#hud` / `#gold` | `ui.panel.hud` · `ui.font.display` |
| 奖励三选一 | `#ui-layer.is-visible` · `.reward-button` | `ui.panel.reward` · `ui.frame.reward-card` |
| 死亡 | `#ui-layer.is-death` · `.death-hint` | `ui.overlay.death` |
| 胜利 | `#ui-layer.is-win` | `ui.overlay.win` |
| 营地 | `#ui-layer.is-hub` · `.hub-currency` · `.hub-talents` · `.talent-button` · `.start-button` | `ui.panel.camp` · `ui.frame.talent-card` · `ui.button.primary` |

**校验规则**
- 类钩子集合 MUST 是既有集合的**超集或等集**：`UIManager` 的逻辑不因重皮而改变（D5）。
- 每个界面面在资产缺失时仍**可点击、可辨识**（回退到纯 CSS 面板）。

---

## E7 · 许可登记 `LicenseRecord`

规格中的「资产许可登记」（SC-010 的载体）。

| 字段 | 说明 |
|---|---|
| `assetId` | 对应 E1 的 `id`（或资产包级通配） |
| `packName` | 来源素材包名（如 `Roguelike/RPG pack`） |
| `author` | 作者（如 `Kenney`） |
| `sourceUrl` | 来源 URL（OpenGameArt / kenney.nl） |
| `license` | 许可标识（`CC0-1.0`） |
| `modifications` | 本项目做过的处理（裁剪 / 图集化 / 重着色），如实记录 |

**校验规则**
- 清单中每个 `id` MUST 能反查到一条记录（**100% 可追溯**，SC-010）。
- `license` MUST 属于允许再分发的白名单（`CC0-1.0` / `public-domain` / 明确允许再分发）；出现 `proprietary` 或未知 ⇒ **构建期拒绝**。
- 文件落盘位置：`assets/art/LICENSES.md`、`assets/audio/LICENSES.md`。

---

## 关系图

```
E1 AssetEntry ──(id)──▶ E2 PlayerVisual
     │                   E3 EnemyVisual ──(E3 分类器, 只读组件)──▶ enemyType
     │                   E5 FxVisual
     │                   E6 UiAsset
     └──(assetId)──▶ E7 LicenseRecord
E4 AnimationState ◀──(ActionState 只读)── E2 / E3
```

## 不变量

1. **表现层私有**：E1–E7 全部定义在 `client/**`，`src/` 不 import 它们。
2. **只读**：E2/E3/E5 的每个字段都来自对既有组件的读取；不存在任何从表现层写回 `World` 的路径。
3. **不进快照**：本模型不进 `snapshot()`，不影响逐位确定性。
4. **总函数**：E3 分类器与 E4 映射对任何输入都有定义（含 `unknown` / `idle` 回退）。
5. **回退可达**：每个资产条目都有 `fallback`，且回退路径是既有、已被 642 例验证的几何/静默路径。
