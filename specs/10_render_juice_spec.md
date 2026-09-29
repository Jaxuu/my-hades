# 10 · Render Juice Spec（渲染插值与视觉打击感）

| Field | Value |
|---|---|
| Spec ID | `SPEC-10-RENDER-JUICE` |
| Milestone | **M5 · 表现层**（T02） |
| Status | `accepted`（本文件为 M5-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `docs/architecture/ADR-002-render-interpolation.md`（新）、`src/ecs/components/PreviousTransformComponent.ts`（新）、`src/ecs/systems/TransformSnapshotSystem.ts`（新）、`src/ecs/systems/pipeline.ts`（改）、`src/ecs/components/index.ts`（改）、`src/ecs/systems/index.ts`（改）、`client/GameRenderer.ts`（改）、`client/GameLoop.ts`（改）、`tests/render/interpolation.test.ts`（新） |
| Depends on | `specs/09_renderer_bridge_spec.md`（`GameRenderer` / `GameLoop` / `PX_PER_UNIT` / 只读契约）、`specs/03_combat_hitbox_spec.md`（`HealthComponent` / `applyDamage`）、`specs/04_combat_feedback_spec.md`（`isFrozen` hitstop）、`specs/02_dash_and_state_spec.md`（`ActionState.HITSTUN`）、`docs/architecture/ADR-001-headless-ecs-foundation.md`（R1–R6）、`docs/architecture/ADR-002-render-interpolation.md`（插值决策） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vite 5 · PixiJS 8.21 · Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

M5-T01 交付了**只读渲染桥**：逻辑世界第一次被投影成像素，键盘输入按拍回流。但它刻意留下了两笔债：

1. **按拍硬同步**（`specs/09` §1.3 / §10 取舍 2）：逻辑帧率与刷新率不整除时画面抖动。
2. **零"打击感"**：画面只会显示几何体，命中没有反馈、掉血没有数字、被冻没有视觉提示。

M5-T02 还这两笔债，且**依然严守只读契约**：

> 一句话总结本 Spec 的判据：**插值只发生在渲染层；打击感只是对逻辑状态的只读观测；逻辑层对这一切一无所知。**

### 1.2 In Scope（做什么）

- **渲染插值**：逻辑层记录上一帧 `TransformComponent`，渲染层按 `alpha ∈ [0,1]` 线性插值位置与朝向（ADR-002）。
- **伤害跳字**：实体 `hp` 下降时，在其渲染坐标上方生成一个上飘淡出的 `-N` 文本，独立视觉生命周期（默认 1000ms）。
- **受击闪烁**：实体被冻结（hitstop）或处于 `HITSTUN` 时，表现层 `container.tint` 变为受击色。
- **新增内核部件**：`PreviousTransformComponent`（POD）+ `TransformSnapshotSystem`（管道第 0 段）。
- **工程接线**：`pipeline.ts` / 两个 barrel / `GameLoop.ts` / `GameRenderer.ts`。
- **新增测试**：`tests/render/interpolation.test.ts`（真实 `GameSimulator` + 真实 PixiJS 场景图，无 jsdom）。
- **既有测试钉桩更新**：5 处管道顺序数组 + 1 处按名字定位的插入点（§8.2）。

### 1.3 Out of Scope（显式排除）

- ❌ **精灵图 / 动画 / 美术资产 / 音效**：仍是几何占位符 + 文本。
- ❌ **摄像机 / 缩放 / 屏幕震动 / 视口跟随**：世界原点即屏幕原点。
- ❌ **伤害数字的美术样式**：字体、描边、缓动曲线只取一个能通过测试的最小实现。
- ❌ **对象池**：跳字与死亡 FX 直接 `new` / `destroy`，规模（≤ 数十）不需要池化。
- ❌ **外推 / 预测插值**：ADR-002 明确否决。
- ❌ **可变步长逻辑**：ADR-002 明确排除。
- ❌ **逻辑层任何"感知渲染"的改动**：`src/` 仍无 DOM / pixi / 像素 / 帧概念（ESLint AST 门强制）。

### 1.4 约束

- C1 **单向依赖（硬，沿用 spec 09 AC-01）**：`client/` 可 import `src/`；`src/` 绝不 import `client/` 或 `pixi.js`。ESLint AST 门强制。
- C2 **`src/` 零运行时依赖（硬）**：`pixi.js` / `vite` 只出现在 `client/` 与根工程配置。
- C3 **渲染层只读（硬，沿用 spec 09 §3.5）**：渲染层不得 `addComponent` / `destroyEntity` / `applyDamage` / 组件字段赋值。跳字与闪烁都只读。
- C4 **插值零污染逻辑（硬，ADR-002 D2）**：`PreviousTransformComponent` 只被 `TransformSnapshotSystem` 写、只被 `client/` 读；**没有任何游戏系统读它**。
- C5 **组件是 POD（硬）**：`ComponentBase` 子类只准有数据字段，禁止任何方法（含便捷方法）。
- C6 **系统形如 `class X implements System { readonly name; update(world, ctx) }`（硬）**：禁止跨 Tick 隐藏状态（`TransformSnapshotSystem` 的全部状态都在组件上）。
- C7 **类型安全（硬）**：`client/**` 与 `src/**` 满足 `strict`；禁 `any` / 非空断言 `!` / `@ts-ignore`；类型导入用 `import type`。
- C8 **时间只来自 `sim` 或 ticker（硬）**：逻辑步长只用 `sim.tickDurationMs`（禁 `16.67` / `1/60`）；纯视觉生命周期用 `app.ticker.deltaMS`，**不得回流逻辑**。
- C9 **浮点断言容差 `1e-9`（硬）**：唯一例外见 AC-01 —— 该处要求**精确相等**（`=== 5.0`），因为它刻意绕开了速度积分误差。

---

## 2. 术语与契约

| 术语 | 定义 |
|---|---|
| **上一帧状态（Previous Transform）** | `PreviousTransformComponent`：某实体在本 Tick **开头**的 `TransformComponent` 拷贝。 |
| **插值系数（`alpha`）** | `∈ [0,1]`。`0` = 画上一拍，`1` = 画当前拍。语义 = 累加器余数 / 拍时长。 |
| **跳字（Damage Floater）** | `hp` 下降时生成的 `-N` 文本；上飘 + 淡出，独立视觉生命周期。 |
| **受击色（Hit Flash）** | 冻结 / `HITSTUN` 时 `container.tint` 的值；否则为 `NO_TINT`。 |
| **FX 层（`fxLayer`）** | 渲染根下专用于瞬时特效（跳字）的容器，始终是根的**最上层子节点**。 |
| **惰性挂载（Lazy Mount）** | 首次见到某实体时，`TransformSnapshotSystem` 以当前 `Transform` 播种其 `PreviousTransformComponent`。 |
| **最短弧（Shortest Arc）** | 角度插值时把 `to - from` 归一化到 `[-π, π]`（两端都闭），避免跨 ±π 绕远。`-π` 与 `π` 表示同一朝向（相差 `2π`），故两端都闭不影响正确性。 |

---

## 3. 数据契约

### 3.1 `PreviousTransformComponent`（POD）

| 字段 | 类型 | 含义 |
|---|---|---|
| `prevX` | `number` | `TransformComponent.x` 在本 Tick 开头的值 |
| `prevY` | `number` | `TransformComponent.y` 在本 Tick 开头的值 |
| `prevFacingRadians` | `number` | `TransformComponent.facingRadians` 在本 Tick 开头的值 |

- 构造函数默认值全为 `0`。
- **禁止任何方法**（C5）。所有写入由 `TransformSnapshotSystem` 完成。

### 3.2 `TransformSnapshotSystem`

- `name = 'TransformSnapshotSystem'`。
- 管道位置：**index 0**（`createDefaultSystems()` 返回数组的第 0 位，先于 `PlayerControllerSystem`）。
- 行为：遍历 `world.query(TransformComponent)`（升序），取 `PreviousTransformComponent`：
  - **不存在** ⇒ 惰性挂载 `new PreviousTransformComponent(t.x, t.y, t.facingRadians)`；
  - **存在** ⇒ 硬拷贝三字段。
- `createDefaultSystems(events?, deathEvents?)` 签名**不变**。

### 3.3 渲染层持有的常量契约

| 常量 | 值 | 含义 |
|---|---|---|
| `PX_PER_UNIT` | `10` | 世界单位 → 像素（沿用 spec 09 C8，仍是渲染层唯一常量契约） |
| `FLOATING_TEXT_LIFETIME_MS` | `1000` | 跳字视觉生命周期 |
| `FLOATING_TEXT_OFFSET_PX` | `22` | 跳字相对实体渲染原点的上移量 |
| `FLOATING_TEXT_RISE_PX` | `28` | 跳字在生命周期内的总上飘距离 |
| `NO_TINT` | `0xffffff` | 无 tint（乘白 = 恒等） |
| `HIT_FLASH_TINT` | `0xff0000` | 受击色（见 §10 取舍 3） |

---

## 4. 行为规格

### 4.1 渲染插值（AC-01）

`GameRenderer.syncWorld(world, alpha = 1)`：

- `alpha` 先 clamp 到 `[0, 1]`。
- 对每个非死亡视图，读 `TransformComponent`（记 `curr`）与 `PreviousTransformComponent`（记 `prev`；**缺失则 `prev := curr`**）：
  - `renderX = prevX + (currX - prevX) * alpha`
  - `renderY = prevY + (currY - prevY) * alpha`
  - `renderFacing = prevFacing + shortestArcDelta(prevFacing, currFacing) * alpha`
- `container.x = renderX * PX_PER_UNIT`，`container.y = renderY * PX_PER_UNIT`，`container.rotation = renderFacing`（不翻转符号，沿用 spec 09 §3.2）。

**`alpha` 默认 `1` 的理由（刻意）**：`alpha = 1 ⇒ renderX = currX`，逐位等价 M5-T01 行为，故冻结的 `tests/render/renderer_bridge.test.ts`（单参调用）无需改动即通过（见 §10 取舍 2）。

### 4.2 伤害跳字（AC-02）

- `EntityView` 增加 `lastHp: number | undefined`；**视图创建时**初始化为当前 `HealthComponent.hp`（避免第一帧误报）。
- 每次 `syncWorld` 读 `HealthComponent.hp`：
  - 若 `lastHp !== undefined && hp < lastHp` ⇒ 生成跳字，数值 = `-(lastHp - hp)`，文本形如 `-10`；位置 = 该实体**本帧渲染坐标**上方（`container.y - FLOATING_TEXT_OFFSET_PX`）。
  - 随后 `lastHp = hp`。
- 跳字挂在 `fxLayer` 上，用**真实帧时间**（`app.ticker.deltaMS`）推进上飘 + 淡出；`elapsedMs >= 1000` 时 `destroy()` 并移出内部列表。
- **跳字不得回流逻辑层**：它只读组件、只读 ticker，绝不 `sim.step` / 写组件。

### 4.3 受击闪烁（AC-03）

- 每次 `syncWorld` 对每个非死亡视图计算：
  `hit = isFrozen(world, id) || (StateComponent?.state === ActionState.HITSTUN)`
- `view.container.tint = hit ? HIT_FLASH_TINT : NO_TINT`。
- **不新增系统、不改逻辑层**——只读观测。

### 4.4 FX 层与渲染根

- `fxLayer` 在 `init()` 中 `root.addChild(fxLayer)`，并**始终保持为 root 的最上层子节点**。
- 实体视图用 `root.addChildAt(view, root.children.length - 1)` 插到 `fxLayer` **之下**，从而：
  1. FX 永远画在实体之上；
  2. 实体视图保持升序 id 的 `children[0], [1], …` 顺序（M5-T01 冻结的索引契约）。
- `destroy()` 靠 `root.destroy({ children: true })` 递归清理 `fxLayer` 与全部跳字。

---

## 5. 边界与错误

| 情形 | 行为 |
|---|---|
| `alpha` 传入 `> 1` / `< 0` | clamp 到 `[0, 1]`（不外推） |
| `alpha` 为 `NaN` | 由调用方保证传入有限值（`GameLoop` 只会传 `[0,1]` 内的有限值） |
| 实体无 `PreviousTransformComponent` | 回退 `prev := curr`（渲染停在当前位置） |
| 实体无 `HealthComponent` | `lastHp = undefined`，永不生成跳字 |
| `hp` 上升（治疗） | 不生成跳字；`lastHp` 照常更新 |
| `hp` 一步降到 `0`（致死） | 生成一次跳字（`-(lastHp - 0)`）——致死一击也应有数字 |
| 实体在本帧被销毁 | 视图被 `recycleDestroyed` 回收；其跳字独立存在，按自身生命周期结束 |
| 实体已退役（`retired`） | 不重建视图，也不生成跳字 |

---

## 6. 逐帧 / 逐 Tick 时序契约

### 6.1 逻辑层（`TransformSnapshotSystem` 相对位置）

```
tick T 开始
  → TransformSnapshotSystem   (index 0)  prev := curr（记录"T 开头"的位置）
  → PlayerControllerSystem    (index 1)  ...
  → MovementSystem / DashSystem / ...    （唯一允许改 curr 的阶段）
  → LifespanSystem            (index 13) 仍然 LAST
tick T 结束（curr 已是"T 结束"的位置）
```

**铁律**：`TransformSnapshotSystem` 必须是第 0 段。任何位移写入都发生在其后，故 `prev` 恒为"T 开头"、`curr` 恒为"T 结束"。若把它放到位移系统之后，插值将介于两个"已移动点"之间，抖动重现。

### 6.2 渲染层（`GameLoop` 每帧）

```
Ticker(deltaMS) → accumulator += deltaMS
  → [追帧循环] flush(sim) → step(1)   （≤ MAX_STEPS_PER_FRAME 次）
  → 溢出则 accumulator = 0
  → alpha = clamp(accumulator / tickDurationMs, 0, 1)
  → GameRenderer.syncWorld(world, alpha)
       ├─ ① 建缺失视图（插到 fxLayer 之下）
       ├─ ② 同步 Transform（插值）+ 受击闪烁
       ├─ ③ 推进既有跳字（ticker.deltaMS）
       ├─ ④ 生成新跳字（检测 hp 下降）
       ├─ ⑤ 推进死亡 FX 并回收/退役
       └─ ⑥ 清理已销毁实体
  → PixiJS 渲染
```

**顺序铁律**：③ 必须在 ④ 之前——先老化旧跳字，再生成新跳字，这样新跳字在诞生帧保持 `alpha = 1`（不白白损失一帧寿命）。

---

## 7. 验收判据（Acceptance Criteria）

| ID | 陈述 | 判据 |
|---|---|---|
| **AC-01** | **平滑插值**：`syncWorld(world, alpha)`，`alpha ∈ [0,1]`（越界 clamp）；`renderX = prevX + (currX - prevX) * alpha`，Y 同理；`rotation` 由 `prevFacingRadians` / `facingRadians` 插值。 | 探针把实体从世界 `(0,0)` 移到 `(1,0)`（= 10 px），断言 `container.x === 0`（alpha 0）、`=== 5.0`（alpha 0.5，**精确相等**）、`=== 10`（alpha 1）；`alpha = 2` / `-1` 不越界。 |

> **AC-01 有两个可观测口径（在 `PX_PER_UNIT = 10` 下必须区分）**：
> - **世界单位口径**：位移 **10 世界单位**、`alpha = 0.5` ⇒ 渲染坐标中点 = **50 px**（即 `10 × 0.5 × PX_PER_UNIT`）。证据：`tests/render/interpolation.test.ts` → `AC-01: interpolation preserves the PX_PER_UNIT contract (10 world units => 50 px at the midpoint)`。
> - **像素口径**：`alpha = 0.5` 时容器 X 恰为 `prevPx + (currPx − prevPx) × 0.5`；在 `prev = 0`、`curr = 10 px`（即 1 世界单位）时**精确等于 `5.0`**。证据：`tests/render/interpolation.test.ts` → `AC-01: blends prev -> curr by alpha (exactly 5.0 at the midpoint)`。
>
> 两口径互斥但互补：任务书散文里的「`(0,0) → (10,0)`」与「`container.x === 5.0`」在 `PX_PER_UNIT = 10` 下不可能同时成立；上表判据取像素口径，新增用例覆盖世界单位口径，二者合起来才是完整的 AC-01 覆盖。
| **AC-02** | **伤害跳字**：渲染层观测到 `hp` **下降**时，在实体渲染坐标**上方**生成上飘数字（形如 `-10`），独立视觉生命周期（默认 1000ms）后淡出销毁；用真实帧时间推进，不回流逻辑层。 | `applyDamage(world, id, 10)` 后 `syncWorld` ⇒ `fxLayer` 出现 `Text` 且 `.text === '-10'`；`deltaMS = 20` 下 50 帧后该 `Text` 被销毁、`fxLayer` 清空。 |
| **AC-03** | **受击闪烁**：`isFrozen(world, id)` 为真，或 `StateComponent.state === ActionState.HITSTUN` 时，`container.tint` 变受击色；否则复位 `0xffffff`。 | `applyFreeze` 后 `syncWorld` ⇒ `tint === HIT_FLASH_TINT`；冻结过期后再 `syncWorld` ⇒ `tint === NO_TINT`。 |

---

## 8. 测试策略

### 8.1 新增：`tests/render/interpolation.test.ts`

- 复用 `renderer_bridge.test.ts` 的鸭子类型 `Application`（`{ stage, ticker: { deltaMS, add, remove } }`）与"从 `app.stage.children[0]` 取 render root"的取法。
- 用**真实** `GameSimulator`，不 mock 逻辑。
- **用例 A · alpha 混合**：探针系统按名字插入 `TransformSnapshotSystem` 之后，直接写 `transform.x = 1`（避开速度积分误差 `600 × (1/60) = 9.999…`），断言 `container.x` 精确等于 `0` / `5.0` / `10`；并断言 `world.getComponent(id, TransformComponent)!.x === 1`（证明渲染层只读、没写坏逻辑状态）。
- **用例 B · 跳字生成**：`applyDamage` 后 `syncWorld`，断言 `fxLayer` 内出现 `Text` 且 `.text === '-10'`。**只断言 `.text`，禁碰宽高**（PixiJS v8 在无 DOM 下测量文本会抛 `document is not defined`）。
- **用例 C · alpha clamp**：传 `2` / `-1` 不越界。
- **用例 D · 受击闪烁**：`applyFreeze` 后 tint 变受击色；冻结过期后复位 `NO_TINT`。
- **用例 E · 跳字生命周期**：`deltaMS = 20` 下 50 帧后该 `Text` 被销毁、`fxLayer` 清空。

### 8.2 既有测试钉桩更新（管道插入的机械后果，共 6 处）

把 `'TransformSnapshotSystem'` 加到期望数组的**第 0 位**（其余 13 项顺序一字不改）：

| 文件 | 位置 | 变更 |
|---|---|---|
| `tests/combat/feedback.test.ts` | G4 顺序数组 + describe 标题 | 加第 0 位；"13-segment" → "14-segment" |
| `tests/ai/enemy_fsm.test.ts` | G7 顺序数组 + describe 标题 | 加第 0 位；"13-segment" → "14-segment" |
| `tests/ai/enemy_fsm.test.ts` | `makeProbedRig` | 硬编码索引 → 按名字定位 `AISystem` |
| `tests/combat/boons.test.ts` | G7 顺序数组 + describe 标题 | 加第 0 位；"13-segment" → "14-segment" |
| `tests/combat/status_effects.test.ts` | G7 顺序数组 + describe 标题 | 加第 0 位；"13-segment" → "14-segment" |
| `tests/combat/death_and_encounter.test.ts` | G6 顺序数组 + describe 标题 | 加第 0 位；"13-segment" → "14-segment" |

**已确认无需改动**（新系统不触及这些断言）：
- `boons.test.ts:519` / `status_effects.test.ts:721` 的 `expect(sim.snapshot()).toEqual(snapshotBefore)` 直接调 `modifiers.update()`、不经 `sim.step`，`TransformSnapshotSystem` 不在两次快照之间运行。
- `harness/snapshot.test.ts` 用自带 `MovementSystem` fixture，不碰默认管道。
- `death_and_encounter.test.ts:279` 断言房间单例（无 `TransformComponent`），快照系统不覆盖它。

---

## 9. 追溯（Traceability）

| 来源 | 本 Spec 的落地 |
|---|---|
| ADR-002 R1–R6（插值决策） | §3 / §4.1 / AC-01 |
| ADR-001 R1（`src/` 禁止 DOM / 图形库） | C1 + ESLint `no-restricted-imports` |
| ADR-001 R2（时间只由 `step` 推进） | C8；纯视觉用 ticker.deltaMS，不回流逻辑 |
| ADR-001 R3（禁硬编码 `1/60`） | C8；`GameLoop` 用 `sim.tickDurationMs` |
| ADR-001 R4（状态对外只读） | C3 + §4.2 / §4.3 只读观测 |
| ADR-001 R5（顺序确定） | `TransformSnapshotSystem` 用 `world.query` 升序 |
| spec 09 §1.3 / §10 取舍 2（按拍硬同步的债） | §1.1 / §4.1（插值还债） |
| spec 09 §3.2（`PX_PER_UNIT` / 不翻转符号） | §4.1 沿用 |
| spec 09 §3.3 / §4.4（死亡 FX 与退役） | §4.4 / §6.2（跳字与 `retired` 无冲突） |
| spec 03（`HealthComponent` / `applyDamage`） | §4.2 AC-02 |
| spec 04（`isFrozen` hitstop） | §4.3 AC-03 |
| spec 02（`ActionState.HITSTUN`） | §4.3 AC-03 |

---

## 10. 取舍与已知风险（Known Trade-offs）

1. **角度插值策略 = 最短弧（shortest-arc）**。实现把 `to - from` 归一化到 `[-π, π]`（两端都闭；`-π` 与 `π` 表示同一朝向，相差 `2π`，故不影响正确性）再插值，避免朝向指示线在跨 ±π 时绕远路（例如 `3.0 → -3.0` 只扫 `0.28 rad` 跨过接缝，而非 `6 rad`）。代价：多一次取模运算（可忽略）。备选是朴素线性插值（实现更少一行），但会把"跨接缝绕远"记为已知缺陷——本切片选择消灭它。

2. **`syncWorld` 的 `alpha` 默认值 = `1`**。理由：`alpha = 1 ⇒ renderX = curr`，逐位等价 M5-T01 行为，故 M5-T01 冻结的 `tests/render/renderer_bridge.test.ts`（单参调用）无需改动即通过。代价：任何忘记传 `alpha` 的调用点会退化为"按拍硬同步"（即插值失效但不崩）。收益：向后兼容且失败模式是"退化"而非"错误"。

3. **受击色 `HIT_FLASH_TINT = 0xff0000`（纯红）**。PixiJS `tint` 是**乘法**，只能变暗 / 移色相、不能提亮，因此纯红是同时作用于蓝色玩家圆与红色敌人方块时最醒目、最易读的选择。代价：敌人方块本身偏红，红色 tint 使其更暗红（是"变色"而非"变亮"）。备选白色不可用——`0xffffff` 恰是 `NO_TINT`（乘白为恒等），会与"无 tint"不可区分。

4. **`fxLayer` 位于渲染根最上层**。在 `init()` 中 `root.addChild(fxLayer)`，实体视图一律插到它之下。代价：`createMissingViews` 用 `addChildAt` 而非 `addChild`（多一个索引计算）。收益：跳字永远画在实体之上，且实体视图的 `children[0], [1], …` 升序 id 契约不变（M5-T01 冻结测试依赖它）。

5. **跳字与死亡 FX 各自独立**。二者都用 ticker 的真实帧时间推进，但互不引用：`retired` 只由死亡 FX 路径写入，跳字列表独立清理。代价：一个"致死一击"会同时产生一次死亡 FX 与一个跳字（这是期望行为，不是缺陷）。

6. **逻辑层多一个组件的成本**。`snapshot()` 现在包含 `PreviousTransformComponent`（快照体积增大），且每 Tick 每实体多一次 3 字段拷贝。当前规模可忽略；若未来剖析显示压力，可在 `src/` 侧评估（登记为候选 ADR）。

7. **已知问题（显式登记）：`alpha = NaN` 会静默穿透 clamp，导致实体在渲染层消失**。
   - **现象**：`syncWorld(world, NaN)` 下 `Math.min(1, Math.max(0, NaN))` 返回 `NaN`，随后 `container.x` / `container.y` 被写成 `NaN`，实体在渲染层**静默消失**（不抛错、不告警）。
   - **可达性：当前调用链不可达**。`GameLoop.frame` 计算的是 `Math.min(1, Math.max(0, accumulatorMs / tickDurationMs))`，其中 `accumulatorMs` 与 `tickDurationMs` 均为有限非负值，永不产生 `NaN`。QA 已独立核实。
   - **边界行为对照（QA 实测）**：`Infinity` 被 clamp 成 `1`、`-Infinity` 被 clamp 成 `0`，**只有 `NaN` 会穿透**（`Math.min` / `Math.max` 对 `NaN` 的传播语义）。
   - **建议缓解（尚未实施）**：在 `syncWorld` 入口加一行 `Number.isFinite(alpha)` 防御（不满足则回退到 `1`）。本轮**有意不做**，以避免在已验证的产物上引入变更。
   - **证据**：`tests/render/juice-verify.test.ts` 已用 `expect(Number.isNaN(...)).toBe(true)` 把该行为**固化为回归基线**。

---

## 11. 修订记录（Revision History）

| 版本 | 里程碑 | 变更 | 状态 |
|---|---|---|---|
| `v1.0` | M5-T02 | 初版：渲染插值（`PreviousTransformComponent` + `TransformSnapshotSystem` + 管道第 0 段）、伤害跳字、受击闪烁、`fxLayer`；AC-01 .. AC-03。 | `accepted` |
