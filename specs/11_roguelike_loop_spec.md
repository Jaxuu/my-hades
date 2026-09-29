# 11 · Roguelike Loop Spec（确定性随机数与词缀三选一）

| Field | Value |
|---|---|
| Spec ID | `SPEC-11-ROGUELIKE-LOOP` |
| Milestone | **M6 · 肉鸽循环**（T01） |
| Status | `accepted`（本文件为 M6-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/core/Random.ts`（新）、`src/core/input.ts`（扩展 `SelectRewardEvent`）、`src/core/GameSimulator.ts`（`seed`）、`src/ecs/World.ts`（`rng` + `WorldOptions`）、`src/ecs/components/EncounterStateComponent.ts`（`depth` / `pendingRewards` / `findRewardDraft`）、`src/ecs/rewards/*`（新）、`src/ecs/systems/RewardSystem.ts`（新）、`src/ecs/systems/EncounterSystem.ts`（掉落 + 深度增强）、`src/ecs/systems/PlayerControllerSystem.ts`（抽奖期压制）、`src/ecs/systems/pipeline.ts`（第 14 段）、`src/ecs/{components,rewards,systems}/index.ts`、`src/ecs/index.ts`、`index.html`（`#ui-layer`）、`client/UIManager.ts`（新）、`client/main.ts`、`tests/combat/roguelike_loop.test.ts`（新）、`tests/combat/{boons,feedback,status_effects,death_and_encounter}.test.ts` 与 `tests/ai/enemy_fsm.test.ts`（管道顺序断言同步） |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/05_boon_modifier_spec.md`（变异引擎 / `ModifierRegistry` / `EventQueue` 注入范式）、`specs/06_status_effect_and_dot_spec.md`（handler 扩展点）、`specs/08_encounter_and_death_spec.md`（房间状态机 / 波次调度 / 死亡标签）、`specs/09_renderer_bridge_spec.md`（渲染层只读契约 / 单向依赖）、`docs/architecture/ADR-001-headless-ecs-foundation.md`（R1–R6）、`docs/architecture/ADR-004-deterministic-prng.md`（本 Spec 的随机性决策） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

M4-T02 让房间**会结束**（`ROOM_CLEARED`），但结束之后**什么也不会发生**：`spec 08 §1.3` 明确把
「掉落 / 击杀奖励 / 经验」列为 Out of Scope，于是「打完一个房间」在玩法上是一条**死路**——
没有回报，也没有下一关。同时，整个引擎到 M5 为止**没有任何随机源**：ADR-001 R2 禁止 `Math.random`，
而肉鸽的核心乐趣恰恰是「每次不一样」。

M6-T01 把这条死路接成**循环**，并为此引入引擎的第一等随机性：

1. **确定性随机数基建**：用一个**有种子**的 PRNG（Mulberry32）替换"系统默认随机"。
   随机性成为**外部输入**——同种子 + 同抽取序列 ⇒ 逐位相同结果（ADR-004）。
2. **奖励与肉鸽循环**：房间清空 ⇒ **掉落三选一**（`pendingRewards`）⇒ 玩家选择 ⇒
   词缀挂载给玩家 ⇒ 房间**重置并加深**（`depth + 1`，下一波敌人更多）⇒ 再战。
3. **表现层三选一 UI**：DOM 按钮只**注入意图**，绝不写组件；逻辑层重新校验后结算。

> 一句话判据：**「随机」是一次可复现的纯函数调用；「选择」是一条走输入队列的意图；「变强」是组件数据的改变。**

### 1.2 In Scope（做什么）

- **新增 PRNG**：`src/core/Random.ts`（`nextUint32` / `nextFloat` / `nextInt` / `pick` / `sample`）。
- **装配**：`World.rng`（全局唯一随机流）+ `WorldOptions.seed` + `GameSimulatorOptions.seed`。
- **新增输入事件**：`SelectRewardEvent`（`kind: 'selectReward'`，携带 `rewardId`），走既有 `InputQueue`。
- **组件扩展**：`EncounterStateComponent.depth` / `.pendingRewards` + 自由函数 `findRewardDraft`。
- **新增奖励模块**：`src/ecs/rewards/RewardPool.ts`（奖池 + `draftRewards`）、
  `src/ecs/rewards/grantReward.ts`（结算）、`src/ecs/rewards/index.ts`。
- **新增系统**：`RewardSystem`（消费选择意图 → 挂载词缀 → 清空掉落 → 重置并加深房间）。
- **系统扩展**：`EncounterSystem` 在 `ROOM_CLEARED` 转移时抽奖（AC-01），
  并在生成波次时按 `depth` 追加敌人（AC-04）；`PlayerControllerSystem` 在抽奖期压制玩家意图（AC-02）。
- **管道扩展**：`pipeline.ts` 在 `EncounterSystem` 与 `LifespanSystem` 之间插入 `RewardSystem`（第 14 段）。
- **表现层**：`index.html` 的绝对定位 `#ui-layer` + `client/UIManager.ts`（观测 world → 渲染 3 按钮 → 回调注入意图）。

### 1.3 Out of Scope（显式排除）

- ❌ **多房间串联 / 地图生成 / 关卡门**：`depth` 只表达「同一房间配置被打了多少遍、每次更难」，
  不生成新房间，也不做房间之间的转场动画。
- ❌ **存档 / 续玩同一局**：种子如何持久化、如何"续玩同一局"留待 **ADR-005**。
- ❌ **奖励稀有度 / 升级 / 词缀合成**：奖池是平铺的 id 表，没有稀有度权重，也不支持同一词缀升级。
- ❌ **UI 美术**：`#ui-layer` 只提供可点击的按钮，样式是最小可用的（深色遮罩 + 按钮）。
- ❌ **暂停菜单 / 设置 / 音量**：`#ui-layer` 只服务于三选一。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **抽奖（Draft）** | 房间清空时，从全局奖池**无放回**抽出 `3` 个互不重复的 `rewardId` |
| **掉落（pendingRewards）** | 抽奖结果，存在 `EncounterStateComponent.pendingRewards`（`null` = 无待选项） |
| **选择意图（selectReward）** | 表现层注入的一条输入事件，携带 `rewardId`（不是索引！） |
| **结算（Settle）** | `RewardSystem` 校验并应用选择，清空掉落，房间下沉一层 |
| **深度（depth）** | 已完成的"下沉"次数，从 `0` 起；驱动下一波的敌人数量 |
| **压制（Hold）** | 抽奖期玩家意图被置零：时间照走，但玩家不能移动 / 冲刺 / 攻击 |

**不变量（必须始终成立）**

- **I1**：`pendingRewards !== null` ⟺ `state === ROOM_CLEARED`。
  掉落只在房间终态存在，且结算与离开终态是**同一次写入**。
  ⇒ 「房间惰性」与「有待选项」是同一事实的两个视角，任何系统都不需要第二道「抽奖开着吗」的门。
- **I2**：`pendingRewards` 一经写入即含 **3 个互不相同**的合法 `rewardId`（来自 `REWARD_POOL`）。
- **I3**：`depth` 单调不减，且只在**成功结算**时 `+1`。
- **I4**：逻辑层的随机性**全部**来自 `world.rng`；`src/` 内不存在第二条随机流。
- **I5**：`src/` 不含 `Math.random` / 墙钟 / `Intl`（由 ESLint AST 门强制，ADR-001 R1/R2/R6）。
- **I6**：`LifespanSystem` 恒为管道最后一段。

---

## 3. 数据契约

### 3.1 `EncounterStateComponent`（扩展）

在 spec 08 既有字段之上新增两个（**均为 POD 数据，无方法**）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `depth` | `number` | 已完成的下沉次数，初值 `0`。`RewardSystem` 结算时 `+1`。**不是** `currentWaveIndex`（后者每次下沉重置为 `0`） |
| `pendingRewards` | `string[] \| null` | 待选掉落；`null` = 无待选项。由 `EncounterSystem` 唯一写入（抽奖），由 `RewardSystem` 唯一清除（结算） |

构造函数在**尾部**追加两个可选参数（`depth = 0`、`pendingRewards = null`），
因此既有调用点（`EncounterFactory.spawn` 只传 `waves`）逐字不变。

**新增自由函数** `findRewardDraft(world): EncounterStateComponent | undefined`：
返回当前持有**未结算**掉落的房间组件（无则 `undefined`）。
它是掉落的**唯一读侧入口**，被三个消费者共用：`RewardSystem`（结算）、
`PlayerControllerSystem`（压制）、表现层（渲染按钮）。按 `World.query` 升序确定。

### 3.2 奖励池（`RewardPool.ts`）

```ts
interface RewardDefinition { readonly id: string; readonly label: string }
const REWARD_POOL: readonly RewardDefinition[]   // ≥ 3 项
```

出厂奖池 4 项（顺序固定，便于复算）：

| id | label | 结算效果 |
|---|---|---|
| `zeus_strike` | `Zeus Strike` | 挂载 `zeus_strike` 修饰器（handler 已存在，spec 05） |
| `dionysus_strike` | `Dionysus Blight` | 挂载 `dionysus_strike` 修饰器（handler 已存在，spec 06） |
| `hp_up` | `Max HP +20` | **直接**：`maxHp += 20`，`hp = min(maxHp, hp + 20)` |
| `dash_up` | `Dash CD -10` | **直接**：`cooldownTicks = max(10, cooldownTicks - 10)` |

- `label` 放在**逻辑层**而非 UI：掉落与它的显示名不可能漂移；UI 只**单向读取**这张表。
- `draftRewards(rng, count = 3, pool = REWARD_POOL): string[]`：
  `rng.sample(pool, count).map(r => r.id)`。`count > pool.length` 抛 `RangeError`
  （无法满足的抽奖必须在**接缝处**炸掉，而不是静默返回短列表）。
- `pool` 可注入，使测试能用一张极小的已知表钉住抽奖，而不依赖出厂奖池的大小与顺序。

### 3.3 `SelectRewardEvent`（`src/core/input.ts` 扩展）

```ts
interface SelectRewardEvent {
  readonly kind: 'selectReward';
  readonly tick: number;
  readonly rewardId: string;
}
type InputEvent = MoveEvent | KeyDownEvent | KeyUpEvent | SelectRewardEvent;
```

**为什么走 `InputQueue` 而不是新建一条总线**（AC-03 的落地方式，详见 §10 取舍 1）：
一次按钮点击是一次**外部的、按 Tick 对齐的指令**，与一次按键在语义上同类。
既有队列已经提供了本 AC 需要的**全部**保证——"恰好在 Tick `T` 送达、按入队顺序消费"、
`inject` 的"不得注入过去"规则、`GameLoop` 的"注入先于 `step`"纪律。
新建第二条队列只会再引入一套注入 API、一个 drain 点与一套顺序纪律——三次失同步的机会，零收益。

> **注意**：该事件**不**写入 `PlayerInputComponent`。那是**设备快照**（spec 01 §3.3），
> 一次 UI 点击不是设备状态；把二者混在一起会污染「硬件输入 vs 逻辑意图」的分离（spec 04 §3.1）。

### 3.4 随机源挂载（`World.rng`）

- `World` 持有 `public readonly rng: Random`，由 `WorldOptions.seed`（默认 `0x12345678`）构造。
- `GameSimulatorOptions.seed` 透传给 `World`。
- **逻辑层只读，永不重播种**。真实一局由**调用方**传入种子（ADR-004 §Decision 3）——
  「随机」发生在边界之外，`src/` 依旧零墙钟。
- 挂 `World` 而非 `SystemContext`：后者是**冻结**契约（spec 00 §6.1 / spec 05 C6），
  `ModifierContext extends SystemContext` 也依赖它逐字不变。二者取其一，选 `World`（ADR-004 §4.2）。

---

## 4. 语义

### 4.1 AC-01 · 房间通关掉落

`EncounterSystem` 判定"最后一波被清空"（`nextWave === undefined`）时：

1. `state = ROOM_CLEARED`（既有行为，spec 08 AC-03）；
2. `pendingRewards = draftRewards(world.rng)` —— 用**世界种子流**无放回抽 3 个；
3. `trackedEntityIds` **保留**（既有行为：空名单是"尚未生成"的标记）。

抽奖**只在这一次转移发生**，且只此一处：它是唯一知道"这一局刚清空一个房间"的地方。
同种子 ⇒ 同三选项、同顺序（AC-06）。

### 4.2 AC-02 · 系统暂停（Hold）

存在待选掉落时：

- **时间照走**：`sim.tick` 继续递增，`step()` 正常执行整条管道。**不是**全局暂停。
- **调度器受限**：`EncounterSystem` 在 `ROOM_CLEARED` 上 `continue` ⇒ 不生成、不推进、不改状态。
  由 I1，这一道门同时覆盖"抽奖开着"，无需冗余的第二道门。
- **玩家被压制**：`PlayerControllerSystem.deriveIntent` 在抽奖期把玩家意图**置零**
  （`moveVector = (0,0)`、两个脉冲 `false`），于是玩家原地不动、不能冲刺、不能攻击。

三点实现细节是刻意的：

1. **压制放在意图生成的唯一咽喉**（`deriveIntent`），而不是在 `MovementSystem` / `DashSystem` /
   `CombatActionSystem` 各加一道门。一次写入点不可能"只应用一半"，且**没有任何消费者需要知道"房间"这个概念**。
2. **只压制阶段 2**（意图），**不压制阶段 1**（设备快照）。按键的按下/抬起仍被记录，
   于是"抽奖期间松开摇杆"仍被观测到，抽奖关闭时玩家不会因为一个陈旧向量而猛冲。
3. **每 Tick 只判定一次**（循环之前），同 Tick 内两个实体的裁决不可能不一致。

**脉冲被丢弃而非缓冲**：压制期间上升沿脉冲被直接置 `false`，绝不缓存到抽奖结束再补触发
（与 spec 04 §4.3「先消费后门控」同一纪律）。

**相位（1 Tick 延迟）**：房间在 Tick `T` 末尾才写入掉落，而 `PlayerControllerSystem` 在 Tick `T`
**早已运行**——所以 Tick `T` 玩家**未被压制**，压制自 `T+1` 起生效。同理，结算发生在 `RewardSystem`
（Tick `T` 的后段），玩家自 `T+1` 起恢复自由。这是引擎固有的"1 Tick 相位"（spec 08 §6.2），不是缺陷。

### 4.3 AC-03 · UI 意图隔离

- 表现层**只读** `World`：观测 `findRewardDraft(world)` 是否有值。
- 有值 ⇒ 在 `#ui-layer` 渲染 3 个按钮；无值 ⇒ 隐藏。
- 点击 ⇒ 通过回调向 `GameSimulator` 注入 `{ kind: 'selectReward', tick: sim.tick, rewardId }`。
- **UI 绝不调用** `addComponent` / `applyDamage` / `grantReward` / 任何写接口（spec 09 AC-01 的只读契约）。

**逻辑层重新校验**（`RewardSystem`）：选择必须命中**房间自己抽出的** `pendingRewards`。
UI 只能发 **id**，不能发索引或标签——陈旧点击（掉落已结算）与伪造 id 一律**静默忽略**，
房间继续等待。这是"那个选项本来就不在可选之列"的诚实结果。

### 4.4 AC-04 · 奖励结算与转场

`RewardSystem` 收到合法选择后，在**同一次写入**里完成：

1. `grantReward(world, playerId, rewardId)` —— 挂载词缀 / 直接改属性（§3.2 表）；
2. `pendingRewards = null`（清空掉落 ⇒ 重新打开调度器）；
3. `depth += 1`（下沉一层）；
4. `state = IN_PROGRESS`、`currentWaveIndex = 0`、`trackedEntityIds = []`、
   `nextSpawnTick = ENCOUNTER_WAVE_UNSCHEDULED`（重置为"待排期"）。

因为重置发生在 Tick 末尾，`EncounterSystem` 在**下一 Tick** 才看到它并排期生成
⇒ **选择后的下一波在"选择拍 + 1"生成**（与 spec 08「Tick `T` 生成的波次首次行动于 `T+1`」同构）。

**下一波更强**：`EncounterSystem.spawnWave` 用纯函数 `buildWaveRoster(enemies, depth)` 展开名单——
先原样保留配置敌人，再**按 `depth` 追加** `depth` 个副本（轮转取模板，沿 +x 偏移
`DEPTH_SPAWN_SPACING_UNITS = 1.5`）。`depth = 0` 时逐字返回配置 ⇒ **M4 的所有房间行为逐位不变**。

`grantReward` 的语义（`src/ecs/rewards/grantReward.ts`）：

- 词缀类奖励 = 挂 `ModifierComponent`（幂等，不叠加）；
- 属性类奖励（`hp_up` / `dash_up`）直接写字段，**可叠加**；`dash_up` 有下限 `MIN_DASH_COOLDOWN_TICKS = 10`；
- 未知 id 或已销毁实体 ⇒ 返回 `false`，不改动任何东西。

### 4.5 表现层（`#ui-layer` + `UIManager`）

- `index.html` 增加 `<div id="ui-layer"></div>`：`position: absolute; inset: 0; z-index: 10`，
  默认 `display: none`，抽奖时加 `is-visible` 类变为 `display: flex`（居中的遮罩 + 按钮列）。
- `client/UIManager.ts`：
  - `sync(world)`：读 `findRewardDraft(world)`；无掉落 ⇒ 清空并隐藏；
    有掉落且与上次渲染的 id 列表**相同** ⇒ 直接返回（**不重建 DOM**）；否则重建按钮。
  - 按钮文案取自 `getRewardDefinition(id)?.label ?? id`（单向读取逻辑层的奖池表）。
  - 点击 ⇒ 调用构造时注入的 `onSelect(rewardId)` 回调。
  - `destroy()`：清空 `#ui-layer`。
- `client/main.ts`：把回调接到 `sim.inject({ kind: 'selectReward', tick: sim.tick, rewardId })`，
  并用 `app.ticker.add(() => ui.sync(sim.world))` 每帧观测。
- **绝对禁止在 `client/` 执行随机逻辑**：`client/` 不含任何 PRNG 调用；抽奖**只在** `src/` 由 `world.rng` 完成。

---

## 5. 管道位置

### 5.1 硬契约（**15 段**，不得重排）

```
TransformSnapshotSystem → PlayerControllerSystem → FreezeSystem → AISystem
  → MovementSystem → DashSystem → StateSystem → CombatActionSystem
  → CollisionSystem → StatusEffectSystem → ModifierSystem → DeathSystem
  → EncounterSystem → RewardSystem → LifespanSystem
```

### 5.2 为什么 `RewardSystem` 落在 `EncounterSystem` 与 `LifespanSystem` 之间

- **必须在 `EncounterSystem` 之后**：`EncounterSystem` 是**抽奖的制造者**（`ROOM_CLEARED` 转移）。
  排在它之前，意味着一次选择最早也只能在"掉落出现"的下一 Tick 才被受理，
  而且"有掉落吗"这个问题会无谓地针对上一 Tick 的世界作答。紧邻其后，循环的两半
  （抽奖 → 结算）相邻且可读，并保证结算针对的是**本 Tick** 的掉落。
- **必须在 `LifespanSystem` 之前**：`LifespanSystem` 恒为最后一段（spec 05 C7）。
- **`LifespanSystem` 仍是最后一段**：它绝不能在判定圆被本 Tick 碰撞测试之前销毁它。

**相位后果（记录而非偶然）**：下沉后的房间在**下一 Tick** 才被 `EncounterSystem` 拾起，
故更深的波次在"选择拍 + 1"生成。

### 5.3 同步的钉桩测试

改管道会打断 5 处 `toEqual` 名数组 + 1 处相对位置断言，已同步：
`tests/combat/{boons,feedback,status_effects,death_and_encounter}.test.ts`、`tests/ai/enemy_fsm.test.ts`
（并新增 `tests/combat/roguelike_loop.test.ts` G9 的相邻性断言）。
**探针插入点一律按名 `findIndex` 定位，禁硬编码索引。**

---

## 6. 逐 Tick 契约（单波房间，`delayTicks = 0`，1 敌人，玩家空闲）

`sim.step(n)` 处理 Tick `0..n-1`，时钟停在 `n`。`EncounterFactory.spawn` **不生成**首波。

| Tick | 事件 | `state` | `depth` | `trackedEntityIds` | `pendingRewards` | 玩家意图 |
|---|---|---|---|---|---|---|
| `0` | `EncounterSystem` 惰性排期（`nextSpawnTick = 0`）并生成首波 | `IN_PROGRESS` | `0` | `[E]` | `null` | 正常 |
| `1` | 敌人 `hp` 归零 → `DeathSystem` 打死亡标签 → `EncounterSystem` 检测清空 → **抽奖** | `ROOM_CLEARED` | `0` | `[E]`（保留） | `[3 项]` | 正常（本 Tick 早已运行） |
| `2` | `EncounterSystem` 惰性跳过；注入 `selectReward` → `RewardSystem` **结算** | `IN_PROGRESS` | `1` | `[]` | `null` | **被压制**（`T+1` 起） |
| `3` | `EncounterSystem`：名单空 → 排期 `3` → 生成 `buildWaveRoster(base, 1)` = **2 敌人** | `IN_PROGRESS` | `1` | `[E1, E2]` | `null` | 自由 |

关键相位：

- **清空检测与死亡同拍**（`DeathSystem` 早于 `EncounterSystem`，spec 08 §5.2）⇒ 掉落在清空当拍出现。
- **压制自 `T+1` 起**（`PlayerControllerSystem` 是第 1 段，早于第 12 段的 `EncounterSystem`）。
- **下一波在"选择拍 + 1"生成**（`RewardSystem` 是第 13 段，其写入在 Tick 末尾）。

---

## 7. 验收标准

| ID | 判据 | 断言位置 |
|---|---|---|
| **AC-01** | 房间转入 `ROOM_CLEARED` 时，`pendingRewards` 恰为 **3 个互不相同**的合法 `rewardId`；同种子两跑**严格一致**；未清空的房间**永不**抽奖 | `roguelike_loop.test.ts` G2 / G1 |
| **AC-02** | 有待选项时：`sim.tick` 继续递增（时间流逝）；`EncounterSystem` 不生成/不推进；玩家 `moveVector=(0,0)`、两脉冲 `false`、不被位移、不产生判定圆；结算后立即恢复自由 | `roguelike_loop.test.ts` G3 |
| **AC-03** | 表现层只读：点击只注入 `SelectRewardEvent`；逻辑层**重新校验** `rewardId ∈ pendingRewards`，伪造 id / 未在选项中的合法 id / 无掉落时的选择一律被忽略；同 Tick 两次选择只结算一次 | `roguelike_loop.test.ts` G6 / G4 |
| **AC-04** | 合法选择 ⇒ 奖励生效（且**只有**被选中的那项生效）、`pendingRewards = null`、`depth += 1`、房间重置为 `IN_PROGRESS`、下一 Tick 生成 **`1 + depth`** 个敌人的更强一波 | `roguelike_loop.test.ts` G4 / G5 / G7 |
| **AC-05** | 管道为 15 段，`RewardSystem` 位于 `EncounterSystem` 之后、`LifespanSystem` 之前，且 `LifespanSystem` 仍是最后一段 | `roguelike_loop.test.ts` G9 + 4 处既有钉桩 |
| **AC-06** | `Random` 是种子的纯函数（同种子逐位一致、不同种子分叉）；`src/` 无 `Math.random`；整条循环同种子**回放逐位一致**；`client/` 不含随机逻辑 | `roguelike_loop.test.ts` G0 / G8 + ESLint 门 |

---

## 8. 校验与错误处理

| 场景 | 行为 |
|---|---|
| `Random` 构造时 `seed` 非有限数 | `RangeError` |
| `nextInt(min, max)`：非整数 / `min > max` | `RangeError` |
| `pick([])` | `RangeError`（"从空集抽"是调用方 bug，返回 `undefined` 只会把失败推给每个消费者） |
| `sample(items, count)`：`count` 非非负整数 / `count > items.length` | `RangeError`（无法满足的抽奖必须在接缝处炸掉） |
| `draftRewards` 的 `count > pool.length` | `RangeError` |
| `grantReward`：未知 id / 已销毁实体 | 返回 `false`，**不改动任何东西**（不抛异常：与 `ModifierSystem` 对"无 handler 的 id"静默跳过同一姿态） |
| 奖励实体的组件缺失（如 `hp_up` 但无 `HealthComponent`） | 返回 `false`，不写半个字段 |
| 玩家不存在（世界中没有 `PlayerInputComponent`） | 选择被忽略，掉落**保留**（房间继续等待） |
| 抽奖期注入 `selectReward` 但 id 非法 | 掉落保留，房间继续等待 |
| `sim.inject` 注入过去的 Tick | `RangeError`（既有契约，spec 00 §4）——陈旧点击会**响亮失败**而不是悄悄污染回放 |

---

## 9. 测试计划

新增 `tests/combat/roguelike_loop.test.ts`（30 用例，G0–G9），全程使用**真实** `GameSimulator`
+ 15 段管道 + 真实预制体，**不 mock**，逐 Tick 推进：

- **G0** PRNG 原语：种子纯度、默认种子常量、`[0,1)` 右开、`nextInt` 双端闭且触达两端、
  `pick` / `sample` 无放回且不改调用方数组、非法输入抛错。
- **G1** 抽奖：奖池形状、同种子一致、不同种子分叉、可注入自定义池。
- **G2** 清空房间抽奖：掉落恰在 `ROOM_CLEARED` 当拍出现；未清空则永不抽奖。
- **G3** 压制：时间照走 + 调度器受限 + 玩家零意图 / 零位移 / 零判定圆；结算后立即恢复。
- **G4** 结算：只有被选中的奖励生效（`toEqual` 完整前后状态）、掉落清空、房间重置、下一 Tick 生成更深一波。
- **G5** `grantReward`：`hp_up`（含不越上限）、`dash_up`（含下限）、词缀幂等、未知 id / 已销毁实体被拒。
- **G6** 只有被提供的选项可被选取：伪造 id、未在选项中的合法 id、无掉落时的选择、同 Tick 双选择。
- **G7** 升级：`buildWaveRoster` 纯度 + `1 → 2 → 3` 的实际增长。
- **G8** 整条循环同种子回放逐位一致（7 帧快照 `toEqual`）。
- **G9** 管道位置。

**变异测试（门控类改动的必做步骤）**：本 Spec 的 4 处关键门各做过一次变异，全部被捕获：

| 变异 | 被捕获于 |
|---|---|
| 去掉 `RewardSystem` 的 `pending.includes(selection)` 校验 | G6 × 2 |
| 去掉 `PlayerControllerSystem` 的压制（`held = false`） | G3 × 1 |
| `Random.sample` 改为有放回（不删已抽项） | G0 / G1 × 2 / G2 × 1 |
| 去掉 `EncounterSystem` 的 `draftRewards` 写入 | G2 / G3 × 2 / G4 × 2 / G6 × 3 / G7 / G8 |

---

## 10. 取舍（Trade-offs）

1. **选择意图走既有 `InputQueue`，而非新建"全局指令队列"**。
   收益：复用既有的按 Tick 对齐、FIFO 顺序、`inject` 过去 Tick 守卫、`GameLoop` 注入时序纪律；
   零新增失同步点。代价：`src/core/input.ts` 出现一个带**玩法词汇**的事件变体
   （`selectReward` / `rewardId`），`core` 层因此不再严格"无游戏概念"。
   接受理由：该队列**本就是**本项目的"外部指令通道"（它已承载 `move` / `keyDown`），
   而一次 UI 点击与一次按键在"外部、按 Tick 对齐"这一维度上同类；
   换取的是四条已固化的确定性保证，代价是命名上的一点妥协。
2. **PRNG 挂 `World`，而非 `SystemContext` 或逐系统注入**。
   收益：单一随机流（两条同种子流会抽出**相同**数列——同一个 bug 发生两次）；
   不触碰冻结的 `SystemContext` 契约。代价：通用 ECS 层多了一个非 ECS 字段
   （ADR-004 §5.2 已记录该偏离及其理由）。
3. **PRNG 状态不进 Snapshot**。
   收益：快照不膨胀。代价：无法直接断言"随机数被多抽了一次"。
   缓解：任何抽取顺序的分歧都会立刻表现为它**所产生的状态**的分歧（不同词缀 / 不同敌人），
   快照比较**仍然**是有效的回放守卫（ADR-004 §6）。
4. **`hp_up` / `dash_up` 作为"直接属性奖励"而非修饰器**。
   收益：它们**不是**"持有并响应命中"的东西，建模成修饰器会得到一个"可见地什么都不做"的奖励。
   代价：`grantReward` 需要一个 `if` 链而非纯查表；奖池因此有两种奖励类型。
   未来若奖励种类增多，应引入 `IRewardHandler` 注册表（与 `ModifierRegistry` 同构）。
5. **`depth` 复用同一份房间配置 + 追加敌人，而非生成新房间**。
   收益：M4 的房间行为逐位不变（`depth = 0` 时 `buildWaveRoster` 返回原配置）；
   无需第二张配置表或关卡生成器。代价：难度曲线是"同一房间更挤"，
   而不是"新房间新布局"——真正的房间生成留给后续里程碑（§1.3）。
6. **压制玩家意图而非冻结玩家**。
   收益：无需新增系统、无需触碰 `FreezeSystem` 的顿帧语义（顿帧是"暂停"，这里是"菜单"）；
   实现落在唯一的意图咽喉。代价：压制期间玩家仍会"消耗"按键的按下/抬起
   （设备快照阶段 1 不压制），即按键在抽奖期间不会被"吃掉"——这是刻意的（§4.2 细节 2）。

---

## 11. 已知风险与缓解

| 风险 | 缓解 |
|---|---|
| `#ui-layer` 遮罩挡住画布导致无法操作 | 仅在抽奖期显示（`is-visible`）；结算当帧即被 `sync` 隐藏 |
| 玩家在抽奖期"看着像卡住" | 遮罩 + 居中标题明确提示"选择祝福"；`main.ts` 的 HUD 显示待选项数量 |
| 抽奖只出现一次（房间永不再清空） | `depth` 下沉 + `buildWaveRoster` 递增，玩家可反复清空同一房间 |
| 奖池被改成 < 3 项导致抽奖抛错 | `draftRewards` 抛 `RangeError`（接缝处失败）；`roguelike_loop.test.ts` G1 断言池 ≥ 抽奖数 |
| 固定默认种子使 demo 每局相同 | 刻意行为（ADR-004 §5.3）；`GameSimulatorOptions.seed` 提供每局变化的入口 |
