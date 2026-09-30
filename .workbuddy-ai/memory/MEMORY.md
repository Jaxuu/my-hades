# my-hades · 长期约定（不变式）

> Headless 确定性动作肉鸽内核。Node≥22 · TS `strict`（`noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`）· Vitest(node,`pool:'threads'`) · 零运行时依赖（`client/` 例外 pixi.js 8）。
> 只留不变式与最易被违反的规则；原理见 `specs/*`，历史见 `memory/YYYY-MM-DD.md`。

## 1 铁律
1. `src/` 禁 DOM/墙钟/随机；时间只由 `step()` 推进。`fixedDeltaSeconds=1/fps`；`elapsedSeconds=totalTicks*fixedDeltaSeconds`（乘法禁累加），禁硬编码 1/60。
2. 同输入⇒逐 Tick 同状态。遍历一律 `World.query`（id 升序）；字符串排序用 UTF-16 码元序，禁 `localeCompare`/`toLocale*`/`Intl`。
3. Snapshot=深拷贝+递归 freeze，零引用共享。组件=POD（禁方法），操作用自由函数。系统=`{readonly name; update(world,ctx); reset?()}`，禁跨 Tick 隐藏状态，注册序==执行序。
4. 禁 `any`/`!`/`@ts-ignore`；类型导入用 `import type`；新文件必须在对应 `index.ts` barrel 导出。
5. 预制体 `spawn(world,…)=>EntityId`；装配集中 `spawn-helpers.ts::spawnCombatant`。
6. `PlayerInputComponent` 只挂玩家；`IntentComponent` 挂所有战斗单位。玩法只读意图；脉冲**先消费后门控**，拒绝也丢弃，绝不缓冲。
7. `ActionState` 通用动作机：新动作优先加枚举 + `StateSystem` 给退出条件。`DASHING` 只能自 `IDLE`/`MOVING` 进入，门控在 `DashSystem`（排在 `StateSystem` 前）。
8. 数据驱动：业务数值一律来自 `assets/data/*.json`；工厂/词缀只装配与查表。加载在 Bootstrap **异步**完成，`step()` 内零 IO、零校验抛错（加载期大声抛 `SchemaError`）。

## 2 管道（硬契约 17 段，不得重排）
`TransformSnapshot→PlayerController→Freeze→AI→Hazard→Movement→Dash→State→CombatAction→Collision→StatusEffect→Modifier→Death→Encounter→Reward→Pickup→Lifespan`
`createDefaultSystems(hitEvents?,deathEvents?,dashEvents?)`。`TransformSnapshot` 恒 idx0；`Lifespan` 恒 LAST。Freeze 在逐实体推进前，AI 其后（读 post-decrement）；StatusEffect 在 Collision 后 Modifier 前；Modifier 在 Collision 后 Death 前；Dash 在 Modifier 前（`DashEvent` 同 Tick 送达）；Death 在所有伤害+Modifier 后，Encounter→Reward→Pickup 依次紧随。
新事件配方：`events.ts` 加接口 → 新建 `EventQueue<T>`（构造注入，不进 `SystemContext`/不挂 `World`）→ 生产/消费方注入 → `createDefaultSystems` **尾部追加参数**。
同实体的位移/物理相位挂 `MovementSystem`(idx5) 尾部；只有「独立生命周期+独立事件源」才新增段。

**钉桩 9 处**（改管道必同步；`grep -rl "'TransformSnapshotSystem'" tests/` 现场核对）：`tests/combat/{feedback,boons,status_effects,death_and_encounter,armor_and_dash,aoe_and_lifecycle,economy_and_victory}.test.ts` + `tests/ai/enemy_fsm.test.ts` + `tests/physics/walls_and_projectiles.test.ts`。`tests/render/interpolation.test.ts` 是按名 `findIndex` 插探针，**不是**钉桩。段数钉桩 `toHaveLength(N)`（**绝不**放宽成 `toBeGreaterThan`）：`aoe_and_lifecycle`、`walls_and_projectiles`。

## 3 测试
- 浮点位移容差 `1e-9`，禁严格相等。真实 `GameSimulator`+系统，不许 mock；`step(1)` 钉时序；`step(n)` 处理 tick `0..n-1`（时钟停在 n）。
- `ticksInState`：`StateSystem` 之后写入的（Collision 的 `HITSTUN`）进入拍不计入⇒跨度+1；之前写入的（`DASHING`/`ATTACKING`）计入。补偿：`applyFreeze` 写 `hitstopTicks+1`；`CollisionSystem` 种 `ticksInState=1`；`MovementSystem` 撞墙刷新种 `0`。
- 实体可能命中同拍末被 `LifespanSystem` 销毁⇒要坐标就在上一拍快照。
- ⚠️ 恒真断言陷阱：`字段===构造它的那个常量` 恒真⇒必须另配**字面量钉桩**或**行为断言**。
- ⚠️「不消费随机」不能用「结果是 `null`」写⇒必须观察生成器下一个值（`noDraw === new Random(SEED).nextUint32()`）。
- 门控类改动必做变异测试；`grep` vitest 摘要加 `NO_COLOR=1`。`client/UIManager.ts` 无 node 单测⇒靠 `typecheck:client`+`vite build`。

## 4 工程风险
- ESLint AST 门（仅 `src/**`）：禁 window/document、`Math.random`/`Date.now`、`new Date()`/`localeCompare`/`toLocale*`/`new Intl`、`pixi.js`、`**/client/**`。`no-unused-vars` 三个 ignore 均 `^_`；`no-explicit-any` 全仓生效。
- ESLint 钉 9.x；`vite` 留 5.x（`vitest@2.1.8` peer）；vitest 必须 `pool:'threads'`。根 tsconfig 不 include `client/` ⇒ `tsconfig.client.json`（`types:["node","vite/client"]`，`import.meta.hot` 需要）+`typecheck:client`。
- 测试夹具陷阱：`createDefaultSystems()` **构造期**读 `zeus_strike`/`poseidon_dash` ⇒ mock bundle **不得清空词缀表**（否则流水线构造不出来）。尸体永不销毁 ⇒ 断言存活数必须过滤 `isDead`。
- npm 锁文件平台相关。远端 github.com/Jaxuu/my-hades（PUBLIC, `main`）——切勿提交密钥。

## 5 里程碑铁律

**M3–M5 核心不变量**（M3 词缀 / M4 AI·死亡·遭遇 / M5 渲染）
- 每 Tick 全量 `drain()`（Tick 边界 `size===0`）；防递归门 `sourceModifier!==null` **先于**持有者判定；注入圆 `activeTicks≥2`（`1`=no-op）；反馈门控 `hitstop>0||knockback>0`；词缀=`IModifierHandler`→`ModifierRegistry`；DoT 只走 `applyDamage`（无圆/`HitEvent`/顿帧/硬直/击退/无敌帧）；状态按 id 升序唯一，多样性走 `stacks`。
- `AISystem` 零字段，只写 `IntentComponent`；门控序 `isFrozen`→`HITSTUN` 不可交换；默认不挂 `AIControllerComponent`；`ai` ⟂ `hardwareInput`；`attackRadius>sightRadius` 抛错；索敌升序+严格 `<`+目标粘性。
- `DeadTagComponent`=死亡唯一权威（零字段，只由 `DeathSystem` Tick 末挂载，`markDead` 幂等）；门控一律 `isDead`，**禁** `hp<=0` 重推导；`isDead` 对已销毁 id 为 `false`；**死亡是状态不是删除**；门控序 死亡>冻结>硬直；`LifespanSystem` 不加死亡门；`CollisionSystem` 三道门 owner/target/同 Tick；死亡总线每拍 `clear()`。
- 房间=挂 `EncounterStateComponent` 的全局单例；三态 `IN_PROGRESS/WAVE_CLEAR/ROOM_CLEARED`；`trackedEntityIds` 空=本波未生成；`isWaveCleared` 对空 `false`；`nextSpawnTick` 绝对 Tick（-1=未排期）；`EncounterFactory.spawn` 不生成第一波⇒调用方至少 `step()`；Tick T 生成者首次行动 T+1。
- `client/` 唯一允许 DOM/BOM/PixiJS，单向只读；`PX_PER_UNIT=10`；`rotation=facingRadians` 不翻符号；`GameLoop` 注入须在 `step` 前，溢出清累加器；`retired:Set` **不可删**（P0）；`fxLayer` 必须是 root 最后子节点；`addChildAt(view, len-1)`；受击闪烁 `isFrozen||HITSTUN`⇒`tint 0xff0000`；跳字 `hp<lastHp`⇒挂 `fxLayer`、1000ms 销毁；`syncWorld` alpha clamp `[0,1]` 默认 1，rotation 走 `shortestArcDelta`。⚠️ PixiJS v8 纯 Node 读 `.width/.height/.bounds` 抛 `document is not defined`。

**M6 PRNG/霸体**：`Random`(Mulberry32) 挂 `World.rng`，seed 透传（默认 `0x12345678`），只读不重播种（ADR-004），不进 Snapshot；`nextFloat` 右开 / `nextInt` 双端闭 / `sample` 无放回 / `pick([])` 抛。`pendingRewards:string[]|null` ⟺ `ROOM_CLEARED`，读侧唯一入口 `findRewardDraft`；`depth` ⟂ `currentWaveIndex`，`buildWaveRoster` `depth=0` 逐字返回；选择走 `InputQueue(SelectRewardEvent)`，UI 只发 id，`RewardSystem` 用 `pending.includes` 复校验；压制在 `PlayerControllerSystem.deriveIntent`（只压阶段 2，脉冲丢弃不缓冲，自 `T+1`）；`grantReward` 词缀=`addModifier`(幂等)、`hp_up`/`dash_up` 直写、未知/已销毁⇒`false`；`client/` 绝不含随机。`applyDamageWithArmor`=命中结算唯一入口；`absorbed=min(current,damage)`、`spill=damage-absorbed` 守恒；`current` 只减不增，`0` 永久破损（组件不删）；`armoredThrough`=「命中后 `current>0`」；霸体只豁免 `HITSTUN`+击退，**绝不豁免顿帧**；无护甲/已破甲⇒逐位等价；DoT 不走护甲。`DashEvent` 第三总线 `DashSystem`(idx6)→`ModifierSystem`(idx11) 同 Tick，**只在真进入 `DASHING` 时发**；`onDash?` 可选、`onHit` 必选。

**M7 空间**：`resolveCircleAABB` 纯函数（贴边不算碰；盒内取最近面，平手 `-x,+x,-y,+y`；**圆心也查有限性**）。`WallComponent`(AABB，**不挂 Transform**)。`MovementSystem` 三相 `integrate`/`integrateKinematic`（`ProjectileComponent` 自驱，**不加死亡/冻结门**）/`resolveWalls`；解算集=`Transform`+`Velocity`+圆半径（先 `Hurtbox` 后 `Hitbox`），不查冻结/硬直，查 `isDead`，逐墙顺序推出（实体 id×墙 id 升序）。**撞墙四条件** `pushed`∧`HITSTUN`∧`Knockback`≠0∧`dot(push,kb)<0`；三写 `applyDamageWithArmor(12)`+`ticksInState=0`+`kb.velocity=(0,0)`；**不顿帧**。投射物=`ProjectileComponent`(零字段)+`Transform`/`Velocity`/`Hitbox`，`spawnProjectile` 唯一装配点；自驱判据必须肯定式；`hitstopTicks=0` 是**正确性**；`destroyOnHit`⇒写完后 `destroyEntity`+`break`；同拍 `wantsToAttack` 优先于 `wantsToCast`。

**M8 AoE/一局**：`HazardComponent` 只挂 `Transform`+自身（阵营存 `faction`）；倒计时**先判后减**（`delayTicks=N`⇒N 拍预警+第 N+1 拍爆；`N=0` 同拍爆）；`HazardSystem` 两相位 A 播种→B 倒计时**不可交换**，**不读 `isFrozen`**；爆破圆 `activeTicks=1`、`destroyOnHit=false`、`hitstop=0`+`knockback=10`，`ownerEntityId`=Hazard 自身（**非**施法者）；落点=施法者 AI 目标坐标（无则自身）；渲染分类序 hazard→hitbox→faction；`wantsToHazard` 第四个单 Tick 脉冲，**消费方查询必须全员**（`Intent`+`Transform`+`Faction`）。`GameStateComponent` 全局单例+**opt-in**（缺失即 `PLAYING`），`GameStateFactory.spawn` 唯一装配点，**绝不惰性创建**；玩家判据=`PlayerInputComponent`；`RUN_FAILED` **只加两道门**（`PlayerControllerSystem.suppressed`／`EncounterSystem` 首行 `return`），各需**独立**断言，**不暂停 `step()`**。`restartRun(newSeed?)` 六步 `clearEntities→reseed→input.clear→scheduler.reset→clock.reset→runSetup`；**`clearEntities` 绝不重置 `nextId`（P0）**；`System.reset?()` 只 `DeathSystem`/`ModifierSystem` 实现；`runSetup` 是**构造期选项**。

**M9 经济/多房间/胜利**：拾取物=**恰好** `Transform`+`PickupComponent`（不挂 `Hitbox`/`Hurtbox`/`Faction`/`Velocity`/`Health`/`Intent`/`State`）；判定半径和=`pickup.radius+collector.hurtbox.radius`，严格 `<`（相切不拾取）；**消费 `markDead`（状态），移除交 `LifespanSystem`**，`agePickups` 分支序固定（`isDead`→销毁；否则自减、`<=0` 销毁），`lifespanTicks=N`⇒恰好 N 拍。掉落表=**实体 spec 的一部分**（`loot` opt-in），**装配期** `resolveLootDrops` 校验（**空表抛错**），绝不在 `step()` 抛；落 `DeathSystem.dropLoot`，偏移 `LOOT_DROP_SPACING_UNITS×index`。钱包 `InventoryComponent` 挂 **`hardwareInput` 分支**；**装备不进钱包**。`GameStatus` 加**兄弟态 `RUN_WON`**；**`isRunOver=FAILED||WON` 是唯一「不再决策」谓词**；**终房判据唯一 `isFinalRoom`**：`advance` 先判终房再滚三选一⇒**终房一次 PRNG 抽签都不消费**；`RewardSystem` 有结算侧孪生守卫；`roomWaves` 不可变、`waves` 恒为**当前房间**配置、推进=换引用，`rooms` 声明为「第 0 间之后」。⚠️ **单房间配置=终房⇒清空即胜**；⚠️ `depth` 与房间推进同时发生⇒房间 k 波次=`基础+depth k 份复制`；`createView` 分类序 **pickup→hazard→hitbox→faction**。

**M10 数据驱动**：`assets/data/{enemies,modifiers}.json` 是唯一数值来源；`src/data/` 三层 `schemas.ts`（类型+`SchemaError`+运行时校验）／`DataManager`（静态注册表 `loadAll`/`getEnemyConfig`/`getModifierConfig`）／`bundled.ts`（异步 Bootstrap，早于 `GameSimulator` 构造）；`EnemyFactory.spawn(world, enemyId, placement?)` 只收 **id+位姿/目标**，`spawnElite` 走配置的 `elite` 变体；词缀 handler 构造期读配置。**加载期大声抛，运行时零校验**。

**M10-T02 遭遇/HMR**：`assets/data/encounters.json` = **有序数组**，条目 `k` 必须 `depth===k`；波次只写敌人**类型 id 字符串**，站位由 `formWaveRoster` 确定性推导（水平等距线居中，间距 2）。`RawConfigTables.encounters` **可选且「缺席 ≠ 空数组」**（缺席=不提供房间；`[]`=非法）。**跨表校验只能在 `loadAll`**（需两张表）。`DataManager.getEncounterWaves(depth)` **超界循环 `depth%n`（非钳制）**，非整数/负数抛。`EncounterFactory.spawnFromData` 按 `encounterDepths` 装配整局；`spawn(world,config)` 手写路径签名不变；下降收敛到 `descendEncounterRoom`（`roomWaves[index] ?? resolveEncounterWaves(room.depth)`）——`RewardSystem` 每拍循环仍零配置读取。**`buildWaveRoster` 深度盘保留**（与按深度选房间正交叠加 ⇒ 数量=表内+depth）。**`src/` 零 `import.meta`**；HMR 只在 `client/bundled.ts`（Vite 入口必须**自己** import JSON 并 accept，否则传播到 `client/main.ts` ⇒ 整页刷新；故 main 不再 import `src/data/index`）。重载=`DataManager.loadAll` + `restartRun(sim.currentSeed)`（**同种子**，非重掷）+ `GameRenderer.reset()`（清 views/`floatingTexts`/`fxLayer`/`retired`；**≠ `destroy()`**，是运行边界操作）。失败**软着陆**（try/catch + 原子性保旧表）。

## 6 编排
先冻结、再评审、后修复。派单带 Task ID/角色/优先级/上下文/Deliverables/Output Path/Handoff。高影响动作（commit/发布/删除）须人工审批；默认不 commit。

## 7 进度
M0–M4 ✅209 · M5-T01 ✅212 · M5-T02 ✅234 · M6-T01 ✅264 · M6-T02 ✅285 · M7-T01 ✅336 · M8-T01 ✅359 · M9-T01 ✅394 · M10-T01 ✅414 · **M10-T02 ✅436**（遭遇序列数据化 + JSON HMR；管道仍 **17 段**；`test`/`lint`/`typecheck`/`typecheck:client`/`build` 全绿；**未 commit**）。
权威规格 `specs/00`…`specs/16`。ADR-001(headless ECS) · ADR-002(渲染插值) · ADR-004(确定性 PRNG)。
