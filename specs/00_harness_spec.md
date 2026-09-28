# 00 · Harness & Deterministic Simulation Spec

| Field | Value |
|---|---|
| Spec ID | `SPEC-00-HARNESS` |
| Milestone | **M0 · 技术搭建** |
| Status | `draft` → `accepted`（本文件为 M0 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/core/`、`src/ecs/`、`tests/harness/` |
| Runtime | Node.js ≥ 22（本机 v22.22.2） |
| Language | TypeScript（`strict` 全开） |
| Test runner | Vitest（node 环境） |

---

## 1. 目的与范围

### 1.1 目的
为动作肉鸽游戏（《Hades》核心玩法复刻）建立一套**与渲染完全解耦**的确定性模拟底座（Harness）。所有玩法逻辑运行在纯 Headless 的固定步长（Fixed-Tick）模拟器中；渲染层未来仅作为**只读消费者**读取 Snapshot，不参与任何状态计算。

本 Spec 定义 Harness 的**契约边界**，是 M0 全部实现与测试的验收依据（Single Source of Truth）。

### 1.2 M0 做什么（In Scope）
- 固定步长确定性时钟：默认 60 FPS，`60 ticks === 1.0 s` **精确成立**。
- 输入事件契约：在**指定 Tick** 注入移动向量与按键按下/释放，Tick 对齐、同 Tick 排序确定。
- 只读快照（Snapshot）：对外暴露不可篡改的世界状态副本。
- 最小 ECS：`World` / `Entity` / `Component` / `System` 的职责与接口。
- 无头测试驱动器：装配 Simulator、注入输入脚本、驱动 Tick、导出 Snapshot。
- 单元测试：时钟精度、输入时序、Snapshot 不可变、确定性回放、ECS 基础行为。

### 1.3 M0 不做什么（Out of Scope，显式排除）
- ❌ 任何渲染 / DOM / Canvas / WebGL / 图形库（**禁止** `document`、`window`、`HTMLCanvasElement`）。
- ❌ 任何 jsdom / pixi / three 等浏览器或图形依赖。
- ❌ 具体玩法系统（战斗、敌人 AI、房间生成、武器、祝福 Boon）——留待 M1+。
- ❌ 音频、资源加载、存档、网络同步、UI。
- ❌ 真实时间驱动（`requestAnimationFrame` / `setInterval`）；时间**只由 `step()` 手动推进**。
- ❌ 物理引擎接入（碰撞/刚体）——M0 仅预留 ECS 扩展位。

### 1.4 约束（Constraints）
- C1 纯逻辑：`src/` 不得引用任何浏览器全局或图形依赖。
- C2 确定性：相同输入序列 + 相同起始状态 ⇒ 逐 Tick 相同状态（可回放）。
- C3 类型安全：禁止 `any` 逃逸；不确定处用 `unknown` + 类型守卫。
- C4 无运行时依赖：仅 devDependencies = `typescript`、`vitest`、`@types/node`。
- C5 精度：见 §3 时钟契约。

---

## 2. 术语表（Glossary）

| 术语 | 定义 |
|---|---|
| **Tick** | 模拟的最小离散时间单位。一次 `tick` = 一次逻辑更新周期。整数索引，从 `0` 开始。 |
| **Fixed-Tick** | 时间以固定步长离散推进的模式；每 Tick 的模拟时长恒等，与真实墙钟时间无关。 |
| **FPS（逻辑）** | 每秒 Tick 数，默认 `60`。与渲染帧率解耦。 |
| **`fixedDeltaSeconds`** | 单个 Tick 对应的模拟秒数 = `1 / FPS`。默认 `1/60 ≈ 0.0166666…`。 |
| **`tickDurationMs`** | 单个 Tick 对应的毫秒数 = `1000 / FPS`。默认 `1000/60 ≈ 16.6666…`（**不截断**）。 |
| **Simulator (`GameSimulator`)** | 承载 ECS World、时钟与输入队列的确定性模拟核心。 |
| **Harness** | 无头测试驱动器：装配 Simulator、注入输入脚本、驱动 Tick、导出 Snapshot 的工具层。 |
| **Input Event** | 在某个目标 Tick 生效的输入指令（移动向量 / 按键按下 / 按键释放）。 |
| **Snapshot** | 某一 Tick 结束后世界状态的**深拷贝 + 冻结**只读视图。 |
| **System** | 每 Tick 按固定顺序执行的一段逻辑，读写 World 中的组件数据。 |
| **Entity** | 一个整数 ID；其数据由挂载的 Component 组成。 |
| **Component** | 挂在 Entity 上的纯数据结构（POD）。 |

---

## 3. 时钟契约（Fixed-Tick Clock Contract）— **规范核心**

### 3.1 参数
| 参数 | 符号 | 默认值 | 定义 |
|---|---|---|---|
| 逻辑帧率 | `fps` | `60` | 每秒 Tick 数 |
| Tick 秒长 | `fixedDeltaSeconds` | `1 / fps` | `= 1 / 60` |
| Tick 毫秒长 | `tickDurationMs` | `1000 / fps` | `= 1000 / 60` |

### 3.2 换算关系（MUST）
```
fixedDeltaSeconds = 1 / fps
tickDurationMs     = 1000 / fps          // 不截断、不四舍五入
tickDurationMs     = fixedDeltaSeconds * 1000
```

### 3.3 精度要求（MUST，硬性）
- **`N` 个 Tick 后的累计模拟秒数 `elapsedSeconds` 满足：**
  ```
  elapsedSeconds(N) === N * fixedDeltaSeconds
  ```
- 当 `N = 60`、`fps = 60` 时：`elapsedSeconds(60)` **必须精确等于** `1.0` 秒（容差 `1e-9`）。
- **禁止**把 `tickDurationMs` 硬编码为 `16.67`：`60 × 16.67ms = 1000.2ms ≠ 1s`，会破坏确定性累加。
- 累加实现应使用 `elapsedSeconds = totalTicks * fixedDeltaSeconds`（乘法而非浮点累加），避免误差漂移。

### 3.4 时钟不变量（Invariants）
- `totalTicks` 为**单调不减**的非负整数。
- `elapsedSeconds` 为 `totalTicks` 的纯函数（同输入同输出）。
- 时钟**不**读取系统墙钟时间。

---

## 4. 输入事件契约（Input Event Contract）

### 4.1 事件类型
| 类型 | 载荷 | 说明 |
|---|---|---|
| `move` | `{ x: number; y: number }` | 移动向量（建议归一化由上层负责，M0 仅透传） |
| `keyDown` | `{ key: string }` | 按键按下 |
| `keyUp` | `{ key: string }` | 按键释放 |

### 4.2 注入时机与 Tick 对齐
- 每个事件**绑定一个目标 Tick**（`tick` 字段，非负整数）。
- 事件在该 Tick 的**逻辑更新之前**被投递到当前输入帧（即该 Tick 的 System 可见）。
- 支持两种注入方式：`enqueue(event)`（入队，按 `tick` 排序分发）与 `injectAt(tick, event)` 语义等价。
- **Tick 对齐规则**：事件仅在其 `tick === currentTick` 时被消费；**不早不晚**。

### 4.3 同 Tick 多事件顺序（MUST，确定性）
- 同一 Tick 内的多个事件按**入队顺序（FIFO）**消费。
- 保证确定性：同输入序列两次运行结果完全一致。

### 4.4 边界处理（MUST）
| 情况 | 行为 |
|---|---|
| `tick = 0` 注入 | 允许；在第 0 Tick（首个 Tick）生效 |
| `tick` 已过（`< currentTick`） | **拒绝**（抛出 `RangeError` 或忽略并记录；M0 采用**抛错**以保证测试可断言） |
| `tick` 越界/负数/非整数 | **拒绝**（抛出 `RangeError`） |

> 决策：M0 对非法 Tick **抛 `RangeError`**，使"越界处理"可被单元测试显式断言。

### 4.5 输入帧语义
- 每 Tick 开始，Simulator 取出该 Tick 的全部事件，构成**本 Tick 输入帧**，传给 System 链。
- 该 Tick 无事件 ⇒ 空输入帧（合法，非错误）。

---

## 5. Snapshot 只读快照契约（Snapshot Contract）

### 5.1 字段
| 字段 | 类型 | 说明 |
|---|---|---|
| `tick` | `number` | 快照对应的 Tick 索引 |
| `elapsedSeconds` | `number` | 累计模拟秒数 |
| `entities` | `ReadonlyArray<EntitySnapshot>` | 实体及其组件的深拷贝 |

### 5.2 语义（MUST）
- **深拷贝**：Snapshot 与内部 World **不共享**可变引用（组件数据为结构化克隆）。
- **冻结**：返回对象（含嵌套）经 `Object.freeze` 处理，运行时不可篡改。
- **不可变性理由**：渲染层/回放层仅消费，杜绝"外部改状态导致模拟分叉"，保证确定性与可回放性。

### 5.3 不变量
- 对 Snapshot 任意字段赋值 ⇒ 严格模式下抛 `TypeError`（`Object.isFrozen` 为 `true`）。
- 连续两次 `snapshot()` 且中间未 `step()` ⇒ 深度相等（`toEqual`）。

---

## 6. ECS 最小契约（Minimal ECS Contract）

### 6.1 职责划分
| 单元 | 职责 | 不负责 |
|---|---|---|
| `Entity` | 整数 ID + 存活标记 | 逻辑、数据存储 |
| `Component` | 纯数据结构（POD） | 行为 |
| `World` | 实体/组件注册表；`createEntity` / `destroyEntity` / `addComponent` / `getComponent` / `query` | 时间推进、输入 |
| `System` | 每 Tick 的逻辑单元：`update(world, ctx)` | 持有跨 Tick 隐藏状态（须显式） |

### 6.2 接口签名（TypeScript，规范）
```ts
type EntityId = number;

interface Component { readonly __component: true; } // 基类/标记

class Entity { readonly id: EntityId; /* alive flag */ }

class World {
  createEntity(): Entity;
  destroyEntity(id: EntityId): void;
  addComponent<T extends Component>(id: EntityId, component: T): void;
  getComponent<T extends Component>(id: EntityId, ctor: ComponentCtor<T>): T | undefined;
  hasComponent<T extends Component>(id: EntityId, ctor: ComponentCtor<T>): boolean;
  query(...ctors: ComponentCtor<Component>[]): EntityId[];
  get entityCount(): number;
}

interface SystemContext {
  readonly tick: number;
  readonly elapsedSeconds: number;
  readonly fixedDeltaSeconds: number;        // = 1 / fps，本 Tick 的模拟步长（秒）
  readonly input: ReadonlyArray<InputEvent>; // 本 Tick 输入帧
}

interface System {
  readonly name: string;
  update(world: World, ctx: SystemContext): void;
}
```

> **修订记录（rev.2 · M1-T01）**：`SystemContext` 新增 `fixedDeltaSeconds`。
> 理由：玩法系统（如 `MovementSystem`）必须基于模拟时钟步长积分，而**不得硬编码 `1/60` 或 `16.67ms`**；
> 由 `GameSimulator` 统一注入，是唯一能保证"换 fps 后行为一致"的做法（见 `specs/01_character_controller_spec.md` AC-05）。
> 影响面：`src/ecs/System.ts`（接口）、`src/core/GameSimulator.ts`（构造 ctx）、既有测试夹具（需补该字段）。

### 6.3 系统执行顺序（MUST）
- 系统按注册顺序每 Tick 执行一次，顺序**确定**。
- 同一 Tick：先投递输入帧 → 依次执行 System → 更新时钟 →（可选）导出 Snapshot。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 |
|---|---|---|
| AC-01 | 时钟精度 | 60 Tick 后 `elapsedSeconds` 精确 = `1.0`（容差 `1e-9`） |
| AC-02 | Tick 换算 | `tickDurationMs === 1000/60`，`fixedDeltaSeconds === 1/60` |
| AC-03 | 输入时序 | `tick=10` 的 move 仅在 tick 10 生效；`tick=20` 的 keyDown 仅在 tick 20 生效 |
| AC-04 | 输入边界 | `tick=0` 可注入；越界/负数/已过 Tick 抛 `RangeError` |
| AC-05 | 同 Tick 顺序 | 同 Tick 多事件按 FIFO 确定性消费 |
| AC-06 | Snapshot 不可变 | 返回对象 `Object.isFrozen === true`；篡改抛错/无效 |
| AC-07 | 确定性回放 | 同输入序列跑两遍，Snapshot 序列深度相等 |
| AC-08 | ECS 基础 | 创建/销毁实体、增删查组件、query 结果正确 |
| AC-09 | 类型安全 | `npm run typecheck` 零错误，无 `any` 逃逸 |
| AC-10 | 纯逻辑 | `src/` 无 DOM/浏览器全局；Vitest 为 node 环境 |

## 8. 失败模式（Failure Modes）
| 模式 | 后果 | 缓解 |
|---|---|---|
| 用 `16.67ms` 硬编码 | 60 Tick ≠ 1s，时钟测试失败 | 用 `1000/60`，断言容差 `1e-9` |
| 浮点累加 `+= dt` | 长跑误差漂移 | 用 `totalTicks * fixedDeltaSeconds` |
| Snapshot 浅拷贝 | 外部篡改污染模拟 | 深拷贝 + `Object.freeze` |
| 输入队列用 `Set`/无序遍历 | 同 Tick 顺序不确定 | 用有序数组 + FIFO |
| 引入 jsdom | 违反纯逻辑约束 | node 环境 + 静态检查 |
| 时间依赖墙钟 | 不可回放 | 只由 `step()` 推进 |

## 9. 追溯（Traceability）
- 本 Spec → 测试：`tests/harness/*.test.ts`（AC-01…AC-08）。
- 本 Spec → 实现：`src/core/GameSimulator.ts`、`src/core/clock.ts`、`src/core/input.ts`、`src/ecs/*`。
- 变更本 Spec 须同步更新测试与实现，并在 PR 描述中引用 Spec ID。
