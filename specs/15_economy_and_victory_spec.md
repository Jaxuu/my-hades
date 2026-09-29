# 15 · Economy & Victory Spec（经济拾取物、多房间序列与游戏胜利）

| Field | Value |
|---|---|
| Spec ID | `SPEC-15-ECONOMY-VICTORY` |
| Milestone | **M9 · 经济与终局**（T01） |
| Status | `accepted`（本文件为 M9-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/LootComponent.ts`（新）、`src/ecs/components/InventoryComponent.ts`（新）、`src/ecs/components/PickupComponent.ts`（新）、`src/ecs/components/GameStateComponent.ts`（`RUN_WON` / `markRunWon` / `isRunWon` / `isRunOver`）、`src/ecs/components/EncounterStateComponent.ts`（`roomWaves` / `maxRooms` / `currentRoomIndex` / `isFinalRoom`）、`src/ecs/components/index.ts`、`src/ecs/systems/PickupSystem.ts`（新）、`src/ecs/systems/index.ts`、`src/ecs/systems/pipeline.ts`（**第 17 段**）、`src/ecs/systems/DeathSystem.ts`（掉落）、`src/ecs/systems/LifespanSystem.ts`（拾取物寿命）、`src/ecs/systems/EncounterSystem.ts`（`RUN_WON`）、`src/ecs/systems/RewardSystem.ts`（房间推进）、`src/ecs/systems/PlayerControllerSystem.ts`（`isRunOver` 压制）、`src/ecs/prefabs/spawn-helpers.ts`（`loot` opt-in + 钱包）、`src/ecs/prefabs/EncounterFactory.ts`（`rooms`）、`client/GameRenderer.ts`（拾取物视图）、`client/UIManager.ts`（金币 HUD + 胜利覆盖层）、`client/main.ts`、`index.html`、`tests/combat/economy_and_victory.test.ts`（新）、7 份既有测试的管道钉桩 |
| Depends on | `specs/00_harness_spec.md`（时钟 / 输入 / ECS / Snapshot 契约）、`specs/03_combat_hitbox_spec.md`（判定圆 / `activeTicks` / 顿帧与硬直的唯一写点）、`specs/04_combat_feedback_spec.md`（顿帧 / 硬直 / 击退相位）、`specs/08_encounter_and_death_spec.md`（`DeadTagComponent` 是死亡唯一权威 / 房间调度 / 死亡是状态不是删除）、`specs/11_roguelike_loop_spec.md`（三选一奖励 / 种子契约 / `depth` 难度盘）、`specs/13_arena_and_projectiles_spec.md`（投射物装配与 `hitstopTicks = 0` 的先例）、`specs/14_aoe_and_run_lifecycle_spec.md`（`GameStateComponent` / `restartRun` / 「失败的一局是惰性的」先例） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

到 M8-T01 为止，这个引擎已经能打完一场「战斗」：波次会来、敌人会死、玩家会死、房间会清空、一局能重置。但它缺两样东西，而这两样恰好是「一局」之所以是一局的原因：

1. **打的理由。** 击杀目前不产出任何东西。玩家没有可累积的资源，「打得干净」与「打得狼狈」在数值上没有区别，因此也没有任何理由去冒风险多杀一个。
2. **尽头。** 房间清空只会滚出三选一、然后原地再打一遍更硬的同一间房（M6 的 `depth` 升级）。它永远不会结束，因此永远没有「我赢了」这一格。

M9-T01 补上这两件事：**击杀掉落可拾取的金币与血瓶**（经济），**一局由固定数量的房间组成，清空最后一间即获胜**（终局）。

### 1.2 In Scope（做什么）

- 掉落声明（`LootComponent`）与死亡时的拾取物生成（AC-01）。
- 地面拾取：圆重叠判定、效果结算、拾取物清理（AC-02）。
- 玩家的钱包（`InventoryComponent`）与表现层金币 HUD。
- 拾取物的独立存活时间与到期销毁。
- 一局的房间表（`roomWaves` / `maxRooms` / `currentRoomIndex`）与逐房间推进（AC-03）。
- `GameStatus.RUN_WON`、终房清空即获胜、胜利覆盖层与 `R` 重开（AC-04）。
- `restartRun` 对经济与房间进度的清零验证。

### 1.3 Out of Scope（显式排除）

- **商店 / 消费。** `addGold` 允许负数并钳在 `0`，但本里程碑没有任何消费入口；金币目前只是分数。
- **掉落概率表。** 掉落是**确定性声明**（一个敌人掉什么写在它的 spec 里），不是「按概率抽」。引入随机掉落需要一条新的 PRNG 消费点与一套保底规则，属于独立里程碑；本里程碑的掉落表**必须**逐位可复现。
- **磁吸 / 拾取半径升级 / 自动拾取。** 拾取只有一种方式：身体圆与拾取圆重叠。
- **`HEAL` 之外的消耗品语义**（无敌帧药水、临时增益等）。`PickupKind` 是本里程碑唯一的效果分类轴，新增种类 = 加枚举值 + 加 `PickupSystem` 的一个分支。
- **失败/胜利之间的中途存档。** `restartRun` 仍然只有「重开」一种选择。
- **金币的持久化跨局。** 一局的金币随 `restartRun` 消失（AC-07），不做 meta 进度。
- **拾取物的物理**（弹跳、被击退、被墙推）。见 §2 I2：这是**结构性**排除，不是遗漏。

---

## 2. 术语与不变量

| ID | 不变量 | 为什么它是硬的 |
|---|---|---|
| **I1** | 一个 Pickup 实体**恰好**拥有 `TransformComponent` + `PickupComponent` 两个组件，且**没有** `HitboxComponent` / `HurtboxComponent` / `HealthComponent` / `FactionComponent` / `VelocityComponent` / `IntentComponent` / `StateComponent`。 | 交付标准要求「拾取不得触发 HITSTUN / Hitstop，且不得阻挡移动或吸收投射物」。这四条全部由组件集**结构性地**保证，而不是靠代码里记得写门控：顿帧与 `HITSTUN` 在引擎中只有 `CollisionSystem` 一个写点，而它的生产者查询是 `(Transform, HitboxComponent)`；`MovementSystem.resolveWalls` 的目标集是 `(Transform, Velocity)`；`AISystem` 的自动索敌集需要 `Faction`。缺一个组件，就少一整类系统能看见它。 |
| **I2** | 拾取物**不会移动**。它的坐标在生成那一刻确定，之后只被读取。 | 与 I1 同源：没有 `VelocityComponent` ⇒ 不被墙解算；没有 `IntentComponent` ⇒ 不被任何系统驱动。地面上的东西就应该待在原地。 |
| **I3** | 一个敌人死亡时生成的 Pickup 数量 = 它 `LootComponent.drops` 的长度，位置为尸体坐标沿 `+x` 依次偏移 `LOOT_DROP_SPACING_UNITS × index`。 | 固定常量偏移而非随机散布：掉落图案必须可复现（同 `DEPTH_SPAWN_SPACING_UNITS` 的理由），且两个掉落不能叠成「一个金币」。 |
| **I4** | 拾取判定使用**严格小于**：`dx² + dy² < (pickup.radius + hurtbox.radius)²`。恰好相切**不算**拾取。 | 与 `CollisionSystem` 的判定圆谓词逐字一致。相切是稳定态而非闪烁态：站在边缘上不会被反复拾取/不拾取。 |
| **I5** | 一次拾取**恰好**被一个收集者消费一次。 | `markDead` 使拾取物在本 Tick 剩余时间里不可再被拾取，`break` 结束收集者循环。 |
| **I6** | 拾取物的存活时间 `lifespanTicks` 在组件上，由 `LifespanSystem` 每 Tick 自减 1，`<= 0` 即销毁。 | 时间只由 `step()` 推进、且只存在组件上（spec 00 §6.1）。`lifespanTicks = N` ⇒ 恰好 `N` 个 Tick 可被拾取，与 `HitboxComponent.activeTicks` 逐位同构。 |
| **I7** | `pendingRewards !== null` ⟹ `state === ROOM_CLEARED`；且 `RUN_WON` 的那一 Tick **必然** `pendingRewards === null`。 | 沿用 spec 11 的既有不变量，并追加终局约束：终房不滚三选一（AC-04），所以「一局赢了」与「有一份待选奖励」互斥。 |
| **I8** | `roomWaves.length === maxRooms ≥ 1`，且 `roomWaves[0] === waves` 恒成立（`waves` 恒为**当前房间**的波次配置）。 | `waves` 是 `EncounterSystem` 唯一读取的配置字段，`roomWaves` 是不可变的房间表。推进房间 = 把 `waves` 换成表里的下一项，而不是让消费者去查表。 |
| **I9** | 终房判据唯一：`isFinalRoom(encounter)` ⟺ `maxRooms > 0 && currentRoomIndex >= maxRooms - 1`。 | 两个系统（`EncounterSystem` 清房时、`RewardSystem` 结算时）问同一个问题，必须只有一个答案。 |
| **I10** | `RUN_FAILED` 与 `RUN_WON` 是**兄弟**终局，不是链条：二者互斥、均不可从对方进入，且都只由各自的唯一写点写入（`DeathSystem` / `EncounterSystem`）。 | 一局不可能既赢又输；`isRunOver` 是唯一的「这局不再做任何决策」谓词，所有原本问 `isRunFailed` 的门控改问它，于是赢局与输局**同样**惰性，而不需要第二处门控。 |
| **I11** | 一局的 `GameStatus` 从 `PLAYING` 出发只走一步；唯一的回头路是 `GameSimulator.restartRun`（全量重建世界）。 | 沿用 spec 14 I7。`restartRun` 之后金币、装备、房间进度全部归零，因为承载它们的实体被整体销毁并重建。 |

---

## 3. 数据契约

### 3.1 `LootComponent`（新）

```
class LootComponent extends ComponentBase {
  readonly drops: readonly ResolvedLootDrop[];   // 已解析、已校验、声明序
}
interface LootDropOptions   { kind; amount?; radius?; lifespanTicks? }
interface ResolvedLootDrop  { kind; amount;  radius;  lifespanTicks  }
```

- **挂在尸体上，而不是查表。** 掉落表是**这个敌人的 spec 的一部分**（`CombatantSpawnOptions.loot`），与 `EncounterWaveConfig.enemies` 携带完整 spec 的理由一致（spec 08 §3.2）：按敌人类型建一张全局掉落表，就是又一张快照看不见、测试必须额外搭起来的表。
- **在装配期解析并校验**（`resolveLootDrops`）。`DeathSystem` 在 `step()` 内部运行，掉落若在那里才暴露出错，会**在 Tick 中途炸掉一局**。因此在 `spawnCombatant` 就把整张表解析成 `ResolvedLootDrop[]`：到 `DeathSystem` 读它时，每个数字都已确定，`step()` 里不可能抛异常。
- **空表抛 `RangeError`。** 挂一个永远产不出拾取物的 `LootComponent`，会让「这个敌人掉东西」变成一句快照与读者都无法与正常掉落区分的谎话。要表达「什么都不掉」，**省略 `loot` 字段**。
- `defaultLootAmount(kind)`：`GOLD → 5`、`HEAL → 20`。这是 `DEFAULT_GOLD_AMOUNT` / `DEFAULT_HEAL_AMOUNT` 的唯一入口，不重复字面量。

### 3.2 `InventoryComponent`（新）

```
class InventoryComponent extends ComponentBase { gold: number }
addGold(world, id, amount): boolean
findPlayerInventory(world): InventoryComponent | undefined
readGold(world): number
```

- **只装金币。** 装备**不在这里**：玩家拿到的祝福已经由 `ModifierComponent` 承载（spec 05 §3.3）。再存一份 `equipment` 列表就是第二个真相源，会在第一条不经过本文件的加词缀路径上立刻漂移。因此 AC-07 的「装备清零」断言打在 `ModifierComponent` 上，而不是打在它的副本上。
- **装配位置**：`spawnCombatant` 在 `hardwareInput === true` 的分支里与 `PlayerInputComponent` 一起挂载。`PlayerInputComponent` 是本引擎结构性的「这是玩家」标记（spec 01 §3.3），挂在同一分支上，使「玩家有钱包」由构造保证，且**不可能**给 AI 敌人挂上钱包。
- `addGold` 对负数钳在 `0`：消费是显而易见的下一步用法，一个钳制比再写一个带余额检查的 `spendGold` 便宜。
- `readGold` 对没有钱包的世界返回 `0`，于是表现层不需要自己编码「没有钱包等于零」。

### 3.3 `PickupComponent`（新）

```
enum PickupKind { GOLD = 'GOLD', HEAL = 'HEAL' }

class PickupComponent extends ComponentBase {
  radius: number;          // > 0，世界单位
  kind: PickupKind;
  amount: number;          // > 0 有限数
  lifespanTicks: number;   // 正整数，剩余存活 Tick
}

spawnPickup(world, options: PickupSpawnOptions): EntityId   // 单一装配点
```

常量：

| 常量 | 值 | 理由 |
|---|---|---|
| `DEFAULT_PICKUP_RADIUS` | `0.6` | 大于玩家 hurtbox（`0.5`）：判定取**半径之和**，所以金币在略超一个身位处就能吃到。要求像素级对心会把「走过去」变成苦差事。 |
| `DEFAULT_PICKUP_LIFESPAN_TICKS` | `600` | 10 秒 @60fps。长到掉落它的那一波打完之前不会过期，短到被放弃的竞技场不会堆满陈货。 |
| `DEFAULT_GOLD_AMOUNT` / `DEFAULT_HEAL_AMOUNT` | `5` / `20` | 一个普通敌人掉一次 ≈ 1/20 次 `hp_up` 的量级；`HEAL` 一次回 20% 血量。 |
| `LOOT_DROP_SPACING_UNITS` | `1.2` | `2 × radius`：同一敌人的多个掉落不重叠（I3）。 |

`spawnPickup` 校验 `x` / `y` 有限、`radius` / `amount` 正有限、`lifespanTicks` 正整数，**全部通过才创建实体**（与 `spawnHazard` / `spawnProjectile` 同一纪律：被拒绝的拾取物不漏实体）。

### 3.4 `GameStateComponent` 扩展

```
enum GameStatus { PLAYING, RUN_FAILED, RUN_WON }        // + RUN_WON
markRunWon(world): void                                  // 唯一写点，幂等
isRunWon(world): boolean
isRunOver(world): boolean                                // FAILED || WON
```

- `RUN_WON` 与 `RUN_FAILED` 并列，**不是**第三个阶段的链条（I10）。
- `markRunWon` 的调用者**只有** `EncounterSystem`：它是唯一知道「终房最后一波没了」的地方，而这就是 AC-04 的全部。
- 它**不清 `pendingRewards`**：赢了的一局按构造就没有待选奖励（终房不滚），而从手工搭出来的房间进到这里时，把草稿留在原处好过让世界自相矛盾。
- 没有 `GameStateComponent` 的世界永远不会赢（与 spec 14 AC-11 的 opt-in 读法一致）。

### 3.5 `EncounterStateComponent` 扩展

```
+ roomWaves: readonly (readonly EncounterWaveConfig[])[]   // 一局的房间表，不可变
+ maxRooms: number                                          // === roomWaves.length, >= 1
+ currentRoomIndex: number                                  // 0 起，每结算一次奖励 +1

isFinalRoom(encounter): boolean                             // 自由函数，唯一终房判据
```

- 构造函数新增的三个参数**追加在末尾**，默认值 `roomWaves = [waves]`、`currentRoomIndex = 0`、`maxRooms = roomWaves.length`，因此既有的单参数构造（`new EncounterStateComponent(waves)`）语义不变。
- `currentRoomIndex` **不是** `depth`：`depth` 是难度盘（spec 11 AC-04）数的是**下降次数**，`currentRoomIndex` 数的是**房间号**。今天两者同步推进，但分开之后，「重访同一房间」的未来设计可以在不谎报房间号的前提下提高难度。
- `isFinalRoom` 对 `maxRooms <= 0`（只能由手工装配得到）返回 `false`：把一个不存在的房间报成「最后一间」是错得最没用的方式。

### 3.6 `EncounterRoomConfig` 扩展

```
interface EncounterRoomConfig {
  waves: readonly EncounterWaveConfig[];                        // 开局的第 0 间房
  rooms?: readonly (readonly EncounterWaveConfig[])[];          // 其后的房间，按序
}
```

- **总数 = `1 + (rooms?.length ?? 0)`。** 省略 `rooms` ⇒ 单房间的一局，**既有全部调用点逐字不变**。
- 声明为「第 0 间之后的房间」而非完整表 `[waves, ...rooms]`：完整表会让 `waves` 成为 `roomWaves[0]` 的副本，而副本就是一个等着被第一个编辑者踩响的漂移 bug。
- `resolveEncounterRooms` 校验**整张表**（含玩家可能永远到不了的房间）：一局在第三间房才崩，是十分钟游玩之后才出现的 bug。`resolveEncounterConfig` 保留原签名（返回开局房间的波次），并以 `resolveEncounterRooms` 实现，因此校验只有一份实现。

### 3.7 `CombatantSpawnOptions.loot`（新 opt-in）

```
readonly loot?: readonly LootDropOptions[];
```

第五个 opt-in 能力（与 `ai` / `armor` / `hazard` 同构）。省略 ⇒ **不挂** `LootComponent`，所有 M1–M8 的敌人行为逐位不变。空数组抛 `RangeError`（§3.1）。

---

## 4. 语义契约

### 4.1 AC-01 · 掉落：死亡那一刻，在尸体坐标

`DeathSystem` 的每次死亡处理追加一步 `dropLoot`，位置在挂死亡标签、中和意图、发死亡事件**之后**：

```
1. markDead(world, id)                  // 死亡标签
2. neutraliseIntent(world, id)          // 意图清零
3. emit(EntityDeathEvent)               // 死亡总线
4. dropLoot(world, id)                  // ← M9-T01：掉落
5. failRunIfPlayer(world, id)           // ← M8-T01：玩家死 ⇒ 一局失败
```

**为什么放在 `DeathSystem` 而不是新增 `LootSystem` 段**：掉落回答的问题是「**这次死亡**留下了什么」，而这个循环是引擎里唯一知道「刚刚发生了一次死亡、死的是谁」的地方——正是 `failRunIfPlayer` 已经记录的同一个论据。独立的一段还得从它没有写入的死亡标签里重新推导「本 Tick 谁死了」，并且为了读一份就在手边的数据而多付一个管道槽位。于是掉落与死亡标签**落在 Tick 的同一个点上**：拾取物不可能跨过那条把「活敌人」与「尸体」分开的 Tick 边界。

掉落只读 `LootComponent` 与 `TransformComponent`：缺前者（M9 之前的所有敌人、以及一切非战斗单位）静默 no-op；缺后者（凭空造的实体）也 no-op——掉落需要落点，凭空编一个原点比什么都不掉更糟。在 `query(HealthComponent)` 循环里创建实体是安全且确定的：`query` 返回新的升序数组，而拾取物没有 `HealthComponent`，不可能被创建它的循环访问到。

### 4.2 AC-02 · 拾取：圆重叠 → 效果 → 标记死亡

`PickupSystem` 每 Tick：

```
0. if (isRunOver(world)) return;                       // 终局的一局不收货
1. pickups = query(PickupComponent, TransformComponent)
2. collectors = query(PlayerInputComponent, TransformComponent,
                      HurtboxComponent, InventoryComponent)
3. 对每个 pickup（升序）：
     if (isDead) continue                              // 本 Tick 已被消费
     对每个 collector（升序）：
       if (isDead) continue                            // 尸体不收东西
       if (dx²+dy² >= (pickup.radius + hurtbox.radius)²) continue   // 严格小于（I4）
       applyEffect(...)                                // 加钱 或 回血（钳在 maxHp）
       markDead(world, pickupId)                       // 标记死亡（I5）
       break
```

**收集者集合为什么是这四个组件**：设备（`PlayerInputComponent`，spec 01 §3.3 的结构性玩家标记）+ 身体半径（`HurtboxComponent`，本引擎唯一一处「这个实体的身体」的定义）+ 钱包（`InventoryComponent`，钱要放进去）。要求钱包是刻意的：一个手工搭出来、没有 `InventoryComponent` 的「玩家」没有地方放金币，把金币凭空吃掉比留在原地更糟。

**「标记死亡」而不是「就地销毁」**：`markDead` 是本引擎说「这个实体已经作废」的唯一方式（spec 08 §3.1），而**把这件事变成真正的移除**是 `LifespanSystem`（其职责字面就是「瞬态实体的到期与销毁」）在同 Tick 末尾完成的。一次转移、一个归属者；并且「已拾取」在快照里对剩余 Tick 可见，而不是在某个系统内部凭空消失。

**为什么拾取绝不可能是「一次命中」**（交付标准的硬要求，逐条对应）：

| 要求 | 结构性原因 |
|---|---|
| 不触发 HITSTOP | 顿帧只由 `CollisionSystem` 的 `applyFreeze` 写入；拾取物没有 `HitboxComponent` ⇒ 进不了它的生产者查询 `(Transform, HitboxComponent)`。`PickupSystem` 自己也不写任何冻结。 |
| 不触发 HITSTUN | 同上：`HITSTUN` 只在 `CollisionSystem` 的 `state.state = HITSTUN` 一处写入。`PickupSystem` 完全不碰 `StateComponent`。 |
| 不产生 `HitEvent` | `HitEvent` 只在 `CollisionSystem` 发布。拾取不产生事件。 |
| 不阻挡移动 | `MovementSystem.resolveWalls` 的目标集是 `(Transform, Velocity)`；拾取物没有 `VelocityComponent` ⇒ 永远不会被反穿透，因此永远不会把走路的玩家推离他的路线。 |
| 不吸收投射物 | 投射物是 `(Transform, HitboxComponent)` 的实体，通过 `CollisionSystem` 与「目标集」结算；拾取物既不是生产者（无 hitbox）也不是目标（无 `Hurtbox`/`Faction`/`Health`）。投射物从它身上穿过，双方都不受影响。 |
| 不被 AI 索敌 | `AISystem` 的自动索敌集需要 `FactionComponent`。 |

这张表里没有一行是「本文件记得写了一个门控」——这正是它值得写下来的原因。

**回血钳在 `maxHp`**：溢出的治疗在 HUD 上看不见，并且会让「满血时吃血瓶」静默销毁价值。钳制是诚实的读法，而不是一个需要写文档绕开的边界。

**`isRunOver` 门（第 0 步）**：只覆盖 `RUN_WON`。`RUN_FAILED` 已被「尸体不收东西」的门覆盖（一局失败必然意味着玩家已死）；而赢了的一局里玩家**活得好好的**，可能正站在最后一枚金币上。没有这道门，胜利界面会罩在一个还在持续进账的世界上——正是 spec 14 AC-06 对波次明令禁止的「游戏还在继续」行为。

### 4.3 AC-01 / AC-02 · 拾取物的生命周期

`LifespanSystem`（恒 LAST）新增 `agePickups`，两个分支**顺序固定**：

```
对每个 pickup（升序）：
  1. if (isDead(world, id))  → destroyEntity(id); continue     // 已被拾取：作废即移除
  2. pickup.lifespanTicks -= 1
     if (lifespanTicks <= 0) → destroyEntity(id)                // 保险丝烧尽
```

- 分支 1 在前：**被拾取的拾取物没有剩下的保险丝可烧**，把它当过期处理是错的读法。
- 分支 2 与命中盒循环逐字同构：`lifespanTicks = N` 在 Tick `T` 生成 ⇒ 可在 Tick `T .. T+N-1` 被拾取，在 `T+N-1` 末尾消失，**恰好 N 个 Tick**。
- **与战斗单位的不对称是刻意的**：尸体被保留，因为房间调度器必须仍然能看见它（spec 08 §10 取舍 1）；而一枚花掉的金币没有任何消费者，保留它只会在一局里持续堆积实体。

### 4.4 AC-04 · 终房清空即获胜

`EncounterSystem.advance` 在「本房间没有下一波」的分支里，**先判终房，再滚三选一**：

```
if (nextWave === undefined) {
  encounter.state = EncounterState.ROOM_CLEARED;
  if (isFinalRoom(encounter)) { markRunWon(world); return; }   // ← AC-04
  encounter.pendingRewards = draftRewards(world.rng);          // 非终房才滚
  return;
}
```

- **不滚 = 连一次 PRNG 抽签都不消费。** 这使「终房什么都不滚」成为可观察事实（`pendingRewards` 在清房那一 Tick 就是 `null`），并且使回放看到的奖励流与「有没有走到最后一间房」无关——一个更晚到来的房间不会因为前面的房间数量不同而抽到不同的祝福。
- 房间**仍然**进入 `ROOM_CLEARED`（与 spec 08 AC-03 一致），`trackedEntityIds` **仍然保留**（空列表意味着「还没生成」，对一间已经打过的房撒谎）。
- `RewardSystem` 一侧有**结算侧的孪生守卫**：结算时若发现当前房间是终房，则 `markRunWon` 并直接返回（房间保持 `ROOM_CLEARED`）。在出厂配置下不可达（终房从不滚草稿），而这正是它存在的原因——另一种选择是越界的房间号，而「这局结束了」是一间没有后继的房间唯一诚实的答案。它的可达路径是**手工把草稿开在终房上**的对抗测试（见 §5 AC-04 的第二条）。
- `RUN_WON` 之后：`PlayerControllerSystem` 的 `suppressed` 因 `isRunOver` 为真而清零意图（AC-04 的「系统停止接收操作意图」），`EncounterSystem` 首行 `isRunOver` 早退，`PickupSystem` 第 0 步早退。

### 4.5 AC-03 · 房间推进

`RewardSystem` 结算一份草稿：

```
1. grantReward(world, playerId, selection)   // 先给奖励（玩家选了就该拿到）
2. room.pendingRewards = null                // 关闭草稿
3. if (isFinalRoom(room)) { markRunWon(world); return; }        // AC-04 结算侧守卫
4. room.currentRoomIndex += 1                // 房间号前进
5. room.depth += 1                           // 难度盘前进
6. room.waves = room.roomWaves[currentRoomIndex] ?? room.waves  // 载入下一间的波次配置
7. room.state = IN_PROGRESS; currentWaveIndex = 0;
   trackedEntityIds = []; nextSpawnTick = UNSCHEDULED
```

- 第 6 步就是 AC-03 的「加载下一关的波次配置」：`waves` 被换成表里的下一项，而 `EncounterSystem` 一行都不用改——它本来就读 `waves`。
- `?? room.waves` 对出厂装配的房间不可达（索引恒在表内），但它让这次替换是**全函数**，而不是可能产出 `undefined` 波次的操作。
- 第 7 步的写入发生在 Tick 末尾，因此重置后的房间被 `EncounterSystem` 在**下一 Tick** 接手——与 M6 记录的一拍相位一致（spec 11 §4.4），本里程碑不改动它。

### 4.6 表现层契约（只读）

- **金币 HUD**：`UIManager.sync` 的**第一步、无条件**更新 `#gold`（可选注入的 `hud` 元素），读 `readGold(world)`；只在数值**变化**时写 DOM。它不是覆盖层，因此在草稿或终局界面之上仍然正确显示。
- **胜利覆盖层**：`isRunWon` ⇒ `#ui-layer.is-visible.is-win`，标题 `ESCAPED!`、提示 `Press [R] to Restart`。与死亡覆盖层**共用一条渲染路径、两套皮肤**，因为两者只差文案与配色，而为第二个覆盖层复制一份键盘监听生命周期，正是其中一个最终会留下一个陈旧 handler 的方式。
- **`R` 键**：两个终局界面共用同一个 `onRestart` 回调（赢与输由完全相同的操作重开）。监听器**只**在终局界面挂载期间存在，否则它会在活着的局上触发重开。
- **拾取物视图**：`GameRenderer.createView` 的 `pickup` 分支**最先**判定（拾取物既无 `HazardComponent` 也无 `HitboxComponent`/`FactionComponent`，落进 `faction` 分支的早退就会静默隐形——对「玩家应当跑过去拿的东西」是最糟的失败模式）。几何一次画好（半径取 `PickupComponent.radius`，与逻辑层判定用的是同一个数），颜色按 `kind` 区分，无动画。
- 表现层**仍然**只读：不写组件、不 `step`、不掷骰。金币的数值与标签全部来自逻辑层。

---

## 5. 验收标准

| AC | 内容 | 判定 |
|---|---|---|
| **AC-01** | 带 `LootComponent` 的实体死亡时，在尸体坐标生成 `drops.length` 个 Pickup 实体，各自带独立的 `lifespanTicks`；掉落偏移为 `LOOT_DROP_SPACING_UNITS × index`。 | 见 §6.1 |
| **AC-02** | 玩家与 Pickup 圆重叠（严格 `<`）时触发拾取：`GOLD` 增加 `InventoryComponent.gold`，`HEAL` 回血并钳在 `maxHp`；随后 Pickup 被标记死亡并在本 Tick 末尾被销毁。 | 见 §6.2 |
| **AC-03** | `EncounterStateComponent` 定义 `maxRooms` / `currentRoomIndex`；每结算一次奖励 `currentRoomIndex += 1` 并载入下一房间的 `waves`；非终房的清房滚出三选一。 | 见 §6.3 |
| **AC-04** | 清空 `currentRoomIndex === maxRooms - 1` 的所有波次后，**不**滚三选一，直接把 `GameStatus` 切为 `RUN_WON`；此后玩家不再产出意图，`EncounterSystem` 与 `PickupSystem` 均早退。手工在终房开草稿再结算时，同样走 `RUN_WON` 而非越界推进。 | 见 §6.4 |
| **AC-05** | 拾取**绝不**触发 HITSTOP 或 `HITSTUN`，也不产生 `HitEvent`：拾取前后收集者的 `FreezeComponent` / `ActionState` / 顿帧状态不变，命中总线为空。 | 见 §6.5 |
| **AC-06** | Pickup **不**阻挡移动、**不**吸收投射物：穿过拾取物的位移与无拾取物时逐位相同；朝拾取物飞行的投射物既不消失也不偏转。 | 见 §6.5 |
| **AC-07** | `RUN_WON` 后调用 `restartRun()`：房间进度（`currentRoomIndex` / `depth` / `state`）、玩家金币、玩家装备（`ModifierComponent`）全部归零，时钟回 0，`GameStatus` 回 `PLAYING`。 | 见 §6.6 |
| **AC-08** | 确定性：同种子、同输入脚本的两台模拟器逐 Tick 快照全等；掉落与拾取不消费 PRNG（掉落是确定性声明，拾取是纯算术）。 | 见 §6.6 |
| **AC-09** | 管道为 **17 段**，`PickupSystem` 位于 `RewardSystem` 与 `LifespanSystem` 之间；`MovementSystem → DashSystem → StateSystem` 的相邻次序不变，`TransformSnapshotSystem` 恒 idx 0、`LifespanSystem` 恒 LAST。 | 见 §6.7 |
| **AC-10** | 零回归：未声明 `loot` 的实体组件集不变；无 `GameStateComponent` 的世界永不 `RUN_WON`；无拾取物的世界不被 `PickupSystem` 触碰；单房间配置的既有调用点逐字不变。 | 见 §6.7 |

---

## 6. 逐 Tick 时序契约（QA 可钉）

约定：`sim.step(n)` 处理 processed-tick `0 .. n-1`，之后 `sim.tick === n`。`delayTicks = 0` 的波次在其成为 PENDING 的那个 Tick 生成（`EncounterFactory.spawn` 不生成首波 ⇒ 调用方至少 `step()` 一次）。

### 6.1 掉落（AC-01）

装置：玩家在 `(0,0)`；敌人在 `(6,0)`，`maxHp = hp = 10`，`loot = [{GOLD, 5}, {HEAL, 20}]`。

| 处理 tick | 事件 | 该 Tick 末可观察 |
|---|---|---|
| 0 | `step(1)` | 敌人已生成；`query(PickupComponent)` 为空 |
| 1 | 测试先 `applyDamage(enemy, 999)` 再 `step(1)` | `DeathSystem`（idx 12）挂死亡标签 → `dropLoot` 生成 2 个 Pickup：`(6.0, 0)` 与 `(7.2, 0)`；两者 `lifespanTicks = 600`（本 Tick 尚未自减——`LifespanSystem` idx 16 随后自减为 `599`）；玩家金币仍为 `0`（玩家在 `(0,0)`，不重叠） |

> 注意：`LifespanSystem` 与 `DeathSystem` 同 Tick 运行，因此「本 Tick 生成」的拾取物在本 Tick 末尾就已自减 1。`lifespanTicks = N` 的可观察寿命仍是**恰好 N 个 Tick**（`T .. T+N-1`），与 `HitboxComponent.activeTicks` 同构。

### 6.2 拾取（AC-02）

装置：玩家在 `(0,0)`（`hurtbox.radius = 0.5`）；`spawnPickup({x: 3, y: 0, kind: GOLD, amount: 7})`（`radius = 0.6` ⇒ 判定半径和 `1.1`）。

| 处理 tick | 动作 | 该 Tick 末可观察 |
|---|---|---|
| 0 | `step(1)`，无输入 | 距离 3.0 ≥ 1.1 ⇒ 未拾取；`gold === 0`，Pickup 存活 |
| 1 | 注入 `move (1,0)` 并 `step(1)` | 玩家移动 `5 × 1/60 ≈ 0.0833`；距离仍远 |
| … | 持续按住 `+x` | 直到玩家 x 使 `dist < 1.1` 的那一 Tick：`gold === 7`，且 `world.isAlive(pickup) === false`（同 Tick 末尾由 `LifespanSystem` 销毁） |
| 同 Tick | 同一 Tick 内第二次拾取 | 不可能：Pickup 已 `markDead`（I5） |
| 恰相切 | `dist === 1.1` | **不**拾取（I4，严格 `<`） |

### 6.3 房间推进（AC-03）

装置：`EncounterFactory.spawn(world, { waves: W0, rooms: [W1] })`，`W0` / `W1` 各一波 `delayTicks = 0`、一个敌人。玩家 + `GameStateComponent`。

| 处理 tick | 事件 | 该 Tick 末可观察 |
|---|---|---|
| 0 | `step(1)` | 房间 0 的波次生成；`currentRoomIndex = 0`、`maxRooms = 2`、`depth = 0` |
| 1 | 击杀该敌人后 `step(1)` | 检测到清空 ⇒ `ROOM_CLEARED` + 滚出 3 选 1；`currentRoomIndex` 仍为 `0` |
| 2 | 注入 `selectReward`（`tick = 2`）后 `step(1)` | `RewardSystem` 结算：奖励到手、`pendingRewards = null`、`currentRoomIndex = 1`、`depth = 1`、`waves === W1`、`IN_PROGRESS`、`trackedEntityIds = []` |
| 3 | `step(1)` | 房间 1 的波次生成（`delayTicks = 0` ⇒ 下一 Tick） |

### 6.4 终局（AC-04）

承接 §6.3，继续：

| 处理 tick | 事件 | 该 Tick 末可观察 |
|---|---|---|
| 4 | 击杀房间 1 的敌人后 `step(1)` | `isFinalRoom` 为真 ⇒ `state = ROOM_CLEARED`、`markRunWon`、**`pendingRewards === null`**、`GameStatus.RUN_WON`；**没有**消费 PRNG |
| 5 | 注入 `move (1,0)` 与 `keyDown ATTACK` 后 `step(1)` | 玩家 `IntentComponent.moveVector === (0,0)`、`wantsToAttack === false`、坐标不变；无新命中盒；无新实体 |
| 5 | 手工把 `pendingRewards` 开在终房上，再 `selectReward` 结算 | `markRunWon`（结算侧守卫），`currentRoomIndex` **不**越界 |

### 6.5 无反馈 / 无阻挡（AC-05 / AC-06）

| 断言 | 手法 |
|---|---|
| 无顿帧 | 拾取前后 `isFrozen(collector) === false`；`FreezeComponent.remainingTicks` 不变（或组件不存在） |
| 无 `HITSTUN` | 拾取后 `state.state !== HITSTUN`（保持 `IDLE` / `MOVING`），`ticksInState` 未被重置 |
| 无 `HitEvent` | 在 `CollisionSystem` 之后插探针 drain 命中总线；拾取的那一 Tick 总线为空 |
| 不阻挡移动 | 无墙环境下，穿过拾取物所在坐标的位移与「没有拾取物」的对照组**逐位相同**（`toBe` 而非 `toBeCloseTo`，因为位移是同一个算式） |
| 不吸收投射物 | 朝拾取物发射一枚投射物；若干 Tick 后投射物**仍然存活**且沿直线继续前进，拾取物也仍然存活（阵营不同不构成命中，且拾取物根本不是目标） |

### 6.6 重开与确定性（AC-07 / AC-08）

| 断言 | 手法 |
|---|---|
| 重开清零 | 打完整局到 `RUN_WON`（§6.4），记下金币与词缀；`sim.restartRun()` 后：`sim.tick === 0`、`GameStatus.PLAYING`、新玩家的 `gold === 0` 且 `ModifierComponent` 为空、房间 `currentRoomIndex = 0` / `depth = 0` / `IN_PROGRESS` / `pendingRewards === null` |
| 不消费 PRNG | 掉落（`LootComponent` 是声明）与拾取（纯算术）都不调用 `world.rng`；同一局在「有掉落」与「无掉落」两种配置下，房间滚出的草稿相同 |
| 逐 Tick 全等 | 两台同种子模拟器跑同一输入脚本（含击杀、拾取、选奖励、清终房），逐 Tick `snapshot()` `toEqual` |

### 6.7 管道与零回归（AC-09 / AC-10）

`createDefaultSystems().map(s => s.name)` 必须逐字等于：

```
TransformSnapshotSystem, PlayerControllerSystem, FreezeSystem, AISystem,
HazardSystem, MovementSystem, DashSystem, StateSystem, CombatActionSystem,
CollisionSystem, StatusEffectSystem, ModifierSystem, DeathSystem,
EncounterSystem, RewardSystem, PickupSystem, LifespanSystem
```

（共 **17** 段；`LifespanSystem` 恒 `length - 1`；`MovementSystem → DashSystem → StateSystem` 相邻次序不变。）

---

## 7. 风险登记

| ID | 风险 | 缓解 | 残留 |
|---|---|---|---|
| **R1** | 拾取被判成一次命中，从而触发顿帧 / 硬直，毁掉手感。 | 结构性排除（§4.2 表）：拾取物没有 `HitboxComponent`，`CollisionSystem` 的生产者查询永远看不到它。AC-05 用「顿帧/状态/事件三重不变」逐条钉住。 | 低 |
| **R2** | 拾取物意外进入战斗查询集，变成「能被砍死的东西」或「挡住投射物的东西」。 | I1 的组件集是**恰好两个**；`tests/combat/economy_and_victory.test.ts` G0 用 `listComponents` 逐字钉住该集合（新增任何组件都会让这条断言变红）。 | 低 |
| **R3** | 单房间配置的既有调用点因为「终房获胜」而语义改变（M6 的肉鸽循环测试会失去落点）。 | 这是**预期且正确**的语义变更：一间房的一局，那一间就是终房。既有测试把装置改成多房间声明（`rooms`），机制本身逐位不变；`main.ts` 也改为两房间。 | 中（已在测试中显式记录） |
| **R4** | 掉落表在 `step()` 内部才暴露错误，炸掉一局。 | 装配期解析（`resolveLootDrops`）：到 `DeathSystem` 读它时全部数值已校验。 | 低 |
| **R5** | 胜利后世界仍在结算（房间继续刷波、金币继续进账），胜利界面变成一句谎言。 | `isRunOver` 作为唯一谓词，同时门控 `PlayerControllerSystem`（意图）/ `EncounterSystem`（调度）/ `PickupSystem`（收货），三者各有独立断言。 | 低 |
| **R6** | 新增第 17 段打断管道钉桩，被误当成回归而放宽断言。 | 8 份 `toEqual` 钉桩在同一提交里更新为 17 段并补上 `PickupSystem`，段数断言从 16 改为 17（**不放宽**为 `toBeGreaterThan`）。 | 低 |
| **R7** | 拾取物被保留成「尸体」，在一局里持续堆积。 | `LifespanSystem` 对已标记死亡的拾取物**就地销毁**；到期销毁走同一条路径。AC-02 的「Pickup 被清理」断言 `isAlive === false`。 | 低 |

---

## 8. 已知取舍

1. **掉落放在 `DeathSystem` 而不是新段 `LootSystem`。** 代价：`DeathSystem` 现在同时是「死亡转移」与「死亡后果」的所在地。收益：不为读一份手边数据而多付一个管道槽位，且掉落与死亡标签落在同一 Tick 的同一点上。若未来掉落需要独立的生命周期或独立的事件源，再按 spec 14 的「独立生命周期 ⇒ 新增段」规则拆出。

2. **`PickupSystem` 放在 `RewardSystem` 与 `LifespanSystem` 之间，而不是紧贴 `MovementSystem` 之后。** 需求是「在 `MovementSystem` 之后」（为了用本 Tick 的最终位置判定），本槽位满足它；同时它满足「在 `DeathSystem` 之后」（本 Tick 的掉落本 Tick 可拾）与「在 `LifespanSystem` 之前」（本 Tick 拾取的拾取物本 Tick 末尾被移除）。紧贴 `MovementSystem` 会把一段地面重叠判定塞进 M1 硬契约的 `Movement → Dash → State` 三连里，并且让掉落要等到下一 Tick 才能被拾取。代价：掉落与拾取在同一 Tick 完成，「击杀瞬间吃掉脚下的金币」是可能的——这是刻意的读法（与 `HazardSystem` 的「爆破当拍即测」同源）。

3. **`markDead` + `LifespanSystem` 销毁，而不是 `PickupSystem` 直接 `destroyEntity`。** 代价：拾取物的移除跨越两个系统。收益：`markDead` 是引擎唯一的「作废」语言，且让「谁负责销毁」保持唯一（`LifespanSystem`），因此拾取物与命中盒的寿命契约是同一条而不是两条。若未来有消费者需要「本 Tick 内观察到已拾取」，它已经就绪。

4. **单房间配置 = 终房。** 代价：M6 的循环测试装置必须声明多房间（R3）。收益：只有一条规则，没有「无限模式」开关；一间房的一局就是一间房的长度，清空它即获胜。

5. **金币目前只是分数。** 没有商店、没有消费入口。`addGold` 已经支持负数（钳在 `0`），所以接入商店时不需要新 API。代价：本里程碑的金币在玩法上暂时没有去向；收益：经济的**管道**（掉落 → 拾取 → 钱包 → HUD）先被完整地建立并测住。

6. **拾取半径取「拾取物半径 + 收集者 hurtbox 半径」。** 代价：拾取范围随身体大小变化（精英体型的收集者会吃得更容易）。收益：复用引擎已有的「这个实体的身体」定义，而不是发明一个只为拾取服务的第二半径常量。

7. **`GameRenderer` 新增 `pickup` 视图分支。** 表现层需求只点名了金币 HUD 与胜利界面，但看不见的金币会让演示不可玩。代价：`client/` 的改动面变大（由 `typecheck:client` + `vite build` 覆盖，无 node 单测）。收益：经济在画面上是可观察的。
