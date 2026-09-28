# 01 · Character Controller Spec（基础移动控制）

| Field | Value |
|---|---|
| Spec ID | `SPEC-01-MOVEMENT` |
| Milestone | **M1 · 基础移动控制** |
| Status | `accepted`（本文件为 M1-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/`、`src/ecs/systems/MovementSystem.ts`、`src/ecs/prefabs/PlayerFactory.ts`、`tests/combat/` |
| Depends on | `specs/00_harness_spec.md`（时钟、输入、ECS、Snapshot 契约） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境） |

---

## 1. 目的与范围

### 1.1 目的
在 M0 的确定性 Harness 之上，落地**玩家角色的基础移动控制**：把"玩家推了摇杆"翻译成"实体在世界坐标里位移了多少"，
且该翻译必须**逐 Tick 确定、可回放、与渲染无关**。

本 Spec 是 M1-T01 全部实现与测试的验收依据。

### 1.2 In Scope（做什么）
- 三个组件：`TransformComponent`、`VelocityComponent`、`InputComponent`。
- `MovementSystem`：`Input → Velocity → Transform` 的逐 Tick 运动学积分。
- 输入向量**归一化**，保证斜向移动不超速。
- 玩家实体组装入口 `PlayerFactory.spawn(world, options)`。

### 1.3 Out of Scope（显式排除）
- ❌ 碰撞、地形阻挡、刚体物理（M2+）。
- ❌ 冲刺 / 攻击 / 技能及其按键**消费**逻辑——本 Spec 只**记录**按键状态，不产生行为。
- ❌ 加速度、摩擦、惯性——M1 采用**瞬时速度模型**（有输入即达 `maxSpeed`，无输入即 0）。
- ❌ 渲染、动画、朝向插值、相机跟随。
- ❌ 任何 DOM / Canvas / 图形库（沿用 `specs/00_harness_spec.md` C1）。

### 1.4 约束
- C1 **时间只来自模拟时钟**：`dt` 必须取自 `ctx.fixedDeltaSeconds`，禁止硬编码 `1/60` 或 `16.67`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；不读墙钟、不用 `Math.random`。
- C3 **类型安全**：禁止 `any` 逃逸。
- C4 **复用**：必须复用 `src/core/math.ts` 的向量工具与 M0 的 `GameSimulator` / `World` / `System` 契约，不得另造时钟或 ECS。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **World unit** | 世界坐标的长度单位，与像素无关（渲染层负责换算）。 |
| **maxSpeed** | 实体每秒能移动的最大距离（unit/s）。 |
| **currentSpeed** | 本 Tick 的实际速率（unit/s）；无输入时为 `0`。 |
| **moveVector** | 本 Tick 的**原始**摇杆/方向输入向量，**未归一化**。 |
| **directionVector** | 由 `moveVector` 归一化得到的**单位**方向向量，模长为 `0` 或 `1`。 |
| **facingRadians** | 朝向弧度。`+x` 轴为 `0`，`+y` 方向为 `+π/2`（即 `atan2(y, x)` 约定）。 |
| **持续输入** | `InputComponent` 是**持久状态**：某一 Tick 注入 `move` 后，`moveVector` 在后续 Tick 保持，直到被新的 `move` 覆盖——用于表达"按住方向键"。 |

---

## 3. 组件契约

组件均为 `ComponentBase` 子类（POD，无行为），字段为 `public` 可写数据。

### 3.1 `TransformComponent` — 空间位置与朝向
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `x` | `number` | `0` | 世界坐标 X |
| `y` | `number` | `0` | 世界坐标 Y |
| `facingRadians` | `number` | `0` | 朝向弧度（`atan2(y, x)` 约定） |

### 3.2 `VelocityComponent` — 运动状态
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxSpeed` | `number` | `5` | 最大速率（unit/s），必须 `> 0` |
| `currentSpeed` | `number` | `0` | 本 Tick 实际速率（unit/s） |
| `directionVector` | `Vec2` | `(0,0)` | 单位方向向量 |

### 3.3 `InputComponent` — 本 Tick 输入状态
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `moveVector` | `Vec2` | `(0,0)` | 原始摇杆向量（**持久**，不自动清零） |
| `keysHeld` | `string[]` | `[]` | 当前按下的按键名，**升序**（确定性） |

> `keysHeld` 为 M2 的技能/冲刺预留的输入状态；本 Spec 仅要求"被正确记录"，不要求被消费。

---

## 4. 运动学契约（规范核心）

### 4.1 每 Tick 积分公式（MUST）
```
dir          = normalize(moveVector)                       // 零向量 → (0,0)
moving       = (dir.x !== 0 || dir.y !== 0)
currentSpeed = moving ? maxSpeed : 0
transform.x += dir.x * currentSpeed * fixedDeltaSeconds
transform.y += dir.y * currentSpeed * fixedDeltaSeconds
if (moving) transform.facingRadians = atan2(dir.y, dir.x)
```

### 4.2 归一化（MUST，对应 AC-03）
- `moveVector` 归一化后，`|directionVector| === 1`（零向量除外）。
- **斜向不得超速**：`normalize((1,1)) === (√2/2, √2/2) ≈ (0.7071, 0.7071)`。
- 零向量 `normalize((0,0)) === (0,0)`，且 `currentSpeed === 0`。

### 4.3 零输入（MUST）
`moveVector === (0,0)` ⇒ 坐标**不变**，`currentSpeed === 0`，`facingRadians` **保持不变**（不重置为 0）。

### 4.4 精度要求（MUST）
逐 Tick 积分天然存在浮点舍入，因此：
- 位移断言**必须使用容差 `1e-9`**，**禁止**断言严格相等。
- 实测漂移（`maxSpeed=5`, `fps=60`, 60 Tick）：直线 `8.88e-16`、斜向 `hypot` `5.33e-15`，
  比容差低约 **6 个数量级**，余量充足。

### 4.5 确定性
- 不使用墙钟（`Date.now` / `performance.now`）、不使用 `Math.random`。
- 遍历顺序由 `World.query` 保证（id 升序）。

---

## 5. 系统契约

### 5.1 `MovementSystem` 职责与执行顺序
`name === 'MovementSystem'`。每个 Tick 分两个阶段，顺序固定：

| 阶段 | 动作 |
|---|---|
| **1. bindInput** | 消费 `ctx.input` 事件帧，更新 `InputComponent`：`move` → 覆盖 `moveVector`；`keyDown`/`keyUp` → 维护 `keysHeld`（插入/移除后保持升序） |
| **2. integrate** | 对**同时拥有** `InputComponent` + `VelocityComponent` + `TransformComponent` 的实体，按 §4.1 积分 |

### 5.2 时间来源（MUST，对应 AC-05）
`dt` 必须取自 **`ctx.fixedDeltaSeconds`**（由 `GameSimulator` 注入），**禁止**在系统内硬编码 `1/60` 或 `16.67`。
判据：`fps = 30` 时推进 30 Tick，位移结果必须与 `fps = 60` 推进 60 Tick **一致**。

> 该字段是 M0 契约的**新增项**，已在 `specs/00_harness_spec.md` §6.2 同步登记。

### 5.3 实体过滤与顺序
- 只处理三组件齐备的实体；缺任一组件则跳过，不报错。
- 实体按 `World.query` 返回的 id 升序处理（确定性）。

---

## 6. 实体组装契约

```
PlayerFactory.spawn(world: World, options?: PlayerSpawnOptions): EntityId
```

| 选项 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `x` | `number` | `0` | 初始 X |
| `y` | `number` | `0` | 初始 Y |
| `facingRadians` | `number` | `0` | 初始朝向 |
| `maxSpeed` | `number` | `5` | 最大速率；非有限或 `<= 0` 时抛 `RangeError` |

行为：在 `world` 上创建实体，挂载 `TransformComponent` / `VelocityComponent` / `InputComponent`，返回其 `EntityId`。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 三组件齐备 | 组装后的玩家实体同时拥有 `TransformComponent`、`VelocityComponent`、`InputComponent` | 必达（派发要求） |
| **AC-02** | 逐 Tick 位移正确 | 持续输入 `(1, 0)` 共 **60 Tick**（= 1.0s）后，`x` 位移 **= `maxSpeed × 1.0`**（容差 `1e-9`），`y` 位移为 0，`facingRadians ≈ 0` | 必达（派发要求） |
| **AC-03** | 归一化防超速 | 持续输入 `(1, 1)` 共 60 Tick 后，位移**距离**与 AC-02 的**单向总距离一致**（容差 `1e-9`）；分量各为 `maxSpeed/√2` | 必达（派发要求） |
| AC-04 | 零输入 | 无输入时坐标不变、`currentSpeed === 0`、`facingRadians` 不变 | 补充 |
| AC-05 | 时间来自时钟 | `fps=30` 推进 30 Tick 的位移 ≡ `fps=60` 推进 60 Tick 的位移（容差 `1e-9`） | 补充 |
| AC-06 | 确定性回放 | 同输入序列跑两个独立 Simulator，最终 Snapshot `toEqual` 一致 | 补充 |
| AC-07 | 纯逻辑 | `src/` 无 DOM / 墙钟 / 随机；Vitest 为 node 环境 | 补充 |

> AC-01/02/03 为任务派发明确要求；AC-04~07 为保障前三条可信而设的补充门。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| 未归一化 `moveVector` | 斜向速度为 `√2` 倍，玩家"斜着跑更快" | `normalize()`；AC-03 断言距离而非分量 |
| 硬编码 `1/60` 或 `16.67ms` | 换 fps 后位移错，60 Tick ≠ 1s | 取 `ctx.fixedDeltaSeconds`；AC-05 断言 |
| 用严格相等断言位移 | 浮点舍入导致偶发失败（flaky） | 容差 `1e-9`（§4.4） |
| 每 Tick 清空 `moveVector` | 无法表达"持续按住"，只有单 Tick 位移 | `InputComponent` 为持久状态（§2） |
| 零输入时重置 `facingRadians` | 角色松手后朝向跳回 0 | §4.3 明确保持 |
| 归一化零向量产生 `NaN` | 坐标变 `NaN`，污染整个模拟 | `normalizeVec2` 对零长度返回 `(0,0)`（已在 `src/core/math.ts` 保证） |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**：`tests/combat/movement.test.ts`（AC-01…AC-06）；AC-07 由 CI 静态门 + `npm run typecheck` 覆盖。
- **本 Spec → 实现**：
  - `src/ecs/components/{TransformComponent,VelocityComponent,InputComponent}.ts`
  - `src/ecs/systems/MovementSystem.ts`
  - `src/ecs/prefabs/PlayerFactory.ts`
- **契约变更登记**：`specs/00_harness_spec.md` §6.2 `SystemContext` 新增 `fixedDeltaSeconds`。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **归一化 vs 模拟量输入**：本 Spec 按 AC-03 采用 `normalize`（数字输入语义，键盘/十字键正确）。
   若 M2 接入**模拟摇杆**并需要保留推力大小（半推慢走），应改为 `clampMagnitude(v, 1)`（仅当 `|v| > 1` 时缩放）——
   届时须修订 AC-03 并补"半推"用例。
2. **输入绑定与运动学同处 `MovementSystem`**：M1 输入简单（仅 move + 按键记录），合并可避免冗余系统。
   当 M2 引入冲刺/技能/按键映射后，应抽取独立的 `InputSystem`，`MovementSystem` 只消费 `InputComponent`。
3. **`directionVector` 为 `Vec2` 对象**：每 Tick 每实体一次小对象分配。M1 规模下可忽略；
   若 M3 性能剖析显示 GC 压力，可改为 `directionX/directionY` 两个标量。
