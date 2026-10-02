# Contract · 渲染映射（Renderer ↔ Asset Mapping）

**Feature**: `024-real-art-assets` · **Version**: 1.0.0 · **Date**: 2026-10-01

本契约定义「模拟层只读状态 → 精灵与动画」的映射，以及**回退契约**。它是 FR-001…009、FR-017 的机器可执行形式。

---

## 1. 输入（全部只读）

| 输入 | 来源 | 用途 |
|---|---|---|
| `StateComponent.state` | `ActionState` 枚举 | 选动画（E4 表） |
| `TransformComponent.facingRadians` | 弧度 | 量化 4 向 |
| `TransformComponent.x/y` + `PreviousTransformComponent` + `alpha` | 既有插值 | 位置 |
| `PlayerInputComponent` | 存在性 | 区分玩家 |
| `FactionComponent.faction` | 枚举 | 敌/我 |
| `ArmorComponent` / `HazardCasterComponent` / `AIControllerComponent` | 存在性 | 敌人类型签名（E3 表） |
| `HurtboxComponent.radius` | 数值 | 精灵缩放基准 |
| `HazardComponent.delayTicks / totalDelayTicks` | 数值 | 预警进度（**逻辑不变**） |
| `PickupComponent.kind` | 枚举 | 掉落物图标 |
| `DeadTagComponent`（经 `isDead`） | 存在性 | 死亡动画 |

## 2. 输出（表现层私有）

```ts
interface SpriteSelection {
  readonly spriteId: string;      // 清单 id（如 'enemy.gunner'）
  readonly action: AnimationState;// 'idle'|'move'|'dash'|'attack'|'hit'|'death'
  readonly facing: Facing4;       // 'down'|'up'|'left'|'right'
}
```

## 3. 承诺（MUST）

1. **只读**：映射 MUST NOT 调用任何 `World` 写 API，MUST NOT 推进模拟。
2. **总函数**：对任意输入（含组件缺失、未知状态、未知敌人签名）MUST 返回一个可渲染结果或 `undefined`（= 沿用既有 skip），MUST NOT 抛错。
3. **确定性**：同一输入恒得同一输出；MUST NOT 依赖遍历顺序、时间或随机。
4. **朝向平滑**：`facingRadians` → 4 向的量化 MUST 对 `±PI` 接缝稳定，MUST NOT 在临界角度抖动。
5. **敌人类型只读推断**：MUST 使用 E3 的能力签名分类器；MUST NOT 依赖 `src/` 中不存在的类型字段。
6. **回退**：当所选 `<spriteId>.<action>.<facing>` 纹理缺失时，MUST 依次回退 `<spriteId>.<action>.down` → `<spriteId>.idle.down`；当整个 `spriteId` 不可用时，MUST 回退到既有 `Graphics` 几何占位（`createPlayerView` / `createEnemyView` / `createPickupView` / `createHazardView` 的现有实现）。
7. **冻结契约不变**：MUST 保持 F1–F6（`stage` 唯一子节点 = camera；`camera.children[last]` = root；`root.children[last]` = fxLayer；`root.children[0]` = 首个实体视图；无墙时 `camera.children` 长恰 1；空闲时 `fxLayer.children` 长恰 0）。场景纹理 MUST 通过替换 `staticLayer` 的内容实现，MUST NOT 新增常驻节点。
8. **可辨识**：`GOLD`/`HEAL`/`DARKNESS` 三者在**去色**后仍两两可区分（FR-017）；「掉落物」与「危险预警」的形状语言 MUST 不同类。

## 4. 敌人类型签名（冻结表，与 data-model E3 一致）

| 条件 | 类型 |
|---|---|
| `ArmorComponent` ∧ `HazardCasterComponent` | `gunner` |
| `ArmorComponent` ∧ ¬`HazardCasterComponent` | `elite` |
| ¬`ArmorComponent` ∧ `HazardCasterComponent` | `bomber` |
| ¬`ArmorComponent` ∧ ¬`HazardCasterComponent` ∧ `AIControllerComponent` | `raider` |
| 其余（非玩家战斗单位） | `grunt` |
| 无 `FactionComponent` | `unknown`（不渲染） |

## 5. 违例判定

| 场景 | 期望 |
|---|---|
| 用 `spawnCombatant` 生成 5 类敌人，逐一断言分类结果 | 5/5 正确 |
| 用 `spawnElite(world, 'grunt')` 生成精英 | 分类为 `elite` |
| 构造一个带未知签名的敌方战斗单位 | 回退通用形象，不抛错 |
| 把 `assets/art/atlas/enemies.*` 换成损坏文件 | 敌人回退几何方块，其余美术正常（SC-007） |
| 运行既有 `tests/render/*` 全套 | 一行不改，全部通过（承诺 7） |
| 断点删除 `src/` 任一文件后跑 `git diff --stat src/` | 空输出（FR-014/015） |

## 6. 已知限制

- **非 `grunt` 的精英变体不单独区分**：分类器以**基础类型**为准。`spawnElite(world, 'gunner')` 的签名为 `armor + hazard` ⇒ 判定为 `gunner`，**不会**呈现为 `elite`；`elite` 仅在「有 `ArmorComponent`、无 `HazardCasterComponent`」时命中（即 `spawn('elite')` 与 `spawnElite(world, 'grunt')`）。
  这是**刻意**的：FR-005 要求覆盖「数据表中声明的敌人类别」，而「精英化」是同一类别上的一个变体修饰，不是新类别。若将来需要区分，应在 `sprite-map.ts` 增加一条更高优先级的映射（表现层改动，符合宪法 V），MUST NOT 为此在 `src/` 加类型标签。
- **签名分类表是冻结的**：新增敌人类别若产生新签名组合，需同步扩展 §4 表；未覆盖时回退通用形象（不崩溃、不隐形），由 `tests/assets/sprite-map.test.ts` 的兜底断言守护。
