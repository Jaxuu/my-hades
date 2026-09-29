# my-hades · 长期约定（跨会话精华版）

> Headless 确定性动作肉鸽内核（《Hades》核心玩法复刻），**逻辑与渲染完全解耦**。
> Node ≥ 22 · TS `strict` · Vitest（node 环境，`pool: 'threads'`）· **零运行时依赖**（M5 起 `client/` 例外，见 §6）。
> 详细逐里程碑历史见 `.workbuddy-ai/memory/YYYY-MM-DD.md`；本文件只留**不变式与已踩坑**。

## 1. 架构铁律
1. **纯逻辑**：`src/` 禁止 DOM / 墙钟 / 随机。时间**只由 `step()` 推进**。
2. **固定步长**：`fixedDeltaSeconds = 1/fps`（默认 1/60），`tickDurationMs = 1000/fps`（**不截断**）；
   `elapsedSeconds = totalTicks * fixedDeltaSeconds`（乘法，**禁止浮点累加**）。**禁止硬编码 1/60 或 16.67**。
3. **确定性**：同输入序列 ⇒ 逐 Tick 同状态。遍历一律 `World.query`（id 升序）；排序一律 UTF-16 码元序，**禁用 `localeCompare` / `toLocale*` / `Intl`**。
4. **Snapshot 不可变**：深拷贝 + 递归 `Object.freeze`，与实时 world 零引用共享。

## 2. 代码约定
- **组件 = POD**：`ComponentBase` 子类**纯数据**，**禁止**加任何方法（含便捷方法）；操作用**自由函数**（`addTag/removeTag/hasTag`）。
- **系统**：`class X implements System { readonly name = 'X'; update(world, ctx) }`；**禁止跨 Tick 隐藏状态**，计时落在组件字段。注册顺序 == 执行顺序。
- 新增文件必须在 `src/ecs/{components,systems,prefabs}/index.ts` 与 `src/ecs/index.ts` barrel 导出。
- **类型安全**：禁 `any` / 非空断言 `!` / `@ts-ignore`；类型导入用 `import type`。
- 预制体 `spawn(world, options)` 返回 **`EntityId`**；装配集中在 `spawn-helpers.ts::spawnCombatant`，`PlayerFactory`/`EnemyFactory` 只是传不同 `Faction` 的薄封装。
- **组件复用优于新增**：`ActionState`（`IDLE/MOVING/DASHING/ATTACKING/HITSTUN`）是通用动作状态机，新动作优先加枚举 + 在 `StateSystem` 给退出条件。
- **硬件输入与逻辑意图分离**：`PlayerInputComponent`（设备快照）**只挂玩家**；`IntentComponent`（`moveVector` 持久 + `wantsToDash`/`wantsToAttack` 单 Tick 脉冲 + `aimRadians`）挂**所有**战斗单位。玩法系统**只读意图**。
  脉冲由**消费方读后置 `false`**，**先消费后门控**——门控拒绝时脉冲也必须被丢弃，绝不缓冲补触发。
- **冲刺起手门控**：`DASHING` 只能自 `IDLE`/`MOVING` 进入；门控必须落在 `DashSystem`（它排在 `StateSystem` **之前**）。

## 3. 测试约定
- 浮点位移断言**统一容差 `1e-9`**，禁严格相等。
- 用**真实** `GameSimulator` + 系统，**不许 mock**；`step(1)` 逐 Tick 推进钉时序。
- QA 独立套件 `tests/harness/independent-verify.test.ts` 自带独立 fixture，不共享工程断言/夹具。
- **`step(n)` 处理 tick `0..n-1`**（时钟停在 `n`）。写逐 Tick 断言前先算清相位。
- **`ticksInState` 相位差**：由 `StateSystem` **之后**的系统写入的状态（`CollisionSystem` 的 `HITSTUN`）进入 Tick **不被计数**，可观测跨度比常量多 1 拍；由 `StateSystem` **之前**的系统写入的（`DASHING`/`ATTACKING`）**会被计数**。⇒ 任何「N 拍」常量都必须对照管道相位核算。补偿手段：`applyFreeze` 写 `hitstopTicks + 1`；`CollisionSystem` 进 `HITSTUN` 时 `ticksInState` 种 `1`。**改这两个数前先看 spec 04 §6 逐 Tick 表。**
- 碰撞断言注意实体可能在命中同拍末被 `LifespanSystem` 销毁：需要坐标时在上一拍快照。
- **变异测试是门控类改动的必做步骤**（本项目 13 处变异全被捕获）；**冗余门会掩盖测试空洞**，先看清"还有哪道门顺手拦住了它"，再设计能**独立**观测该门的场景（对抗性探针：手工写 `wantsToAttack`、`hitstopTicks=0, knockbackForce>0` 的判定圆）。
- **`grep` vitest 摘要行必须加 `NO_COLOR=1`**（ANSI 转义码会破坏 `^ *Tests +[0-9]`；`Failed Tests 1` 会假匹配）。

## 4. 工程风险（已踩坑）
- **CI 纯逻辑门 = ESLint AST 门**（flat config / ESLint 9，`eslint.config.mjs`）：对 `src/**/*.ts` 启 `no-restricted-globals`(window/document)、`no-restricted-properties`(Math.random/Date.now)、`no-restricted-syntax`(`new Date()`、`localeCompare`、`/^toLocale/`、`new Intl`)。AST 门对**注释零误报** ⇒ `src/` 注释可自由使用 `window`/`document` 词面量。**旧的 `grep -rnE` 门已删除**（把注释里的普通英文词当违规）。
  **M5 起**：这些规则必须**仅对 `src/**` 生效**，`client/` 允许 DOM/BOM。
- **`@typescript-eslint/no-unused-vars` 必须配 `argsIgnorePattern: '^_'`**（否则 `update(world, _ctx)` 报错）。
- **ESLint 钉 9 线**：`@eslint/js@*` 会拉 10.x 冲突，须显式钉 `^9.x`。
- **`vite` 必须留在 5.x**：`vitest@2.1.8` 的 peerDependency 是 `vite ^5.0.0`，装 vite 8 会 peer 冲突。升 vitest 时才能一起升。
- **`pixi.js` 是 8.x，API 与 v7 差异极大**：`await app.init({...})`、画布是 **`app.canvas`**（不是 `app.view`）、`Graphics` 链式（`g.circle().fill().stroke()`，**无** `beginFill/drawCircle/endFill`）。
- **根 `tsconfig.json` 不得 include `client/`**（根 `lib` 只有 `ES2022`，无 DOM）⇒ 独立 `tsconfig.client.json`（`lib: [ES2022, DOM, DOM.Iterable]`）+ `typecheck:client` 脚本。
- **npm 锁文件平台相关**：需在**无 `node_modules` 的隔离目录**生成后再采纳；`npm ci` 缺 optional 平台包时**静默 exit 0** → vitest `MODULE_NOT_FOUND`。
- **vitest 必须 `pool: 'threads'`**（默认 forks 池在本环境写系统 Temp 被拒 EPERM）。
- **`export type { X } from './y'` 不会把 `X` 带进本地作用域**，工厂内部使用还需 `import type`。
- 远端仓库 https://github.com/Jaxuu/my-hades（PUBLIC，默认 `main`）——**切勿提交密钥**。

## 5. 规范管道（硬契约，13 段，不得重排）
`PlayerControllerSystem → FreezeSystem → AISystem → MovementSystem → DashSystem → StateSystem → CombatActionSystem → CollisionSystem → StatusEffectSystem → ModifierSystem → DeathSystem → EncounterSystem → LifespanSystem`
（`createDefaultSystems(events?, deathEvents?)`）。M1/M2 六段相对顺序**一字不改**。
- `FreezeSystem` 必须在所有"逐实体推进"系统之前；`AISystem` 必须在 `FreezeSystem` **之后**（要看到递减后的冻结判据，否则顿帧恢复错拍）。
- `StatusEffectSystem` 必须在 `CollisionSystem` 之后、`ModifierSystem` **之前**（DoT 相位契约的唯一实现手段）。
- `ModifierSystem` 必须在 `CollisionSystem` 之后（读本 Tick 事件）、`DeathSystem` 之前。
- `DeathSystem` 必须在所有伤害来源与 `ModifierSystem` 之后——「Tick 先完整播完，再清点死者」。
- `EncounterSystem` 必须在 `DeathSystem` 之后且 `LifespanSystem` 之前；`LifespanSystem` **必须最后**。

## 6. 里程碑铁律（压缩）
**变异引擎（M3）**：`EventQueue` 由 `createDefaultSystems` **构造注入**（不进 `SystemContext`、不挂 `World`）；`ModifierSystem` 每 Tick 全量 `drain()` ⇒ Tick 边界 `size===0`。防递归门 `sourceModifier !== null` **必须在持有者判定之前**（否则指数爆炸）。`ModifierSystem` **不跳过冻结实体**。**其后注入的判定圆 `activeTicks` 必须 ≥ 2**（"1 Tick 延迟"是架构固有属性）。命中反馈写入**按需门控**（`hitstopTicks>0 || knockbackForce>0`），纯伤害圆不清零击退。
- **修饰器效果一律放 `src/ecs/modifiers/*` 的 `IModifierHandler`**，注册进 `ModifierRegistry`；`ModifierSystem` 不得含具体祝福逻辑。`context` 是 `ModifierContext extends SystemContext`（扩展而非修改）。handler 除 `id` 外**零字段**。
- **DoT 相位靠管道位置，不靠 `+1` 补偿**（与判定圆/顿帧路线**不要混用**）：施加当 Tick 不走状态时钟 ⇒ 第 k 次结算 = `T + k×intervalTicks`、摘除 = `T + durationTicks`，字段值 == 常量值。**DoT = 真实伤害**：只调 `applyDamage`，不生成判定圆/不抛 `HitEvent`/不写顿帧/`HITSTUN`/击退/不做冻结门控/不检查无敌帧。状态结算**先于**到期判定。状态列表按 id **升序唯一**（多样性走 `stacks`）。

**敌方 AI（M4-T01）**：`AISystem` **零字段**，FSM 状态全在 `AIControllerComponent`。**AI 输出只有 `IntentComponent`**（不写 `Transform`/`Velocity`、不建实体、不调 `applyDamage`/`applyFreeze`、**不写 `wantsToDash`**）。前摇锁朝向经 `aimRadians`，由 `MovementSystem` **静止**分支落地（保持 `facingRadians` 单一写入者）；`aimRadians === null` ⇒ 与 M1–M3 逐位等价。
- **门控顺序不可交换**：先 `isFrozen`（顿帧=**暂停**，原地冻结不吞帧），后 `HITSTUN`（硬直=**打断**，重置 `IDLE`，作废前摇**不补触发**）。
- 进入前摇那一拍**不递减** `ticksRemaining` ⇒ 出手在「进入拍 + `windupTicks`」。冷却结束只回 `CHASING`/`IDLE` ⇒ 周期 = `windupTicks + cooldownTicks + 1`。
- 「发现」拍不移动（`IDLE→CHASING` 只翻状态，1 Tick 反应延迟）；但 `IDLE` 的 `dist ≤ attackRadius` 分支**无**延迟。
- `EnemyFactory.spawn` 默认**不挂** `AIControllerComponent`；`ai` 与 `hardwareInput` 互斥（同给抛 `RangeError`）；`attackRadius > sightRadius` 抛 `RangeError`。
- 断言 `wantsToAttack` 必须把探针**插在 `AISystem` 正后方**（`[...base.slice(0,3), probe, ...base.slice(3)]`），并以 `base[2].name === 'AISystem'` 钉住插入点。判定圆在**出手同拍**生成。
- 自动索敌：`query` 升序 + **严格 `<`** ⇒ 等距取较小 id；目标**粘性**。

**死亡与遭遇（M4-T02）**：**`DeadTagComponent` 是「死亡」的唯一权威**（零字段，**只能**由 `DeathSystem` 在 Tick 末尾挂载，`markDead` 幂等）。所有门控一律 `isDead(world,id)`，**不得**用 `hp<=0` 重新推导。**`isDead` 对已销毁 id 返回 `false`**（`isAlive` 守卫）——「已销毁」是**独立**跳过理由，绝不折叠进「已死」。
- **死亡是状态，不是删除**：本里程碑**永不销毁战斗单位**，尸体保留全部组件。
- **AC-01 是「当 Tick 末尾 / 次 Tick 起」**⇒ `CollisionSystem` **三道门**：(a) **owner 门**（在目标循环之前）、(b) **target 门**（廉价提前退出，(b) 被 (c) 完全覆盖）、(c) **同 Tick 门**（`hp<=0` → 跳过）。**一实体一 Tick 只结算一次**；**同归于尽被刻意允许**。
- 门控顺序：死亡 > 冻结 > 硬直。死亡是唯一**永不失效**的门；`MovementSystem` 的死亡门是**第 0 优先级**。
- **`LifespanSystem` 故意不加死亡门**（判定圆无 `HealthComponent`），死者的挥砍仍按原计划老化。
- **`DeathSystem` 中和意图**（`moveVector=(0,0)`/脉冲 `false`/`aimRadians=null`），否则死时值**永久冻结**在快照里。
- **死亡总线是独立 `EventQueue<EntityDeathEvent>`**（第二参）；事件只有 `{tick, entityId}`；**无强制消费者** ⇒ `DeathSystem` 每拍开头 `clear()`，`step()` 后装的**恰好是刚处理那一拍**。
- **房间 = 挂 `EncounterStateComponent` 的全局单例实体**（无 Transform/受击盒/寿命）。三态 `IN_PROGRESS/WAVE_CLEAR/ROOM_CLEARED`；`EncounterSystem` **零字段**。
- **`trackedEntityIds` 空列表 = 「本波尚未生成」**（一波必须至少声明一个敌人）；`isWaveCleared` 对空列表返回 `false`。提升到下一波时**清空**名单；`ROOM_CLEARED` 时**保留**最后一波名单。
- **`nextSpawnTick` 存绝对 Tick（`-1` = 未排期）**，不存倒计时。第 0 波惰性排期于 `p₀ + delayTicks`；第 `k>0` 波于 `q + delayTicks`（`q` = 上一波被检测清空的拍）。**`delayTicks = 0` 有不对称**：第 0 波同拍、后续波下一拍。
- **`EncounterFactory.spawn` 不生成第一波** ⇒ 调用方**必须至少 `step()` 一次**。校验（`resolveEncounterConfig`）在**加载期**做，对每个规格 **dry-run 装配一遍**（不抄 `spawnCombatant` 规则）。
- **`EnemySpawnOptions` 声明在 `spawn-helpers.ts`**（避免 `components` 反向依赖 `prefabs`）。
- 在 Tick `T` 生成的波次，其成员**首次行动在 `T+1`**。

**渲染层（M5 起）**：`client/` 是**唯一**允许 DOM/BOM 与 PixiJS 的目录；`src/` 严禁导入任何表现层代码——由 `eslint.config.mjs` 对 `src/**/*.ts` 的 `no-restricted-imports`（`pixi.js` + `**/client/**`）**强制**，已变异测试验证。渲染层只**单向**读取逻辑层类型与组件，且**只读**（禁 `addComponent`/`destroyEntity`/`applyDamage`）。
- **`PX_PER_UNIT = 10` 是渲染层唯一持有的常量契约**（`src/` 中无任何像素概念）；`container.rotation = facingRadians` **不翻转符号**（世界 y 直接映射屏幕 y 向下）。
- **`GameLoop` 时序**：累加真实 `deltaMS`，`while (acc >= sim.tickDurationMs && steps < 5) { input.flush(sim); sim.step(1); acc -= sim.tickDurationMs; }`。**注入必须在 `step` 之前**（`inject` 对 `tick < sim.tick` 抛 `RangeError`，而 `step(1)` 处理的正是 `sim.tick`）。**必须用 `sim.tickDurationMs`**，禁硬编码 16.67。溢出清累加器防螺旋死亡。
- **`GameRenderer` 的 `retired: Set<EntityId>` 不可删**：尸体**永不销毁**（spec 08 §4.4）⇒ 死亡 FX 播完回收视图后，下一帧会被 `createMissingViews` 重建、FX 无限重播（P0 缺陷，实测 `viewCount` 呈 `2,…,2,1,2,…,2,1` 周期振荡）。**只在「FX 播完」路径退役**；`recycleDestroyed` 路径**不退役**（自纠正，且误退役会在 id 复用时永久隐藏合法实体）。安全性依赖 **`World.nextId` 单调递增、id 永不复用**。
- **pixi.js 的 `Container`/`Graphics` 在 node 下可直接构造**（无需 jsdom / 真浏览器）⇒ 用鸭子类型假 `Application`（`{ stage: new Container(), ticker: { deltaMS, add, remove } }`）即可对渲染桥接做**逐帧回归测试**。见 `tests/render/renderer_bridge.test.ts`。

## 7. 编排约定（工作室流程）
- **先冻结、再评审、后修复**：禁止在 QA 评审窗口内并发改写受审产物。
- 派单必须带：Task ID / 角色 / 优先级 / 上下文 / Deliverables / **Output Path** / Handoff 指令。
- 成员产出经**主理人中转汇编**，成员之间不直连。高影响动作（git commit / 发布 / 删除）须**人工审批**。
- 默认**不 git commit**：里程碑产物落地后由用户决定是否提交。

## 8. 进度
| 里程碑 | 状态 |
|---|---|
| M0-T01 Harness + 工程基座 | ✅ |
| M1-T01 基础移动 | ✅ |
| M1-T02 冲刺/状态机/无敌帧 | ✅ 72 用例 |
| M2-T01 基础战斗/圆碰撞 | ✅ 86 用例 |
| M2-T02 意图解耦/顿帧/硬直/ESLint 门 | ✅ 116 用例 |
| M3-T01 变异引擎基础 | ✅ 143 用例 · `7f4bd93` |
| M3-T02 修饰器注册表 + DoT | ✅ 165 用例 · `02208b7` |
| M4-T01 敌方 AI + 攻击预警 | ✅ 186 用例 · `f2ea2fc` |
| M4-T02 死亡生命周期 + 房间波次 | ✅ 209 用例 · `25bd435` |
| M5-T01 渲染表现层基建 + PixiJS 桥接 | ✅ 212 用例 · 未提交 |

- 权威规格：`specs/00_harness_spec.md` … `specs/08_encounter_and_death_spec.md`（+ M5 的 `specs/09_renderer_bridge_spec.md`）。
