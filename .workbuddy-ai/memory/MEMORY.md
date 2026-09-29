# my-hades · 长期约定（跨会话精华版）

> Headless 确定性动作肉鸽内核（《Hades》核心玩法复刻），**逻辑与渲染完全解耦**。
> Node ≥ 22 · TS `strict` · Vitest（node 环境，`pool: 'threads'`）· **零运行时依赖**（M5 起 `client/` 例外）。
> 逐里程碑历史见 `.workbuddy-ai/memory/YYYY-MM-DD.md`；本文件只留**不变式与已踩坑**。

## 1. 架构铁律
1. **纯逻辑**：`src/` 禁 DOM / 墙钟 / 随机。时间**只由 `step()` 推进**。
2. **固定步长**：`fixedDeltaSeconds = 1/fps`（默认 1/60），`tickDurationMs = 1000/fps`（**不截断**）；`elapsedSeconds = totalTicks * fixedDeltaSeconds`（乘法，**禁浮点累加**）。**禁硬编码 1/60 或 16.67**。
3. **确定性**：同输入序列 ⇒ 逐 Tick 同状态。遍历一律 `World.query`（id 升序）；排序一律 UTF-16 码元序，**禁 `localeCompare`/`toLocale*`/`Intl`**。
4. **Snapshot 不可变**：深拷贝 + 递归 `Object.freeze`，与实时 world 零引用共享。

## 2. 代码约定
- **组件 = POD**：`ComponentBase` 子类**纯数据**，**禁**任何方法；操作用**自由函数**（`addTag/removeTag/hasTag`）。
- **系统**：`class X implements System { readonly name = 'X'; update(world, ctx) }`；**禁跨 Tick 隐藏状态**，计时落在组件字段。注册顺序 == 执行顺序。
- 新增文件必须在 `src/ecs/{components,systems,prefabs}/index.ts` 与 `src/ecs/index.ts` barrel 导出。
- **类型安全**：禁 `any`/非空断言 `!`/`@ts-ignore`；类型导入用 `import type`。
- 预制体 `spawn(world, options)` 返回 **`EntityId`**；装配集中在 `spawn-helpers.ts::spawnCombatant`，`PlayerFactory`/`EnemyFactory` 是传不同 `Faction` 的薄封装。
- **组件复用优于新增**：`ActionState`（`IDLE/MOVING/DASHING/ATTACKING/HITSTUN`）是通用动作状态机，新动作优先加枚举 + 在 `StateSystem` 给退出条件。
- **硬件输入与逻辑意图分离**：`PlayerInputComponent`（设备快照）**只挂玩家**；`IntentComponent`（`moveVector` 持久 + `wantsToDash`/`wantsToAttack` 单 Tick 脉冲 + `aimRadians`）挂**所有**战斗单位。玩法系统**只读意图**。脉冲由**消费方读后置 `false`**，**先消费后门控**——门控拒绝时脉冲也必须被丢弃，绝不缓冲补触发。
- **冲刺起手门控**：`DASHING` 只能自 `IDLE`/`MOVING` 进入；门控落在 `DashSystem`（排在 `StateSystem` **之前**）。

## 3. 测试约定
- 浮点位移断言**统一容差 `1e-9`**，禁严格相等。
- 用**真实** `GameSimulator` + 系统，**不许 mock**；`step(1)` 逐 Tick 推进钉时序。
- QA 独立套件 `tests/harness/independent-verify.test.ts` 自带独立 fixture。
- **`step(n)` 处理 tick `0..n-1`**（时钟停在 `n`）。写逐 Tick 断言前先算清相位。
- **`ticksInState` 相位差**：由 `StateSystem` **之后**的系统写入的状态（`CollisionSystem` 的 `HITSTUN`）进入 Tick **不被计数**，可观测跨度比常量多 1 拍；由 `StateSystem` **之前**写入的（`DASHING`/`ATTACKING`）**会被计数**。⇒ 任何「N 拍」常量必须对照管道相位核算。补偿：`applyFreeze` 写 `hitstopTicks + 1`；`CollisionSystem` 进 `HITSTUN` 时 `ticksInState` 种 `1`。**改这两个数前先看 spec 04 §6 逐 Tick 表。**
- 碰撞断言注意实体可能在命中同拍末被 `LifespanSystem` 销毁：需要坐标时在上一拍快照。
- **变异测试是门控类改动的必做步骤**（本项目 13 处变异全被捕获）；**冗余门会掩盖测试空洞**，先看清"还有哪道门顺手拦住了它"，再设计能**独立**观测该门的场景。
- **`grep` vitest 摘要行必须加 `NO_COLOR=1`**（ANSI 转义码会破坏匹配）。

## 4. 工程风险（已踩坑）
- **CI 纯逻辑门 = ESLint AST 门**（flat config / ESLint 9，`eslint.config.mjs`）：对 `src/**/*.ts` 启 `no-restricted-globals`(window/document)、`no-restricted-properties`(Math.random/Date.now)、`no-restricted-syntax`(`new Date()`、`localeCompare`、`/^toLocale/`、`new Intl`)，以及 `no-restricted-imports`（`pixi.js` + `**/client/**`）。AST 门对**注释零误报** ⇒ `src/` 注释可自由用 `window`/`document` 词面量。**仅对 `src/**` 生效**，`client/` 允许 DOM/BOM。
- **`@typescript-eslint/no-unused-vars` 必须配 `argsIgnorePattern: '^_'`**（否则 `update(world, _ctx)` 报错）。
- **ESLint 钉 9 线**：`@eslint/js@*` 会拉 10.x 冲突，须显式钉 `^9.x`。
- **`vite` 必须留 5.x**：`vitest@2.1.8` peer 为 `vite ^5.0.0`。
- **`pixi.js` 是 8.x**：`await app.init({...})`、画布是 **`app.canvas`**（非 `app.view`）、`Graphics` 链式（`g.circle().fill().stroke()`，**无** `beginFill/drawCircle/endFill`）。
- **根 `tsconfig.json` 不得 include `client/`** ⇒ 独立 `tsconfig.client.json`（`lib: [ES2022, DOM, DOM.Iterable]`）+ `typecheck:client`。
- **npm 锁文件平台相关**：需在**无 `node_modules` 的隔离目录**生成后再采纳。
- **vitest 必须 `pool: 'threads'`**（forks 池写系统 Temp 被拒 EPERM）。
- **`export type { X } from './y'` 不会把 `X` 带进本地作用域**，工厂内部使用还需 `import type`。
- 远端仓库 https://github.com/Jaxuu/my-hades（PUBLIC，默认 `main`）——**切勿提交密钥**。

## 5. 规范管道（硬契约，**14 段**，不得重排）
`TransformSnapshotSystem → PlayerControllerSystem → FreezeSystem → AISystem → MovementSystem → DashSystem → StateSystem → CombatActionSystem → CollisionSystem → StatusEffectSystem → ModifierSystem → DeathSystem → EncounterSystem → LifespanSystem`
（`createDefaultSystems(events?, deathEvents?)`）。`LifespanSystem` 恒 LAST。
- **`TransformSnapshotSystem` 必须是 index 0**（M5-T02）：唯一写 `PreviousTransformComponent`、只读 `TransformComponent`，下游观测与它不存在时逐位相同。**改管道会打断 6 处钉桩测试**。
- `FreezeSystem` 必须在所有"逐实体推进"系统之前；`AISystem` 必须在 `FreezeSystem` **之后**。
- `StatusEffectSystem` 必须在 `CollisionSystem` 之后、`ModifierSystem` **之前**（DoT 相位契约唯一手段）。
- `ModifierSystem` 必须在 `CollisionSystem` 之后（读本 Tick 事件）、`DeathSystem` 之前。
- `DeathSystem` 必须在所有伤害来源与 `ModifierSystem` 之后——「Tick 先完整播完，再清点死者」。
- `EncounterSystem` 必须在 `DeathSystem` 之后且 `LifespanSystem` 之前。

## 6. 里程碑铁律（压缩）
**变异引擎（M3）**：`EventQueue` 由 `createDefaultSystems` **构造注入**（不进 `SystemContext`、不挂 `World`）；`ModifierSystem` 每 Tick 全量 `drain()` ⇒ Tick 边界 `size===0`。防递归门 `sourceModifier !== null` **必须在持有者判定之前**。`ModifierSystem` **不跳过冻结实体**。其后注入的判定圆 `activeTicks` 必须 ≥ 2。命中反馈**按需门控**（`hitstopTicks>0 || knockbackForce>0`）。
- **修饰器效果一律放 `src/ecs/modifiers/*` 的 `IModifierHandler`**，注册进 `ModifierRegistry`；`ModifierSystem` 不得含具体祝福逻辑。`context` 是 `ModifierContext extends SystemContext`。handler 除 `id` 外**零字段**。
- **DoT 相位靠管道位置，不靠 `+1` 补偿**（与判定圆/顿帧路线**不混用**）：施加当 Tick 不走状态时钟 ⇒ 第 k 次结算 = `T + k×intervalTicks`、摘除 = `T + durationTicks`，字段值 == 常量值。**DoT = 真实伤害**：只调 `applyDamage`，不生成判定圆/不抛 `HitEvent`/不写顿帧/`HITSTUN`/击退/不冻结门控/不检查无敌帧。状态结算**先于**到期判定。状态列表按 id **升序唯一**（多样性走 `stacks`）。

**敌方 AI（M4-T01）**：`AISystem` **零字段**，FSM 状态全在 `AIControllerComponent`。**AI 输出只有 `IntentComponent`**（不写 `Transform`/`Velocity`、不建实体、不调 `applyDamage`/`applyFreeze`、**不写 `wantsToDash`**）。前摇锁朝向经 `aimRadians`，由 `MovementSystem` **静止**分支落地；`aimRadians === null` ⇒ 与 M1–M3 逐位等价。
- **门控顺序不可交换**：先 `isFrozen`（顿帧=**暂停**，原地冻结不吞帧），后 `HITSTUN`（硬直=**打断**，重置 `IDLE`，作废前摇**不补触发**）。
- 进入前摇那一拍**不递减** `ticksRemaining` ⇒ 出手在「进入拍 + `windupTicks`」。冷却结束只回 `CHASING`/`IDLE` ⇒ 周期 = `windupTicks + cooldownTicks + 1`。
- 「发现」拍不移动（`IDLE→CHASING` 只翻状态，1 Tick 延迟）；但 `IDLE` 的 `dist ≤ attackRadius` 分支**无**延迟。
- `EnemyFactory.spawn` 默认**不挂** `AIControllerComponent`；`ai` 与 `hardwareInput` 互斥（同给抛 `RangeError`）；`attackRadius > sightRadius` 抛 `RangeError`。
- 断言 `wantsToAttack` 必须把探针**插在 `AISystem` 正后方**（`[...base.slice(0,3), probe, ...base.slice(3)]`），并以 `base[2].name === 'AISystem'` 钉插入点。判定圆在**出手同拍**生成。自动索敌：`query` 升序 + **严格 `<`** ⇒ 等距取较小 id；目标**粘性**。

**死亡与遭遇（M4-T02）**：**`DeadTagComponent` 是「死亡」的唯一权威**（零字段，**只能**由 `DeathSystem` 在 Tick 末尾挂载，`markDead` 幂等）。所有门控一律 `isDead(world,id)`，**不得**用 `hp<=0` 重新推导。**`isDead` 对已销毁 id 返回 `false`**（`isAlive` 守卫）——「已销毁」是**独立**跳过理由。
- **死亡是状态，不是删除**：本里程碑**永不销毁战斗单位**，尸体保留全部组件。
- **AC-01 是「当 Tick 末尾 / 次 Tick 起」**⇒ `CollisionSystem` **三道门**：(a) owner 门（目标循环之前）、(b) target 门（廉价提前退出，被 (c) 完全覆盖）、(c) 同 Tick 门（`hp<=0` → 跳过）。**一实体一 Tick 只结算一次**；**同归于尽被刻意允许**。
- 门控顺序：死亡 > 冻结 > 硬直。死亡是唯一**永不失效**的门；`MovementSystem` 的死亡门是**第 0 优先级**。
- **`LifespanSystem` 故意不加死亡门**（判定圆无 `HealthComponent`）。
- **`DeathSystem` 中和意图**（`moveVector=(0,0)`/脉冲 `false`/`aimRadians=null`），否则死时值**永久冻结**在快照里。
- **死亡总线是独立 `EventQueue<EntityDeathEvent>`**（第二参）；事件只有 `{tick, entityId}`；**无强制消费者** ⇒ `DeathSystem` 每拍开头 `clear()`。
- **房间 = 挂 `EncounterStateComponent` 的全局单例实体**（无 Transform/受击盒/寿命）。三态 `IN_PROGRESS/WAVE_CLEAR/ROOM_CLEARED`；`EncounterSystem` **零字段**。
- **`trackedEntityIds` 空列表 = 「本波尚未生成」**；`isWaveCleared` 对空列表返回 `false`。提升到下一波时**清空**名单；`ROOM_CLEARED` 时**保留**最后一波名单。
- **`nextSpawnTick` 存绝对 Tick（`-1` = 未排期）**。第 0 波惰性排期于 `p₀ + delayTicks`；第 `k>0` 波于 `q + delayTicks`。**`delayTicks = 0` 不对称**：第 0 波同拍、后续波下一拍。
- **`EncounterFactory.spawn` 不生成第一波** ⇒ 调用方**必须至少 `step()` 一次**。校验（`resolveEncounterConfig`）在**加载期**做，对每个规格 **dry-run 装配一遍**。
- **`EnemySpawnOptions` 声明在 `spawn-helpers.ts`**（避免 `components` 反向依赖 `prefabs`）。在 Tick `T` 生成的波次，其成员**首次行动在 `T+1`**。

**渲染层（M5 起）**：`client/` 是**唯一**允许 DOM/BOM 与 PixiJS 的目录；渲染层只**单向**读取逻辑层类型与组件，且**只读**（禁 `addComponent`/`destroyEntity`/`applyDamage`）。
- **`PX_PER_UNIT = 10` 是渲染层唯一持有的常量契约**；`container.rotation = facingRadians` **不翻转符号**。
- **`GameLoop` 时序**：累加真实 `deltaMS`，`while (acc >= sim.tickDurationMs && steps < 5) { input.flush(sim); sim.step(1); acc -= sim.tickDurationMs; }`。**注入必须在 `step` 之前**。**必须用 `sim.tickDurationMs`**，禁硬编码 16.67。溢出清累加器防螺旋死亡。
- **`GameRenderer` 的 `retired: Set<EntityId>` 不可删**：尸体**永不销毁** ⇒ 死亡 FX 播完回收视图后下一帧会被 `createMissingViews` 重建、FX 无限重播（P0）。**只在「FX 播完」路径退役**；`recycleDestroyed` 路径**不退役**。依赖 **`World.nextId` 单调递增、id 永不复用**。
- **pixi.js 的 `Container`/`Graphics` 在 node 下可直接构造** ⇒ 用鸭子类型假 `Application`（`{ stage: new Container(), ticker: { deltaMS, add, remove } }`）可做**逐帧回归测试**（`tests/render/renderer_bridge.test.ts`）。

**渲染插值与打击感（M5-T02）**：
- **`PreviousTransformComponent` 是「渲染支撑组件」**：只由 `TransformSnapshotSystem` 写、只由渲染层读，**玩法系统不得读写**；丢弃它不改变模拟。**惰性挂载**（首见实体以当前 Transform 播种）。
- **插值语义**：`syncWorld(world, alpha)`，alpha clamp `[0,1]`；`renderX = (prevX + (currX-prevX)*alpha) * PX_PER_UNIT`；rotation 走 `shortestArcDelta`，值域 **`[-π, π]` 两端都闭**。**alpha 默认 `1`**（`alpha=1 ⇒ renderX=currX`，逐位等价 M5-T01）。
- **`GameLoop` alpha**：追帧 `while` **之后**算 `clamp(accumulatorMs / tickDurationMs, 0, 1)`。代价是恒定 **+1 Tick（≈16.7ms）视觉延迟**（ADR-002 显式取舍）。
- **`fxLayer` 必须是 root 的最后一个子节点**：`init()` 先挂 `fxLayer`，实体视图用 `addChildAt(view, children.length - 1)` 插到它**之下** ⇒ FX 在最上层，同时保住 `root.children[0]/[1]` 升序实体视图的冻结索引契约。**不要改成 `addChild`。**
- **受击闪烁用 `tint`、不新增系统**：`isFrozen || state===HITSTUN` ⇒ `tint=0xff0000`，否则 `0xffffff`。染色在 `syncTransforms` 的 `isDying` 提前 `continue` **之后**。
- **伤害跳字**：`EntityView.lastHp` 在**视图创建时播种**；`hp < lastHp` ⇒ `-(lastHp-hp)` 挂 `fxLayer`，1000ms 后销毁。HP **上升**不得触发。
- ⚠️ **PixiJS v8 在纯 Node**：`new Text({ text, style })` **可构造**、`.text/.x/.y/.alpha` **可读**；**但读 `.width`/`.height`/bounds 抛 `document is not defined`** ⇒ 断言只碰 `.text`/坐标/alpha/父子关系。必须用对象形式（位置参数已废弃）。假 `Application` 无 `renderer`。
- ⚠️ **改管道会打断 6 处钉桩**：`tests/combat/feedback.test.ts`、`tests/ai/enemy_fsm.test.ts`、`tests/combat/boons.test.ts`、`tests/combat/status_effects.test.ts`、`tests/combat/death_and_encounter.test.ts`（5 处 `toEqual` 名数组）+ `enemy_fsm.test.ts` 探针插入点。**探针插入点一律按名 `findIndex` 定位。**
- **已知问题（登记未修）**：`syncWorld(world, NaN)` 穿透 clamp（`Math.min(1,Math.max(0,NaN))===NaN`）⇒ 实体**静默消失**；`Infinity` 正常 clamp。当前调用链不可达。见 spec 10 §10。
- **验证方法（可复用）**：① 变异测试是门控唯一硬证据；② 只读契约对抗性证法——`step` 后取 `snapshot()`，跑 60 帧 `syncWorld` 全路径，再取 `snapshot()` 断言 `toEqual` + `entityCount` 不变；③ 验证插值别用速度积分（浮点），用探针直接写 `transform.x`。

**确定性随机 + 肉鸽循环（M6-T01）**：`Random`（**Mulberry32**）挂 **`World.rng`**，`WorldOptions.seed` / `GameSimulatorOptions.seed` 透传，默认 `DEFAULT_RANDOM_SEED = 0x12345678`。**逻辑层只读、永不重播种**（种子是外部输入，ADR-004）。**刻意偏离** ADR-001「服务不挂 World」：PRNG 是引擎级原语（与 `nextId` 同级），而 `SystemContext` 是冻结契约不能塞字段。**PRNG 状态不进 Snapshot**（抽取顺序分歧会立刻表现为结果状态分歧，快照比较仍有效）。
- **`nextFloat()` 右开 `[0,1)`**；**`nextInt(min,max)` 双端闭**；**`sample(items,count)` = 部分 Fisher-Yates 无放回**（`count > len` 抛 `RangeError`）；`pick([])` 抛错。
- **掉落 = `EncounterStateComponent.pendingRewards: string[] | null`**；不变量 **`pendingRewards !== null` ⟺ `state === ROOM_CLEARED`** ⇒ 「房间惰性」与「有待选项」是同一事实，**不加冗余第二道门**。读侧唯一入口 `findRewardDraft(world)`。
- **`depth`** 独立于 `currentWaveIndex`（后者每次下沉重置 0）；`buildWaveRoster(enemies, depth)` 纯函数追加副本（+x 偏移 `1.5`），**`depth=0` 逐字返回 ⇒ M4 行为逐位不变**。
- **管道 15 段**：`... → DeathSystem → EncounterSystem → RewardSystem → LifespanSystem`（`RewardSystem` 在抽奖者之后、`LifespanSystem` 恒 LAST）。**共 6 处管道钉桩测试**。
- **选择意图走既有 `InputQueue`**（`SelectRewardEvent{kind:'selectReward',tick,rewardId}`），不新建总线：复用「按 Tick 对齐 + FIFO + `inject` 过去 Tick 守卫 + `GameLoop` 注入先于 `step`」。**UI 只发 id，不发索引**；`RewardSystem` 用 `pending.includes(selection)` **重新校验**，伪造/陈旧/未在选项中的 id 一律静默忽略。
- **AC-02 压制**：抽奖期 `PlayerControllerSystem.deriveIntent` 把玩家意图置零（时间照走、调度器惰性）。**只压制阶段 2（意图），不压制阶段 1（设备快照）**；脉冲丢弃不缓冲。相位：**压制自 `T+1` 起**（第 1 段早于第 12 段）。
- **AC-04 结算在 Tick 末尾**（第 13 段）⇒ 下沉后的房间**下一 Tick** 才被拾起 ⇒ **下一波在「选择拍 + 1」生成**。
- **`grantReward`**：词缀类 = `addModifier`（幂等不叠加）；`hp_up`/`dash_up` = 直接写字段（**可叠加**，`dash_up` 下限 `MIN_DASH_COOLDOWN_TICKS = 10`）；未知 id / 已销毁实体返回 `false`。
- **`client/` 绝不含随机逻辑**：抽奖只在 `src/` 由 `world.rng` 完成；UI 渲染 `pendingRewards` 的 id 列表（label 单向读 `REWARD_POOL`），点击走回调注入。
- ⚠️ **`client/UIManager.ts` 无 node 单测**：根 `tsconfig.json` **刻意 exclude `client/`**（`lib` 无 DOM）⇒ node 测试**无法 import** 用到 `document` 的 client 代码（`GameRenderer` 可测是因为它不碰 DOM 全局）。验证 = `typecheck:client` + `vite build`。

## 7. 编排约定（工作室流程）
- **先冻结、再评审、后修复**：禁止在 QA 评审窗口内并发改写受审产物。
- 派单必须带：Task ID / 角色 / 优先级 / 上下文 / Deliverables / **Output Path** / Handoff 指令。
- 成员产出经**主理人中转汇编**，成员之间不直连。高影响动作（git commit / 发布 / 删除）须**人工审批**。
- 默认**不 git commit**：里程碑产物落地后由用户决定是否提交。

## 8. 进度
| 里程碑 | 状态 |
|---|---|
| M0–M4（Harness→死亡/房间波次） | ✅ 209 用例 |
| M5-T01 渲染基建 + PixiJS 桥接 | ✅ 212 用例 · `d9aef43` |
| M5-T02 渲染插值 + 打击感（跳字/闪白） | ✅ 234 用例（17 文件）· `bc91777`+`dcd9b25` |
| M6-T01 确定性 PRNG + 词缀三选一 | ✅ **264 用例**（18 文件）· test/lint/typecheck/build 全绿 |

- 权威规格：`specs/00_harness_spec.md` … `specs/11_roguelike_loop_spec.md`（M5 的 `09_renderer_bridge_spec.md` / `10_render_juice_spec.md`、M6 的 `11_roguelike_loop_spec.md`）。
- ADR：`docs/architecture/ADR-001`（headless ECS 基座）· `ADR-002`（渲染插值）· `ADR-004`（确定性 PRNG）。
