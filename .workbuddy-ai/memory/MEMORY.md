# my-hades · 长期约定（不变式）

> Headless 确定性动作肉鸽内核。Node≥22 · TS `strict`（`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`）· Vitest(node,`pool:'threads'`) · 零运行时依赖（`client/` 例外 pixi.js 8）。
> 本文件只留不变式与最易被违反的规则；逐里程碑全过程（含「为什么」与变异记录）见 `memory/YYYY-MM-DD.md`。

## 1 铁律
1. `src/` 禁 DOM/墙钟/随机；时间**只由 `step()` 推进**。
2. `fixedDeltaSeconds=1/fps`；`elapsedSeconds=totalTicks*fixedDeltaSeconds`（乘法禁累加）。禁硬编码 1/60。
3. 同输入⇒逐 Tick 同状态。遍历一律 `World.query`（id 升序）；字符串排序用 UTF-16 码元序，禁 `localeCompare`/`toLocale*`/`Intl`。
4. Snapshot=深拷贝+递归 freeze，与 world 零引用共享。
5. 组件=POD（禁方法）；操作用自由函数。
6. 系统=`{readonly name; update(world,ctx); reset?()}`；禁跨 Tick 隐藏状态；注册序==执行序。
7. 禁 `any`/`!`/`@ts-ignore`；类型导入用 `import type`。`export type {X} from './y'` 不带 X 进本地作用域。
8. 新文件必须在对应 `index.ts` barrel 导出。
9. 预制体 `spawn(world,options)=>EntityId`；装配集中 `spawn-helpers.ts::spawnCombatant`；`EnemySpawnOptions` 声明于此（防 components→prefabs 反向依赖）。
10. `PlayerInputComponent` 只挂玩家；`IntentComponent` 挂所有战斗单位。玩法只读意图；脉冲**先消费后门控**，拒绝也丢弃，绝不缓冲。
11. `ActionState` 通用动作机：新动作优先加枚举 + `StateSystem` 给退出条件。
12. `DASHING` 只能自 `IDLE`/`MOVING` 进入；门控在 `DashSystem`（排在 `StateSystem` 前）。

## 2 管道（硬契约 17 段，不得重排）
`TransformSnapshot→PlayerController→Freeze→AI→Hazard→Movement→Dash→State→CombatAction→Collision→StatusEffect→Modifier→Death→Encounter→Reward→Pickup→Lifespan`
`createDefaultSystems(hitEvents?,deathEvents?,dashEvents?)`。`TransformSnapshot` 恒 idx0；`Lifespan` 恒 LAST。
- `Freeze` 在逐实体推进前；`AI` 其后（读 post-decrement）。`StatusEffect` 在 `Collision` 后 `Modifier` 前；`Modifier` 在 `Collision` 后 `Death` 前；`Dash` 在 `Modifier` 前（`DashEvent` 同 Tick 送达）。`Death` 在所有伤害+`Modifier` 后；`Encounter` 其后；`Reward` 紧随；`Pickup` 再紧随（`Reward` 后、`Lifespan` 前）。
- ⚠️ 改管道打断 **9 处钉桩**（`grep -rl "'TransformSnapshotSystem'" tests/` 现场核对，勿凭记忆；`tests/render/interpolation.test.ts` 也命中但它是按名 `findIndex` 插探针，**不是**钉桩）：`tests/combat/{feedback,boons,status_effects,death_and_encounter,armor_and_dash,aoe_and_lifecycle,economy_and_victory}.test.ts` + `tests/ai/enemy_fsm.test.ts` + `tests/physics/walls_and_projectiles.test.ts`；其中 `aoe_and_lifecycle` 与 `walls_and_projectiles` 另带 `toHaveLength(N)` 段数钉桩（改段数时**绝不放宽**成 `toBeGreaterThan`）。
- 新事件配方：`events.ts` 加接口 → 新建 `EventQueue<T>` → 生产/消费方构造注入 → `createDefaultSystems` **尾部追加参数**。
- **同实体的位移/物理相位挂 `MovementSystem`(idx5) 尾部**（M7 落法）；**只有「独立生命周期+独立事件源」的机制才新增段**（M8 `HazardSystem`=idx4；M9 `PickupSystem`=idx15）。

## 3 测试
- 浮点位移容差 `1e-9`；禁严格相等。真实 `GameSimulator`+系统，不许 mock；`step(1)` 钉时序；`step(n)` 处理 tick `0..n-1`（时钟停在 n）。
- `ticksInState`：`StateSystem` **之后**写入的（`CollisionSystem` 的 `HITSTUN`）进入拍不计入⇒跨度+1；**之前**写入的（`DASHING`/`ATTACKING`）计入。补偿：`applyFreeze` 写 `hitstopTicks+1`；`CollisionSystem` 种 `ticksInState=1`；`MovementSystem` 撞墙刷新种 `0`。
- 实体可能命中同拍末被 `LifespanSystem` 销毁⇒要坐标就在上一拍快照。
- ⚠️ **恒真断言陷阱**：`字段===构造它的那个常量` 恒真⇒必须另配**字面量钉桩**或**行为断言**。
- **门控类改动必做变异测试**；`grep` vitest 摘要加 `NO_COLOR=1`。`client/UIManager.ts` 无 node 单测⇒靠 `typecheck:client`+`vite build`。
- ⚠️ **「不消费随机」这类否定断言**不能用「结果是 `null`」写（区分不了「没滚」与「滚了没人看」）⇒ 必须观察生成器下一个值（`noDraw === new Random(SEED).nextUint32()`）。

## 4 工程风险
- **ESLint AST 门**（仅 `src/**`）：禁 window/document、`Math.random`/`Date.now`、`new Date()`/`localeCompare`/`toLocale*`/`new Intl`、`pixi.js`、`**/client/**`。`client/` 允许 DOM/BOM。`no-unused-vars` 配 `argsIgnorePattern:'^_'`。
- ESLint 钉 9.x；`vite` 留 5.x（`vitest@2.1.8` peer）；vitest 必须 `pool:'threads'`。根 tsconfig 不 include `client/` ⇒ `tsconfig.client.json`+`typecheck:client`。
- npm 锁文件平台相关。远端 github.com/Jaxuu/my-hades（PUBLIC, `main`）——切勿提交密钥。

## 5 里程碑铁律（**只列绝对不变量 / 组件定义 / 门控规则；原理见 `specs/*`，历史与「为什么」见 `memory/YYYY-MM-DD.md`**）

**M3**：`EventQueue` 构造注入（不进 `SystemContext`、不挂 `World`）；`ModifierSystem` 每 Tick 全量 `drain()` ⇒ Tick 边界 `size===0`。防递归门 `sourceModifier!==null` 在持有者判定**之前**。注入判定圆 `activeTicks≥2`（`1`=静默 no-op）。反馈门控 = `hitstop>0||knockback>0`。词缀一律 `src/ecs/modifiers/*` 的 `IModifierHandler` → `ModifierRegistry`。DoT 只走 `applyDamage`（无判定圆/`HitEvent`/顿帧/硬直/击退/无敌帧），相位由管道位置定。状态按 id 升序唯一，多样性走 `stacks`。

**M4-T01 AI**：`AISystem` 零字段；AI 只输出 `IntentComponent`（不写 Transform/Velocity、不建实体、不调 `applyDamage`）。门控序 `isFrozen` → `HITSTUN` 不可交换。`spawn` 默认不挂 `AIControllerComponent`；`ai` ⟂ `hardwareInput`；`attackRadius>sightRadius` 抛错；`aimRadians===null` ⇒ 与 M1–M3 逐位等价。索敌升序 + 严格 `<` + 目标粘性。

**M4-T02 死亡/遭遇**：`DeadTagComponent` = 死亡唯一权威（零字段；只由 `DeathSystem` Tick 末挂载；`markDead` 幂等）；门控一律 `isDead`，**禁用 `hp<=0` 重推导**；`isDead` 对已销毁 id 返回 `false`。**死亡是状态不是删除**。门控序 死亡>冻结>硬直；`LifespanSystem` 不加死亡门。`CollisionSystem` 三道门 owner/target/同 Tick。`DeathSystem` 中和意图。死亡总线每拍 `clear()`。房间 = 挂 `EncounterStateComponent` 的全局单例；三态 `IN_PROGRESS/WAVE_CLEAR/ROOM_CLEARED`；`trackedEntityIds` 空 = 本波未生成；`isWaveCleared` 对空 `false`；`nextSpawnTick` 绝对 Tick（-1 = 未排期）。`EncounterFactory.spawn` 不生成第一波 ⇒ 调用方至少 `step()` 一次；Tick T 生成的成员首次行动 T+1。

**M5 渲染**：`client/` 唯一允许 DOM/BOM/PixiJS，只单向只读。`PX_PER_UNIT=10`；`rotation=facingRadians` 不翻符号。`GameLoop` 注入必须在 `step` 前；溢出清累加器。`GameRenderer.retired:Set` **不可删**（P0）；`fxLayer` 必须是 root 最后子节点；视图 `addChildAt(view, children.length-1)`；受击闪烁 `isFrozen||HITSTUN` ⇒ `tint 0xff0000`；跳字 `hp<lastHp` ⇒ 挂 `fxLayer`、1000ms 销毁。`syncWorld` alpha clamp `[0,1]`、默认 1；rotation 走 `shortestArcDelta`。⚠️ PixiJS v8 纯 Node：`new Text({text,style})` 可构造；**读 `.width/.height/bounds` 抛 `document is not defined`**。⚠️ 未修：`syncWorld(world,NaN)` 穿透 clamp（调用链不可达）。

**M6-T01 PRNG**：`Random`(Mulberry32) 挂 `World.rng`，seed 透传，默认 `0x12345678`；逻辑层只读永不重播种（ADR-004）；PRNG 状态不进 Snapshot。`nextFloat` `[0,1)` 右开；`nextInt` 双端闭；`sample` 无放回；`pick([])` 抛。掉落=`pendingRewards:string[]|null`；不变量 `pendingRewards!==null` ⟺ `ROOM_CLEARED`；读侧唯一入口 `findRewardDraft`。`depth` 独立于 `currentWaveIndex`；`buildWaveRoster` `depth=0` 逐字返回。选择意图走 `InputQueue`(`SelectRewardEvent`)；UI 只发 id；`RewardSystem` 用 `pending.includes` 重新校验。压制在 `PlayerControllerSystem.deriveIntent`（只压阶段 2，脉冲丢弃不缓冲，自 `T+1` 起）。`grantReward`：词缀=`addModifier`(幂等)；`hp_up`/`dash_up` 直写字段；未知 id/已销毁实体 `false`；**新增词缀奖励只需加 `REWARD_POOL` 条目**。`client/` 绝不含随机逻辑。

**M6-T02 霸体**：`applyDamageWithArmor` = 命中结算**唯一入口**；`absorbed=min(current,damage)`、`spill=damage-absorbed` 逐位守恒；`current` 只减不增，`0` 即永久破损（组件不删）。`armoredThrough` 用「**命中后** `current>0`」判定⇒破甲当击正常硬直+击退。霸体只豁免 `HITSTUN`+击退，**绝不豁免顿帧**。无护甲/已破甲⇒逐位等价 M6-T01。DoT 不走护甲。`DashEvent` 第三条总线：`DashSystem`(idx6) 发、`ModifierSystem`(idx11) 收⇒同 Tick 送达；**只在真进入 `DASHING` 时发**。`onDash?` 可选、`onHit` 必选。「单 Tick 生效判定圆」=`activeTicks=2`；`1`=静默 no-op。`armor` 是 opt-in，`0` 抛 `RangeError`；`spawnElite`=填默认后转调 `spawn`。

**M7-T01 空间**：`resolveCircleAABB` 纯函数（分离 `distSq>=r²`⇒`[0,0]`（贴边不算碰）→盒外沿最近点推 `r-dist`→盒内取**最近面**，平手 `-x,+x,-y,+y`）；**圆心也必须查有限性**（`NaN`⇒返回 `NaN` 毒值）。`WallComponent`(AABB，**不挂 Transform**)。`MovementSystem` 三相：`integrate` / `integrateKinematic`（`ProjectileComponent` 自驱 `+=directionVector*maxSpeed*dt`；**不加死亡/冻结门**）/ `resolveWalls`。解算目标集=`Transform`+`Velocity`+圆体半径（先 `Hurtbox` 后 `Hitbox`）；**不查冻结/硬直**；查 `isDead`；**逐墙顺序推出**（实体 id 升序×墙 id 升序）。**撞墙四条件**：`pushed` ∧ `HITSTUN` ∧ `Knockback` 非零 ∧ `dot(push,kb)<0`；三写：`applyDamageWithArmor(12)`+`ticksInState=0`+`kb.velocity=(0,0)`；**不顿帧**。投射物=`ProjectileComponent`（零字段）+`Transform`/`Velocity`/`Hitbox`，`spawnProjectile` 单一装配点；**自驱判据必须肯定式**；`hitstopTicks=0` 是**正确性**（否则冻住远处射手）；`destroyOnHit`⇒`CollisionSystem` 写完全部后 `destroyEntity`+`break`。新脉冲 `wantsToCast` 走既有配方；同拍 `wantsToAttack` 优先。

**M8-T01 延迟 AoE + 一局生命周期**：`HazardComponent` **只挂 `Transform`+自身**（不挂 `Hitbox`/`Hurtbox`/`Faction`/`Velocity`——四个都会把它拖进别的系统查询集；阵营存 `HazardComponent.faction`）。倒计时**先判后减**（`delayTicks=N` ⇒ N 拍预警 + 第 N+1 拍爆；`N=0` 同拍爆）。`HazardSystem` **两相位 A 播种→B 倒计时，不可交换**；**不读 `isFrozen`**（环境时钟≠动作时钟）。爆破圆 `activeTicks=1`（HazardSystem 在 CollisionSystem 之前⇒生成当拍即测）、`destroyOnHit=false`、`hitstop=0`+`knockback=10`；**爆破 `ownerEntityId` = Hazard 自身，不是施法者**（否则「埋雷后打死施法者」会让已埋的雷失效）。落点=施法者 AI 目标坐标（无则自身）。渲染分类顺序 **hazard→hitbox→faction**，否则预警被静默跳过。`wantsToHazard` 第四个单 Tick 脉冲；⚠️ **消费方查询必须全员**（`Intent`+`Transform`+`Faction`），只查埋雷者会让非埋雷者的脉冲**永久滞留**。`GameStateComponent` 全局单例 + **opt-in**（缺失即 `PLAYING`⇒M1–M7 逐位不变）；`GameStateFactory.spawn` 唯一装配点，**绝不惰性创建**（会多一个实体，打断 `entityCount` 断言）。玩家判据=`PlayerInputComponent`。`RUN_FAILED` **只加两道门**（`PlayerControllerSystem` 的 `suppressed` / `EncounterSystem` 首行 `return`），各需**独立**断言（① 靠「手工置 FAILED 但玩家存活」的对抗测试，② 靠活玩家对照组）；**不暂停 `step()`**。`restartRun(newSeed?)` 六步：`clearEntities→reseed→input.clear→scheduler.reset→clock.reset→runSetup`；**`clearEntities` 绝不重置 `nextId`（P0：`retired` 依赖 id 不复用，归零⇒新玩家永久隐身且逻辑层看不见）**；`System.reset?()` 只 `DeathSystem`/`ModifierSystem` 实现；`runSetup` 是**构造期选项**，首次装配走同一函数；`Random.reseed` 原地改写（`seed` 不再 `readonly`）。

**M9-T01 经济 + 多房间 + 胜利**：拾取物 = **恰好** `Transform`+`PickupComponent`（绝不挂 `Hitbox`/`Hurtbox`/`Faction`/`Velocity`/`Health`/`Intent`/`State`）⇒ 不触发顿帧/硬直/`HitEvent`、不阻挡移动、不吸收投射物、不被索敌**全部结构性成立**；用 `listComponents` 钉死。判定半径和 = `pickup.radius + collector.hurtbox.radius`，谓词严格 `<`（相切不拾取）。**消费 `markDead`（状态），移除交 `LifespanSystem`**：`agePickups` 分支序固定（`isDead`→销毁；否则自减、`<=0` 销毁），`lifespanTicks=N`⇒恰好 N 拍（同 `activeTicks`）。掉落表 = **实体 spec 的一部分**（`loot` opt-in，第五个），**装配期** `resolveLootDrops` 解析校验（**空表抛错**，省略字段=不掉），绝不在 `step()` 里抛；落在 `DeathSystem.dropLoot`，偏移 `LOOT_DROP_SPACING_UNITS×index`。钱包 `InventoryComponent` 挂 **`hardwareInput` 分支**（⇒ 不可能给 AI 挂上）；**装备不进钱包**（用 `ModifierComponent`）。`GameStatus` 加**兄弟态 `RUN_WON`**（非链条）；**`isRunOver=FAILED||WON` 是唯一「这局不再决策」谓词**，`PlayerController`/`Encounter`/`Pickup` 三处全改问它（必要性各异：意图压制只覆盖 WON，FAILED 已被「尸体不收东西」覆盖）。**终房判据唯一 `isFinalRoom`**：`EncounterSystem.advance` 先判终房再滚三选一 ⇒ **终房连一次 PRNG 抽签都不消费**（必须用「观察生成器下一个值」断言）；`RewardSystem` 有结算侧孪生守卫（出厂不可达，替代方案是越界房间号 ⇒ 必须留且必须有测试）。房间表 `roomWaves` 不可变、`waves` 恒为**当前房间**配置、推进=换引用；`rooms` 声明为「第 0 间之后」而非完整表（避免 `waves` 成副本）。⚠️ **单房间配置 = 终房 ⇒ 清空即胜**，打断 M6 循环测试落点 ⇒ 改装置（`rooms`）而非放宽断言。⚠️ `depth` 与房间推进同时发生 ⇒ 房间 k 波次 = `基础 + depth k 份复制`。`createView` 分类序 **pickup→hazard→hitbox→faction**；两个终局覆盖层**共用一条渲染路径两套皮肤**。

## 6 编排
先冻结、再评审、后修复。派单带 Task ID/角色/优先级/上下文/Deliverables/Output Path/Handoff。成员产出经主理人中转汇编。高影响动作（commit/发布/删除）须人工审批；默认不 commit。

## 7 进度
M0–M4 ✅209 · M5-T01 ✅212 · M5-T02 ✅234 · M6-T01 ✅264 · M6-T02 ✅285 · M7-T01 ✅336 · M8-T01 ✅359 · **M9-T01 ✅394**（管道 **17 段**，新增 `PickupSystem`，变异 **6/6** 捕获，test/lint/typecheck/typecheck:client/build 全绿；**未 commit**）。
权威规格 `specs/00`…`specs/15`。ADR-001(headless ECS) · ADR-002(渲染插值) · ADR-004(确定性 PRNG)。
