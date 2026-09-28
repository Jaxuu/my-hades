# M1-T02 · 工程交接报告（Dash & Action-State）

| Field | Value |
|---|---|
| Task ID | **M1-T02-E**（P0，阻塞 QA） |
| 负责人 | engineering-lead（程基岩） |
| 状态 | ✅ **完成**（待用户/QA 复核；未提交 git） |
| 日期 | 2026-09-28 |
| 引擎/运行时 | Node.js v22.22.2 · TypeScript `strict` 全开 · Vitest（node 环境） |
| 关联 Spec | `specs/01_character_controller_spec.md`（rev.2）、`specs/02_dash_and_state_spec.md`（新建） |

---

## 1. 交付物清单（含行数）

### 新增
| 文件 | 行数 | 说明 |
|---|---|---|
| `specs/02_dash_and_state_spec.md` | 313 | 冲刺 + 动作状态机 Spec（AC-01…AC-08、逐 Tick 硬契约） |
| `src/ecs/components/StateComponent.ts` | 29 | `ActionState` 枚举 + `StateComponent` |
| `src/ecs/components/DashStatsComponent.ts` | 53 | 4 个默认常量 + `DashStatsComponent` |
| `src/ecs/components/TagComponent.ts` | 59 | `INVULNERABLE_TAG` + `TagComponent` + `addTag`/`removeTag`/`hasTag` |
| `src/ecs/systems/DashSystem.ts` | 96 | 冲刺进入 / 方向锁定 / 无敌标签 / 冷却 |
| `src/ecs/systems/StateSystem.ts` | 53 | 动作状态机推进与退出 |
| `src/ecs/systems/pipeline.ts` | 31 | `createDefaultSystems()` 规范管道 |

### 修改
| 文件 | 行数 | 变更 |
|---|---|---|
| `src/core/math.ts` | 62 | **新增 `clampMagnitude(v, maxLength)`**（保留 `normalizeVec2`） |
| `src/ecs/components/InputComponent.ts` | 39 | 新增 `buttonDash: boolean`（默认 `false`）+ 导出 `DASH_KEY = 'dash'` |
| `src/ecs/components/VelocityComponent.ts` | 36 | 新增 `speedMultiplier: number`（默认 `1`） |
| `src/ecs/components/index.ts` | 6 | barrel 导出三个新组件 |
| `src/ecs/systems/MovementSystem.ts` | 118 | `normalizeVec2` → `clampMagnitude`；`bindInput` 派生 `buttonDash`；`integrate` 增加 DASHING 分支 |
| `src/ecs/systems/index.ts` | 4 | barrel 导出 Dash/State/pipeline |
| `src/ecs/prefabs/PlayerFactory.ts` | 102 | 追加挂载 State/DashStats/Tag；新增 `dash` 选项 + 逐项校验 |
| `specs/01_character_controller_spec.md` | 221 | §4.1/§4.2 归一化→限幅；§10 取舍 1 标记已修订；新增 §11 修订记录 rev.2 |

> 未改动：`tests/harness/independent-verify.test.ts`、`package.json`、`package-lock.json`、`tsconfig.json`、`vitest.config.ts`。未创建 `tests/combat/dash.test.ts`（归 QA）。**未 git commit。**

---

## 2. 精确公开 API 摘要

### 2.1 `src/core/math.ts`
```ts
export function clampMagnitude(v: Vec2, maxLength: number): Vec2
// 零向量 → (0,0)；|v| <= maxLength → 原样返回（保留推力）；|v| > maxLength → 等比缩放到模长恰为 maxLength
// maxLength 非正/非有限 → 抛 RangeError
```

### 2.2 组件（均 `extends ComponentBase`，POD，无方法）
```ts
// StateComponent.ts
export enum ActionState { IDLE = 'IDLE', MOVING = 'MOVING', DASHING = 'DASHING' }
export class StateComponent extends ComponentBase {
  public state: ActionState;      // 默认 ActionState.IDLE
  public ticksInState: number;    // 默认 0
  constructor(state?: ActionState, ticksInState?: number);
}

// DashStatsComponent.ts
export const DEFAULT_DASH_SPEED_MULTIPLIER = 3;
export const DEFAULT_DASH_DURATION_TICKS = 15;
export const DEFAULT_DASH_INVULNERABLE_TICKS = 12;
export const DEFAULT_DASH_COOLDOWN_TICKS = 30;
export class DashStatsComponent extends ComponentBase {
  public speedMultiplier: number;   // 3
  public durationTicks: number;     // 15
  public invulnerableTicks: number; // 12
  public cooldownTicks: number;     // 30
  public cooldownRemaining: number; // 0
  constructor(speedMultiplier?, durationTicks?, invulnerableTicks?, cooldownTicks?, cooldownRemaining?);
}

// TagComponent.ts
export const INVULNERABLE_TAG = 'Invulnerable';
export class TagComponent extends ComponentBase { public tags: string[]; constructor(tags?: string[]); }
export function addTag(world: World, id: EntityId, tag: string): void;
export function removeTag(world: World, id: EntityId, tag: string): void;
export function hasTag(world: World, id: EntityId, tag: string): boolean; // 无组件 → false

// InputComponent.ts（新增字段/常量）
export const DASH_KEY = 'dash';
export class InputComponent extends ComponentBase {
  public moveVector: Vec2; public keysHeld: string[]; public buttonDash: boolean; // 默认 false
}

// VelocityComponent.ts（新增字段）
export class VelocityComponent extends ComponentBase {
  public maxSpeed: number; public currentSpeed: number; public directionVector: Vec2;
  public speedMultiplier: number; // 默认 1
}
```

### 2.3 系统
```ts
export class MovementSystem implements System { readonly name = 'MovementSystem'; }
export class DashSystem     implements System { readonly name = 'DashSystem'; }
export class StateSystem    implements System { readonly name = 'StateSystem'; }

// pipeline.ts —— 规范顺序（硬契约）
export function createDefaultSystems(): readonly System[];
// => [ new MovementSystem(), new DashSystem(), new StateSystem() ]
```

### 2.4 `PlayerFactory`
```ts
export const DEFAULT_PLAYER_MAX_SPEED = 5;
export interface PlayerDashOptions { speedMultiplier?; durationTicks?; invulnerableTicks?; cooldownTicks?; }
export interface PlayerSpawnOptions { x?; y?; facingRadians?; maxSpeed?; dash?: PlayerDashOptions; }
PlayerFactory.spawn(world, options?): EntityId
// 挂载：Transform + Velocity + Input + State + DashStats + Tag
// 校验违规抛 RangeError：maxSpeed 非正/非有限；speedMultiplier 非正/非有限；
//   durationTicks/invulnerableTicks/cooldownTicks 非正整数；invulnerableTicks > durationTicks
```

> 顶层 barrel `src/index.ts` 已可 `import { GameSimulator, createDefaultSystems } from '<root>/src'`（自验用例验证过）。

---

## 3. 自验命令与真实输出

### 3.1 `npm run typecheck`
```
> my-hades@0.0.0 typecheck
> tsc --noEmit
（零错误，退出码 0）
```

### 3.2 `npm run test`（既有 54 用例）
```
 RUN  v2.1.9 D:/Project/Wkbd-project/my-hades

 ✓ tests/harness/ecs.test.ts (5 tests)
 ✓ tests/harness/clock.test.ts (6 tests)
 ✓ tests/harness/input-timing.test.ts (6 tests)
 ✓ tests/harness/snapshot.test.ts (4 tests)
 ✓ tests/harness/determinism.test.ts (2 tests)
 ✓ tests/harness/independent-verify.test.ts (19 tests)
 ✓ tests/combat/movement.test.ts (12 tests)

 Test Files  7 passed (7)
      Tests  54 passed (54)
   Duration  1.05s
（退出码 0；M1-T01 的 12 个移动用例仍全绿，含 AC-03 归一化/限幅用例）
```

### 3.3 临时自验用例（已按要求**交接前删除**）
`tests/combat/_selfverify-dash.tmp.test.ts` → **13 passed (13)**，覆盖：
clampMagnitude 语义/边界、管道顺序、**逐 Tick 冲刺契约**（tick0 启动、位移 tick1..15=3.75、无敌时钟 1..12 true/13..15 false、
tick15 退出 IDLE、tick30 二次冲刺）、3× 比值（3.75 vs 1.25）、中途输入不转向、面朝锁定方向、确定性回放、
标签自由函数（惰性创建/升序去重/无组件 false）、`buttonDash` 跨空 Tick 持久、PlayerFactory 校验。

随后又以 `_selfverify-final.tmp.test.ts` → **3 passed (3)** 在**最终代码态**（含注释修正后）复验顶层 barrel 与整条契约，随后删除。
`ls tests/combat/` 现仅剩 `movement.test.ts`。

### 3.4 CI 纯逻辑静态门（本地重放）
```
OK: src/ contains no DOM, wall-clock or randomness access.
```

---

## 4. 关键实现决策

1. **管道顺序 = 硬契约**：`MovementSystem → DashSystem → StateSystem`。`MovementSystem` 先跑保证"本 Tick 启动的冲刺从下一 Tick 位移"，使 15 Tick 冲刺恰好对应 15 个位移 Tick；`StateSystem` 最后跑使无敌窗口与冲刺前段对齐、并在第 15 Tick 精确退出。
2. **冲刺方向 = 锁定当前面朝**：`startDash` 用 `(cos θ, sin θ)` 写入 `velocity.directionVector`；`MovementSystem` 的 DASHING 分支只读该向量、**不读 `moveVector`、不重算 `facing`**，实现 AC-02「中途输入不改向」。
3. **计时全部落在组件字段**（`ticksInState` / `cooldownRemaining`），系统**零跨 Tick 隐藏状态**（spec 00 §6.1）。
4. **标签操作为自由函数**，不在组件类上加方法，守住 POD 契约。
5. **冷却"先递减、后判 `=== 0`"**，使 30 Tick 冷却在 tick 30 归 0 且可再次冲刺（自冲刺**开始**计）。

---

## 5. 与派单的偏差与判断（需主理人知悉）

1. **⚠️ CI 静态门会误伤英文单词 "window"**：CI 门控 `grep -rnE '\b(document|window|...)\b'` 会匹配注释里的普通英文单词。
   我初版注释使用 "invulnerability window"，**本地重放该门控时报 FAIL**。已将 `src/` 内 4 处 "invulnerability window" 全部改为
   **"invulnerability span"**，门控恢复 OK。**提示**：后续 `src/` 注释/字符串**不要出现** `window`/`document` 等词面量。
2. **`addTag` 惰性创建 `TagComponent`**：契约对"实体无 `TagComponent` 时 `addTag` 的行为"未明确（仅明确 `hasTag` 无组件 → `false`）。
   我判断自由函数应"总有效"，故 `addTag` 在缺组件时惰性挂载；`removeTag` 缺组件为 no-op。已在 spec 02 §10 取舍 3 登记，如需收紧为 no-op 可一行改。
3. **spec01 §4.1 一并更新**：派单只点名 §4.2/§10，但 §4.1 的积分公式原文写 `normalize`，不改会与 §4.2 自相矛盾，故同步改为 `clampMagnitude`。
4. **DASHING 分支写回 `velocity.currentSpeed`**：与既有非 DASHING 分支保持一致的"当前速率"语义（便于 Snapshot 观察），spec 02 §5.2 已明示。
5. **未创建 `tests/combat/dash.test.ts`**、**未 commit**、**未触碰 QA 独立套件与四份配置文件**——严格遵守派单边界。

---

## 6. 未决风险 / 建议下一步

| # | 风险 / 待办 | 建议 |
|---|---|---|
| R1 | CI 门控的 `\bwindow\b` 词面量误伤（见 §5.1） | 建议将门控正则收窄为 `window\.` / `globalThis.window` 等真实用法，或在 `.github/workflows/ci.yml` 加注释说明；当前实现已规避 |
| R2 | `addTag` 惰性创建语义未经 QA 确认（§5.2） | QA 若按"no-op"预期编写断言将失败；请在 `dash.test.ts` 中明确该行为 |
| R3 | `buttonDash` 为电平（held）语义，非边沿（pressed） | 若 QA/设计需要"必须松手再按"的严格边沿，需加 `buttonDashPressed` 上升沿标记并修订 spec 02 §10 取舍 5 |
| R4 | 冷却自"冲刺开始"计 | 若设计期望自"冲刺结束"计，需调整 `startDash` 时机并修订 AC-04 |
| R5 | 无敌标签"只维护不消费" | 伤害结算在 M2+；届时确认 `Invulnerable` 的消费者 |

**下一步**：请 QA（严守真）依据 `specs/02_dash_and_state_spec.md`（尤其 §6 逐 Tick 硬契约）编写 `tests/combat/dash.test.ts`；
如需我配合澄清 R2/R3/R4，随时召唤。
