# my-hades · 长期约定（跨会话精华）

> Headless 确定性动作肉鸽内核（Hades-like），逻辑与渲染完全解耦。
> Node ≥ 22 · TS `strict`（含 `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes`）· Vitest（node，`pool:'threads'`）· 零运行时依赖（`client/` 例外，pixi.js 8.x）。
> **本文件只留不变式与已踩坑；逐里程碑全过程见 `.workbuddy-ai/memory/YYYY-MM-DD.md`。**

## 1. 铁律
1. `src/` 禁 DOM/墙钟/随机；时间**只由 `step()` 推进**。
2. `fixedDeltaSeconds=1/fps`；`elapsedSeconds=totalTicks*fixedDeltaSeconds`（乘法，禁累加）。禁硬编码 1/60 / 16.67。
3. 同输入 ⇒ 逐 Tick 同状态。遍历一律 `World.query`（id 升序）；字符串排序用 UTF-16 码元序，禁 `localeCompare`/`toLocale*`/`Intl`。
4. Snapshot = 深拷贝 + 递归 freeze，与 world 零引用共享。
5. 组件 = POD（纯数据、禁方法）；操作用自由函数。
6. 系统 = `{ readonly name; update(world, ctx) }`；禁跨 Tick 隐藏状态。注册顺序 == 执行顺序。
7. 禁 `any`/`!`/`@ts-ignore`；类型导入用 `import type`。`export type {X} from './y'` 不带 `X` 进本地作用域。
8. 新文件必须在对应 `index.ts` barrel 导出。
9. 预制体 `spawn(world, options) => EntityId`；装配集中在 `spawn-helpers.ts::spawnCombatant`；`EnemySpawnOptions` 声明在此（避免 components→prefabs 反向依赖）。
10. `PlayerInputComponent`（设备快照）只挂玩家；`IntentComponent`（`moveVector` 持久 + `wantsToDash`/`wantsToAttack` 单 Tick 脉冲 + `aimRadians`）挂所有战斗单位。玩法系统只读意图；脉冲**先消费后门控**，门控拒绝也丢弃，绝不缓冲。
11. `ActionState` 是通用动作状态机：新动作优先加枚举 + 在 `StateSystem` 给退出条件。
12. `DASHING` 只能自 `IDLE`/`MOVING` 进入；门控在 `DashSystem`（排在 `StateSystem` 之前）。

## 2. 管道（硬契约，15 段，不得重排）
`TransformSnapshot → PlayerController → Freeze → AI → Movement → Dash → State → CombatAction → Collision → StatusEffect → Modifier → Death → Encounter → Reward → Lifespan`
（`createDefaultSystems(hitEvents?, deathEvents?, dashEvents?)`）。`LifespanSystem` 恒 LAST；`TransformSnapshot` 恒 index 0。
- `Freeze` 在所有逐实体推进系统之前；`AI` 在其后（读 post-decrement 冻结判据）。`StatusEffect` 在 `Collision` 后、`Modifier` 前。`Modifier` 在 `Collision` 后、`Death` 前。`Dash` 在 `Modifier` 前（`DashEvent` 同 Tick 送达）。
- `Death` 在所有伤害来源 + `Modifier` 后（先播完 Tick 再清点死者）；`Encounter` 在其后；`Reward` 紧随。
- ⚠️ 改管道打断 **6 处钉桩**：`tests/combat/{feedback,boons,status_effects,death_and_encounter}.test.ts` + `tests/ai/enemy_fsm.test.ts`（5 处 `toEqual` 名数组 + 探针插入点）。探针一律按名 `findIndex`。
- 新增事件类型配方：`events.ts` 加接口 → 新建 `EventQueue<T>` → 生产/消费方构造注入 → `createDefaultSystems` **尾部追加参数**。

## 3. 测试
- 浮点位移断言容差 `1e-9`；禁严格相等。用真实 `GameSimulator` + 系统，不许 mock；`step(1)` 逐 Tick 钉时序。
- `step(n)` 处理 tick `0..n-1`（时钟停在 `n`）。先算相位再断言。
- `ticksInState` 相位：`StateSystem` 之后写入的状态（`CollisionSystem` 的 `HITSTUN`）进入拍不计入 ⇒ 可观测跨度比常量多 1 拍；之前写入的（`DASHING`/`ATTACKING`）会计入。补偿：`applyFreeze` 写 `hitstopTicks+1`；`CollisionSystem` 进 `HITSTUN` 时种 `ticksInState=1`。改前先看 spec 04 §6。
- 实体可能在命中同拍末被 `LifespanSystem` 销毁 ⇒ 要坐标就在上一拍快照。
- **变异测试是门控类改动的必做步骤**；冗余门会掩盖测试空洞。
- `grep` vitest 摘要行须加 `NO_COLOR=1`。
- `client/UIManager.ts` 无 node 单测（根 tsconfig 刻意 exclude `client/`）⇒ 验证靠 `typecheck:client` + `vite build`。

## 4. 工程风险
- **ESLint AST 门**（`eslint.config.mjs`，仅 `src/**`）：禁 window/document、`Math.random`/`Date.now`、`new Date()`/`localeCompare`/`/^toLocale/`/`new Intl`、`pixi.js`、`**/client/**`。对注释零误报。`client/` 允许 DOM/BOM。
- `no-unused-vars` 须配 `argsIgnorePattern:'^_'`；TS `noUnusedParameters` 天然忽略 `_` 前缀。
- ESLint 钉 9.x；`vite` 留 5.x（`vitest@2.1.8` peer）；vitest 必须 `pool:'threads'`。
- 根 tsconfig 不得 include `client/` ⇒ 独立 `tsconfig.client.json` + `typecheck:client`。
- npm 锁文件平台相关（需在无 `node_modules` 的隔离目录生成）。
- 远端 https://github.com/Jaxuu/my-hades（PUBLIC，`main`）——切勿提交密钥。

## 5. 里程碑铁律

**M3 变异引擎**：`EventQueue` 构造注入（不进 `SystemContext`/不挂 `World`）；`ModifierSystem` 每 Tick 全量 `drain()` ⇒ Tick 边界 `size===0`。防递归门 `sourceModifier !== null` **必须在持有者判定之前**。`ModifierSystem` 不跳过冻结实体。其后注入的判定圆 `activeTicks ≥ 2`。反馈按需门控（`hitstopTicks>0 || knockbackForce>0`）。
- 修饰器效果一律放 `src/ecs/modifiers/*` 的 `IModifierHandler` 并注册进 `ModifierRegistry`；`ModifierSystem` 不含祝福逻辑。`ModifierContext extends SystemContext`。handler 除 `id` 外零字段。
- **DoT 相位靠管道位置不靠 `+1`**：第 k 次结算 = `T + k×intervalTicks`，摘除 = `T + durationTicks`。DoT = 真实伤害（只 `applyDamage`，不生成判定圆/不抛 `HitEvent`/不顿帧/不硬直/不击退/不查无敌帧）。状态结算先于到期判定；状态按 id 升序唯一（多样性走 `stacks`）。

**M4-T01 敌方 AI**：`AISystem` 零字段，状态全在 `AIControllerComponent`。AI 输出只有 `IntentComponent`（不写 Transform/Velocity、不建实体、不调 `applyDamage`/`applyFreeze`、不写 `wantsToDash`）。前摇锁朝向经 `aimRadians` 由 `MovementSystem` 静止分支落地；`aimRadians === null` ⇒ 与 M1–M3 逐位等价。
- 门控顺序不可交换：先 `isFrozen`（顿帧=暂停，不吞帧），后 `HITSTUN`（硬直=打断，重置 `IDLE`，作废前摇不补触发）。
- 进入前摇拍不递减 `ticksRemaining` ⇒ 出手 = 进入拍 + `windupTicks`；冷却结束只回 `CHASING`/`IDLE` ⇒ 周期 = `windupTicks + cooldownTicks + 1`。`IDLE→CHASING`「发现」拍不移动；`IDLE` 的 `dist ≤ attackRadius` 分支无延迟。
- `EnemyFactory.spawn` 默认不挂 `AIControllerComponent`；`ai` 与 `hardwareInput` 互斥、`attackRadius > sightRadius` —— 均抛 `RangeError`。
- 断言 `wantsToAttack` 必须把探针插在 `AISystem` 正后方（按名 findIndex）。判定圆在出手同拍生成。自动索敌：升序 + 严格 `<` ⇒ 等距取小 id；目标粘性。

**M4-T02 死亡与遭遇**：`DeadTagComponent` 是死亡唯一权威（零字段，只由 `DeathSystem` Tick 末尾挂载，`markDead` 幂等）。门控一律 `isDead`，不得用 `hp<=0` 重推导。`isDead` 对已销毁 id 返回 `false` ⇒「已销毁」是独立跳过理由。死亡是状态不是删除（永不销毁战斗单位）。门控顺序：死亡 > 冻结 > 硬直；`LifespanSystem` 故意不加死亡门。
- `CollisionSystem` 三道门：(a) owner 门（目标循环前）、(b) target 门、(c) 同 Tick 门（`hp<=0`）。一实体一 Tick 只结算一次；同归于尽刻意允许。
- `DeathSystem` 中和意图（否则死时值永久冻结在快照里）。死亡总线独立 `EventQueue<EntityDeathEvent>`（`{tick, entityId}`），无强制消费者 ⇒ 每拍 `clear()`。
- 房间 = 挂 `EncounterStateComponent` 的全局单例实体（无 Transform/受击盒/寿命）。三态 `IN_PROGRESS/WAVE_CLEAR/ROOM_CLEARED`；`EncounterSystem` 零字段。
- `trackedEntityIds` 空 =「本波未生成」；`isWaveCleared` 对空返回 `false`。提升下一波清空名单；`ROOM_CLEARED` 保留末波名单。
- `nextSpawnTick` 存绝对 Tick（`-1`=未排期）：第 0 波惰性排期于 `p₀+delayTicks`，第 `k>0` 波于 `q+delayTicks`。`delayTicks=0` 不对称（第 0 波同拍、后续波下一拍）。
- `EncounterFactory.spawn` 不生成第一波 ⇒ 调用方至少 `step()` 一次；校验在加载期 dry-run 装配。Tick `T` 生成的波次成员首次行动在 `T+1`。

**M5 渲染层**：`client/` 是唯一允许 DOM/BOM 与 PixiJS 的目录；只单向只读逻辑层（禁 `addComponent`/`destroyEntity`/`applyDamage`）。`PX_PER_UNIT = 10`；`container.rotation = facingRadians` 不翻转符号。
- `GameLoop`：累加真实 `deltaMS`，`while (acc >= sim.tickDurationMs && steps < 5) { input.flush(sim); sim.step(1); acc -= sim.tickDurationMs; }`。注入必须在 `step` 之前；必须用 `sim.tickDurationMs`；溢出清累加器。
- `GameRenderer.retired: Set<EntityId>` 不可删（尸体永不销毁 ⇒ 否则死亡 FX 无限重播，P0）；只在「FX 播完」路径退役。依赖 `World.nextId` 单调、id 永不复用。
- `fxLayer` 必须是 root 最后一个子节点；实体视图 `addChildAt(view, children.length - 1)` 插到其下（不要改 `addChild`）。受击闪烁用 `tint`（`isFrozen || HITSTUN` ⇒ `0xff0000`）。伤害跳字：`hp < lastHp` ⇒ 挂 `fxLayer`，1000ms 销毁；HP 上升不触发。
- `PreviousTransformComponent` 是渲染支撑组件（只由 `TransformSnapshotSystem` 写、只由渲染层读，惰性挂载）。插值 `syncWorld(world, alpha)`：alpha clamp `[0,1]`；rotation 走 `shortestArcDelta`（`[-π,π]` 两端闭）；alpha 默认 `1`。GameLoop alpha 在追帧 `while` 之后算 ⇒ 恒定 +1 Tick 视觉延迟（ADR-002）。
- ⚠️ PixiJS v8 在纯 Node：`new Text({text,style})` 可构造、`.text/.x/.y/.alpha` 可读；读 `.width`/`.height`/bounds 抛 `document is not defined`。假 `Application`（`{stage, ticker:{deltaMS,add,remove}}`）可做逐帧回归测试。
- ⚠️ 已知未修：`syncWorld(world, NaN)` 穿透 clamp ⇒ 实体静默消失（调用链不可达，spec 10 §10）。

**M6-T01 确定性随机 + 肉鸽循环**：`Random`（Mulberry32）挂 `World.rng`，`WorldOptions.seed`/`GameSimulatorOptions.seed` 透传，默认 `0x12345678`。逻辑层只读、永不重播种（ADR-004）。PRNG 状态不进 Snapshot。`nextFloat()` `[0,1)` 右开；`nextInt` 双端闭；`sample` 无放回（`count > len` 抛）；`pick([])` 抛。
- 掉落 = `EncounterStateComponent.pendingRewards: string[]|null`；不变量 `pendingRewards !== null` ⟺ `state === ROOM_CLEARED` ⇒ 不加冗余第二道门。读侧唯一入口 `findRewardDraft(world)`。
- `depth` 独立于 `currentWaveIndex`；`buildWaveRoster(enemies, depth)` 纯函数追加副本（+x 偏移 1.5），`depth=0` 逐字返回 ⇒ M4 行为逐位不变。
- 选择意图走既有 `InputQueue`（`SelectRewardEvent{kind:'selectReward',tick,rewardId}`）；UI 只发 id；`RewardSystem` 用 `pending.includes(selection)` 重新校验，伪造/陈旧/未在选项中的 id 静默忽略。
- 压制：抽奖期 `PlayerControllerSystem.deriveIntent` 把玩家意图置零（时间照走、调度器惰性）；只压制阶段 2，脉冲丢弃不缓冲；压制自 `T+1` 起。结算在 Tick 末尾 ⇒ 下一波在「选择拍 + 1」生成。
- `grantReward`：词缀类 = `addModifier`（幂等不叠加）；`hp_up`/`dash_up` 直接写字段（可叠加，`dash_up` 下限 10）；未知 id/已销毁实体返回 `false`。**新增词缀奖励只需加 `REWARD_POOL` 条目**。
- `client/` 绝不含随机逻辑；UI 渲染 `pendingRewards` id 列表（label 单向读 `REWARD_POOL`），点击走回调注入。

**M6-T02 精英霸体 + 冲刺词缀**：`ArmorComponent`（`current`/`max`）+ 自由函数 `applyDamageWithArmor` = 命中结算唯一入口（`CollisionSystem` 不再直接调 `applyDamage`）。`absorbed = min(current, damage)`、`spill = damage - absorbed`，`absorbed + spill === damage` 逐位守恒（不得吞伤害）。`current` 只减不增，`0` 即永久破损（组件不删）。
- `armoredThrough` 用「命中后 `current > 0`」判定（不是命中前）⇒ 破甲当击正常触发硬直 + 击退。霸体只豁免 `HITSTUN` + 击退，绝不豁免顿帧（`applyFreeze` 留在门之外）。无护甲/已破甲 ⇒ 逐位等价 M6-T01。DoT 不走护甲。
- `DashEvent{tick,entityId,position,direction}` = 第三条独立总线：`DashSystem`(idx 5) 发、`ModifierSystem`(idx 10) 收 ⇒ 同 Tick 送达；Tick 边界为空。只在真的进入 `DASHING` 时发（被门控拒绝的脉冲不发）。
- `onDash?` 可选、`onHit` 仍必选；`onDash` 无防递归门且不需要（修饰器只注入判定圆，判定圆无 `IntentComponent`）。
- 「单 Tick 生效判定圆」= `activeTicks = 2`（注入当拍不可能被测试 + `LifespanSystem` 当拍末减 1 ⇒ 恰好一次测试）；`1` = 静默 no-op。与 Zeus 落雷同构。
- 冲刺词缀 `hitstopTicks = 0` + `knockbackForce > 0`：不冻冲刺者自己，但反馈门开 ⇒ 受击者进 `HITSTUN` 并被真正推开。
- `armor` 是 `CombatantSpawnOptions` 的 opt-in 开关（同 `ai`），`0` 抛 `RangeError`；`EnemyFactory.spawnElite` = 填默认后转调 `spawn`（不重列组件）。本里程碑零管道改动；但 `status_effects.test.ts` G6 的 registry 钉桩（size 2→3）需同步。

## 6. 编排约定
- 先冻结、再评审、后修复（禁止在 QA 评审窗口内并发改写受审产物）。
- 派单须带 Task ID / 角色 / 优先级 / 上下文 / Deliverables / Output Path / Handoff。
- 成员产出经主理人中转汇编；高影响动作（commit/发布/删除）须人工审批。默认不 commit。

## 7. 进度
| 里程碑 | 状态 |
|---|---|
| M0–M4 | ✅ 209 用例 |
| M5-T01 渲染基建 + PixiJS 桥接 | ✅ 212 · `d9aef43` |
| M5-T02 渲染插值 + 打击感 | ✅ 234（17 文件）· `bc91777`+`dcd9b25` |
| M6-T01 PRNG + 词缀三选一 | ✅ 264（18 文件） |
| M6-T02 精英霸体 + 冲刺词缀 | ✅ **285**（19 文件）· `efaca99` · test/lint/typecheck/build 全绿 |

- 权威规格：`specs/00`…`specs/12`。ADR：`ADR-001`（headless ECS）·`ADR-002`（渲染插值）·`ADR-004`（确定性 PRNG）。
