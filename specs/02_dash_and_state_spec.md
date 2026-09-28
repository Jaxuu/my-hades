# 02 · Dash & Action-State Spec（冲刺与动作状态机）

| Field | Value |
|---|---|
| Spec ID | `SPEC-02-DASH-STATE` |
| Milestone | **M1 · 基础移动控制**（T02） |
| Status | `accepted`（本文件为 M1-T02 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/{StateComponent,DashStatsComponent,TagComponent,InputComponent,VelocityComponent}.ts`、`src/ecs/systems/{MovementSystem,DashSystem,StateSystem,pipeline}.ts`、`src/ecs/prefabs/PlayerFactory.ts`、`tests/combat/` |
| Depends on | `specs/00_harness_spec.md`（时钟/输入/ECS/Snapshot 契约）、`specs/01_character_controller_spec.md`（移动控制器，rev.2 限幅） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境） |

---

## 1. 目的与范围

### 1.1 目的
在 M1-T01 的基础移动之上，落地**冲刺（Dash）**与**动作状态机（Action State Machine）**：
把"玩家按了冲刺键"翻译成"实体在若干固定 Tick 内以更高速度沿锁定方向位移，且前段无敌"，
并保证该过程**逐 Tick 确定、可回放、与渲染无关**。本 Spec 是 M1-T02 全部实现与测试的验收依据。

### 1.2 In Scope（做什么）
- 动作状态机 `ActionState`（`IDLE` / `MOVING` / `DASHING`）与其载体 `StateComponent`。
- 冲刺参数组件 `DashStatsComponent`（倍率 / 持续 / 无敌 / 冷却）。
- 字符串标签组件 `TagComponent` + 自由函数 `addTag` / `removeTag` / `hasTag`（无敌标签）。
- `DashSystem`：冲刺进入、方向锁定、无敌窗口、冷却。
- `StateSystem`：状态推进与退出。
- `MovementSystem` 扩展：`DASHING` 时按锁定方向与冲刺速度积分，**不受输入转向影响**。
- 规范管道 `createDefaultSystems()`：`MovementSystem → DashSystem → StateSystem`。
- `InputComponent.buttonDash` 与 `VelocityComponent.speedMultiplier` 两个新字段。
- `PlayerFactory` 组装扩展。

### 1.3 Out of Scope（显式排除）
- ❌ 伤害结算 / 命中判定 / 无敌帧的实际消费——本 Spec 只**维护**无敌标签，不消费（M2+）。
- ❌ 冲刺动画、残影、音效、屏幕震动等表现层。
- ❌ 冲刺消耗资源（耐力 / 充能次数）——本 Spec 仅固定 Tick 冷却。
- ❌ 多段冲刺、冲刺取消（cancel）、冲刺攻击。
- ❌ 任何 DOM / Canvas / 图形库（沿用 `specs/00_harness_spec.md` C1）。

### 1.4 约束
- C1 **时间只来自模拟时钟**：所有积分取 `ctx.fixedDeltaSeconds`，**禁止**硬编码 `1/60` / `16.67`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；不读墙钟、不用 `Math.random`。
- C3 **类型安全**：禁止 `any` 逃逸、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法
  （标签操作以**自由函数**提供，见 §3.3）。
- C5 **无跨 Tick 隐藏状态**：系统不得持有隐藏状态（spec 00 §6.1）；计时一律落在组件字段上。
- C6 **复用**：必须复用 `src/core/math.ts` 与 M0/M1-T01 的 `GameSimulator` / `World` / `System` 契约。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **ActionState** | 实体的动作状态枚举：`IDLE`（静止）/ `MOVING`（移动）/ `DASHING`（冲刺中）。 |
| **ticksInState** | 在当前状态内已度过的 Tick 数；每次状态切换归 `0`。 |
| **DASHING** | 冲刺状态；持续固定 Tick 数，期间方向锁定、速度放大、前段无敌。 |
| **锁定方向** | 冲刺开始时由当前 `facingRadians` 计算出的单位向量 `(cos θ, sin θ)`，冲刺期间不再改变。 |
| **无敌窗口** | 冲刺起始的前 `invulnerableTicks` 个 Tick，实体携带 `Invulnerable` 标签。 |
| **冷却** | 两次冲刺之间必须间隔的 Tick 数（自上次冲刺**开始**计）。 |
| **speedMultiplier** | `VelocityComponent` 上作用于 `maxSpeed` 的临时倍率；常态为 `1`。 |
| **按钮按下（buttonDash）** | 由 `keysHeld` 派生的持久布尔，表示冲刺键当前是否按住。 |
| **规范管道** | 每 Tick 固定的系统执行顺序：`MovementSystem → DashSystem → StateSystem`（硬契约）。 |

---

## 3. 组件契约

组件均为 `ComponentBase` 子类（POD，无行为），字段为 `public` 可写数据。

### 3.1 `StateComponent` — 动作状态机数据
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `state` | `ActionState` | `ActionState.IDLE` | 当前动作状态 |
| `ticksInState` | `number` | `0` | 当前状态已持续 Tick 数 |

`ActionState` 为字符串枚举：`IDLE = 'IDLE'`、`MOVING = 'MOVING'`、`DASHING = 'DASHING'`。

### 3.2 `DashStatsComponent` — 冲刺参数
导出常量：
| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_DASH_SPEED_MULTIPLIER` | `3` | 冲刺速度倍率（相对 `maxSpeed`） |
| `DEFAULT_DASH_DURATION_TICKS` | `15` | 冲刺持续 Tick 数（@60fps = 0.25 s） |
| `DEFAULT_DASH_INVULNERABLE_TICKS` | `12` | 冲刺前段无敌 Tick 数（@60fps = 0.2 s） |
| `DEFAULT_DASH_COOLDOWN_TICKS` | `30` | 冲刺冷却 Tick 数（@60fps = 0.5 s） |

字段（默认依次为 `3 / 15 / 12 / 30 / 0`）：
| 字段 | 类型 | 说明 |
|---|---|---|
| `speedMultiplier` | `number` | 冲刺速度倍率 |
| `durationTicks` | `number` | 冲刺持续 Tick 数 |
| `invulnerableTicks` | `number` | 前段无敌 Tick 数（`<= durationTicks`） |
| `cooldownTicks` | `number` | 冷却长度（Tick） |
| `cooldownRemaining` | `number` | 剩余冷却 Tick；`0` 表示可冲刺 |

### 3.3 `TagComponent` — 字符串标签集 + 自由函数
导出常量 `INVULNERABLE_TAG = 'Invulnerable'`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `tags` | `string[]` | `[]` | 标签集合，**保持升序且去重**（确定性） |

自由函数（**非组件方法**，C4）：
| 函数 | 签名 | 语义 |
|---|---|---|
| `addTag` | `(world, id, tag) => void` | 加入 `tag`；若实体无 `TagComponent` 则**惰性创建**；幂等；维护升序去重 |
| `removeTag` | `(world, id, tag) => void` | 移除 `tag`；无组件或不存在时为 no-op |
| `hasTag` | `(world, id, tag) => boolean` | 是否携带 `tag`；**无组件视为 `false`** |

### 3.4 `InputComponent`（新增字段）
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `buttonDash` | `boolean` | `false` | 冲刺键是否按住（**持久**，由 `MovementSystem` 从 `keysHeld` 派生） |

导出常量 `DASH_KEY = 'dash'`（冲刺键名）。

### 3.5 `VelocityComponent`（新增字段）
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `speedMultiplier` | `number` | `1` | 作用于 `maxSpeed` 的临时倍率；`DashSystem` 冲刺时置为 `dash.speedMultiplier`，其余时刻置 `1` |

---

## 4. 状态机契约

### 4.1 状态与转移
```
IDLE   --(moveVector 非零)--> MOVING
MOVING --(moveVector 为零)--> IDLE
IDLE|MOVING --(buttonDash 且 cooldownRemaining === 0)--> DASHING
DASHING --(ticksInState >= durationTicks)--> (moveVector 非零 ? MOVING : IDLE)
```
- 进入 `DASHING` 由 `DashSystem` 执行（§5.3），退出由 `StateSystem` 执行（§5.4）。
- `IDLE` 与 `MOVING` 之间的切换由 `StateSystem` 依据 `InputComponent.moveVector` 每 Tick 判定。
- 每次状态切换 `ticksInState` 归 `0`；同状态持续则 `ticksInState += 1`。

### 4.2 冲刺语义（MUST）
- 冲刺**方向 = 锁定当前面朝方向**：`lockedDir = (cos(facingRadians), sin(facingRadians))`，
  等价于"覆盖输入"——方向由 `VelocityComponent.directionVector` 承载，`InputComponent` 不参与。
- 冲刺期间 `speedMultiplier = dash.speedMultiplier`（默认 3），退出后由 `DashSystem` 复位为 `1`。
- 冲刺期间**不读 `moveVector`、不重算 `facingRadians`**（AC-02）。

---

## 5. 系统契约与管道顺序

### 5.1 规范管道（硬契约）
`src/ecs/systems/pipeline.ts::createDefaultSystems()` 返回**新实例数组**，顺序固定：

```
MovementSystem  ->  DashSystem  ->  StateSystem
```

顺序理由（**不得重排**，否则破坏 §6 时序契约）：
1. `MovementSystem` 先跑，按**上一 Tick 决定的状态**积分 → 本 Tick 启动的冲刺从**下一 Tick** 开始位移，
   从而"15 Tick 冲刺"恰好对应 15 个位移 Tick。
2. `DashSystem` 次跑，施加本 Tick 的冲刺进入 / 方向锁定 / 无敌标签 / 冷却递减；
   它在移动之后（不能追溯改变本 Tick 位移），在状态机之前。
3. `StateSystem` 最后跑，此时冲刺决策已就位，再推进 `ticksInState` —— 这使无敌窗口与冲刺前段对齐、
   并让冲刺恰在第 `durationTicks` 个 Tick 退出。

### 5.2 `MovementSystem`（修改）
`name === 'MovementSystem'`，每 Tick 两阶段：

**bindInput（新增一行）**：原逻辑不变（`move` 覆盖 `moveVector`；`keyDown`/`keyUp` 维护升序 `keysHeld`），
末尾追加 `input.buttonDash = input.keysHeld.includes(DASH_KEY)`。
- `ctx.input` 为空时函数提前 return，**保留上一 Tick 的 `buttonDash`**（正确：按住状态跨空 Tick 持续）。

**integrate（分两路）**：对同时拥有 `InputComponent` + `VelocityComponent` + `TransformComponent` 的实体：
- 取可选 `StateComponent`；`dashing = state !== undefined && state.state === ActionState.DASHING`。
- **dashing 路**：方向取 `velocity.directionVector`（由 `DashSystem` 锁定）；
  速度 `velocity.maxSpeed * velocity.speedMultiplier`；写入 `velocity.currentSpeed`；
  位移 `transform.x/y += dir * currentSpeed * fixedDeltaSeconds`；**不读 `input.moveVector`、不重算 `facing`**。
- **非 dashing 路**（M1-T01 行为，仅归一化改限幅）：`direction = clampMagnitude(input.moveVector, 1)`；
  `moving = (direction ≠ 0)`；`currentSpeed = moving ? maxSpeed : 0`；写回 `velocity.directionVector`；
  `moving` 时积分并写 `transform.facingRadians = atan2(dir.y, dir.x)`。

### 5.3 `DashSystem`（新增）
`name === 'DashSystem'`。对同时拥有 `Input` + `State` + `DashStats` + `Velocity` + `Transform` 的实体：

**非 DASHING 分支**：
1. `if (dash.cooldownRemaining > 0) dash.cooldownRemaining -= 1;`
2. `velocity.speedMultiplier = 1;`（清理，幂等）
3. `if (input.buttonDash && dash.cooldownRemaining === 0) startDash(...)`

**DASHING 分支**：
1. `if (dash.cooldownRemaining > 0) dash.cooldownRemaining -= 1;`
2. 标签：`state.ticksInState < dash.invulnerableTicks` → `addTag(INVULNERABLE_TAG)`，否则 `removeTag(INVULNERABLE_TAG)`

**startDash**：
```
lockedDir = (cos(transform.facingRadians), sin(transform.facingRadians))
state.state = DASHING;  state.ticksInState = 0
dash.cooldownRemaining = dash.cooldownTicks
velocity.speedMultiplier = dash.speedMultiplier
velocity.directionVector = lockedDir
velocity.currentSpeed = velocity.maxSpeed * dash.speedMultiplier
addTag(id, INVULNERABLE_TAG)
```

### 5.4 `StateSystem`（新增）
`name === 'StateSystem'`。对每个拥有 `StateComponent` 的实体：
- **DASHING**：`durationTicks = DashStats?.durationTicks ?? DEFAULT_DASH_DURATION_TICKS`；
  若 `ticksInState >= durationTicks` → **退出**：`state = (input?.moveVector 非零 ? MOVING : IDLE)`、`ticksInState = 0`；
  否则 `ticksInState += 1`。
- **其他状态**：`next = (input?.moveVector 非零) ? MOVING : IDLE`；
  `next === state` → `ticksInState += 1`；否则切换并把 `ticksInState` 归 `0`。

### 5.5 实体过滤与顺序
- 只处理所需组件齐备的实体；缺任一组件则跳过，不报错。
- 实体按 `World.query` 返回的 id 升序处理（确定性）。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

场景：`fps = 60`、`maxSpeed = 5`、`facingRadians = 0`、tick 0 注入 `keyDown('dash')` 并保持按住、无 move 输入。

| Tick | MovementSystem（integrate） | DashSystem | StateSystem | 时钟后 | `x` | `Invulnerable` | `state` |
|---|---|---|---|---|---|---|---|
| 0 | 状态 IDLE，无位移 | startDash：dir=(1,0)，spd=3，cd=30 | 0 → 1 | 1 | 0 | ✅ | DASHING |
| 1 | DASHING，+0.25 | cd 30→29；1<12 挂标签 | 1 → 2 | 2 | 0.25 | ✅ | DASHING |
| … | … | … | … | … | … | ✅ | DASHING |
| 11 | DASHING，+0.25 | cd→19；11<12 挂标签 | 11 → 12 | 12 | 2.75 | ✅ | DASHING |
| 12 | DASHING，+0.25 | cd→18；12<12 否 → 摘标签 | 12 → 13 | 13 | 3.00 | ❌ | DASHING |
| 13 | DASHING，+0.25 | 摘标签 | 13 → 14 | 14 | 3.25 | ❌ | DASHING |
| 14 | DASHING，+0.25 | 摘标签 | 14 → 15 | 15 | 3.50 | ❌ | DASHING |
| 15 | DASHING，+0.25 | 摘标签 | 15 ≥ 15 → 退出 → IDLE | 16 | 3.75 | ❌ | IDLE |
| 16 | IDLE，无位移 | cd 15→14 | IDLE 持续 | 17 | 3.75 | ❌ | IDLE |
| … | … | … | … | … | … | ❌ | IDLE |
| 29 | 无位移 | cd 2→1 | — | 30 | 3.75 | ❌ | IDLE |
| 30 | 无位移 | cd 1→0；buttonDash 且 cd===0 → startDash | 0 → 1 | 31 | 3.75 | ✅ | DASHING |

**由该表派生的可断言事实（MUST）**：
1. tick 0 冲刺启动，`Invulnerable` 挂上；**tick 0 无位移**。
2. 冲刺位移发生在 **tick 1..15 共 15 个 Tick**，速度 `3 × maxSpeed`，方向 = 锁定面朝方向。
3. 每步 `step(1)` 后：时钟 **1..12** `hasTag('Invulnerable') === true`；时钟 **13..15** 为 `false`。
4. tick 15 的 `StateSystem` 之后状态回到 `IDLE`（若按住方向则 `MOVING`）。
5. `cooldownRemaining` 在 **tick 30 归 0**，tick 30 可再次冲刺（按住键则自动再冲）。
6. facing=0 时冲刺总位移 `= 15 × (1/60) × 3 × maxSpeed`（maxSpeed=5 → **3.75**）；
   同 15 Tick 普通行走仅 `15 × (1/60) × 5 = 1.25`，比值 **3×**。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 状态机存在 | 组装后实体拥有 `StateComponent`；`ActionState` 含 `IDLE`/`MOVING`/`DASHING` 三值 | 必达（派发要求） |
| **AC-02** | 冲刺进入与方向锁定 | tick 0 `keyDown('dash')` ⇒ `DASHING`，持续 **15 Tick**；期间注入 `move` 不改变方向（`directionVector` 保持锁定值、`facing` 不变） | 必达（派发要求） |
| **AC-03** | 前段无敌 | 冲刺前 **12 Tick** 携带 `Invulnerable`：时钟 1..12 `hasTag===true`，13..15 `===false` | 必达（派发要求） |
| **AC-04** | 冷却 30 Tick | 冷却 30 Tick（0.5 s）；冷却期间忽略冲刺输入；tick 30 `cooldownRemaining` 归 0 且可再次冲刺 | 必达（派发要求） |
| **AC-05** | 速度显著更高 | 冲刺速度 = `3 × maxSpeed`；15 Tick 冲刺位移 3.75 对同 Tick 行走 1.25（比值 3） | 必达（派发要求） |
| AC-06 | 确定性回放 | 同输入序列跑两个独立 Simulator，最终 Snapshot `toEqual` 一致 | 保障门 |
| AC-07 | 状态机无卡死 | `DASHING` 必在 `durationTicks` 内退出；`IDLE`/`MOVING` 随输入正确切换；`ticksInState` 单调、切换归 0 | 保障门 |
| AC-08 | 类型安全与纯逻辑 | `npm run typecheck` 零错误、无 `any` 逃逸；`src/` 无 DOM/墙钟/随机；Vitest 为 node 环境 | 保障门 |

> AC-01…AC-05 为任务派发明确要求；AC-06~08 为保障前五条可信而设的补充门。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| 管道顺序错误（State 先于 Dash） | 无敌窗口/持续 Tick 与位移错位，逐 Tick 断言失败 | `createDefaultSystems` 固定顺序；§5.1/§6 |
| 冲刺期间仍读 `moveVector` | 中途转向，违反 AC-02 | integrate 的 dashing 路只读 `velocity.directionVector` |
| 冲刺期间重算 `facing` | 朝向被输入污染，锁定失效 | dashing 路跳过 `atan2` 写入 |
| 冷却递减位置错误 | 二次冲刺时机偏移（≠ tick 30） | 先递减、后判定 `=== 0`（§5.3） |
| 组件上挂方法 | 破坏 POD 契约（spec 00 §6.1） | 标签操作用自由函数（§3.3） |
| 标签数组无序 | Snapshot 因加入顺序不同而不等，破坏确定性 | `addTag` 后 `sort()` 去重 |
| `speedMultiplier` 未复位 | 退出冲刺后仍超速 | 非 DASHING 分支每 Tick 置 `1`（幂等） |
| 硬编码 `1/60` | 换 fps 后冲刺位移错 | 取 `ctx.fixedDeltaSeconds` |
| 无敌窗口越界 | `invulnerableTicks > durationTicks` | `PlayerFactory` 校验抛 `RangeError` |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**：`tests/combat/dash.test.ts`（AC-01…AC-07，由 QA 严守真编写）；AC-08 由 CI 静态门 + `npm run typecheck` 覆盖。
- **本 Spec → 实现**：
  - `src/ecs/components/{StateComponent,DashStatsComponent,TagComponent}.ts`（新增）
  - `src/ecs/components/{InputComponent,VelocityComponent}.ts`（扩展）
  - `src/ecs/systems/{DashSystem,StateSystem,pipeline}.ts`（新增）
  - `src/ecs/systems/MovementSystem.ts`（扩展）
  - `src/ecs/prefabs/PlayerFactory.ts`（组装扩展）
- **契约依赖登记**：`specs/01_character_controller_spec.md` §4.2/§10（rev.2，归一化 → 限幅）。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **冷却自"冲刺开始"计**：`cooldownTicks` 在 `startDash` 时置为满值，故 30 Tick 冷却的"可再次冲刺"时刻
   落在 tick 30（相对首次冲刺开始）。若未来要改为"自冲刺结束计"，需调整 `startDash` 时机并修订 AC-04。
2. **无敌窗口用标签而非专用组件**：`TagComponent` 为通用字符串集合，`Invulnerable` 只是其中一个标签。
   好处是后续"霸体 / 无敌 / 潜行"等可复用同一机制；代价是标签为字符串，编译器不做拼写检查——
   统一用导出常量 `INVULNERABLE_TAG` 规避。
3. **`addTag` 惰性创建组件**：为让自由函数"总有效"（对无 `TagComponent` 的实体调用 `addTag` 不静默失败），
   采取惰性挂载；`hasTag` 对无组件实体返回 `false`。若未来要求"标签必须显式声明组件"，可收紧为 no-op。
4. **`MovementSystem` 承载 dash 分支**：M1-T01 已把输入绑定与运动学合并；本次在 `integrate` 内分两路而非抽新系统，
   保持"一个积分点"。当 M2 引入攻击/技能位移后，应评估抽出统一的 `LocomotionSystem`。
5. **`buttonDash` 为电平（held）而非边沿（pressed）**：本 Spec 以"按住即持续尝试冲刺"建模，
   冷却一结束自动再冲。若需"必须松开再按"的严格边沿语义，需在 `InputComponent` 增加 `buttonDashPressed` 上升沿标记。

---

## 11. 修订记录（Revision History）

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| rev.1 | 2026-09-28 | 程基岩 | 初版（M1-T02）：冲刺 + 动作状态机，AC-01…AC-08 |
