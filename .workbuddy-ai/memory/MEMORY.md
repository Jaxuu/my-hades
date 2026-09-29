# my-hades · 项目长期约定（跨会话）

> 项目：Headless 确定性动作肉鸽模拟内核（《Hades》核心玩法复刻），**逻辑与渲染完全解耦**。
> 运行时：Node ≥ 22 · TypeScript `strict` 全开 · Vitest（node 环境，`pool: 'threads'`）· **零运行时依赖**。

## 1. 架构铁律（改代码前必读）
1. **纯逻辑**：`src/` 禁止 DOM / 墙钟 / 随机（CI 有静态门拦截）。时间**只由 `step()` 推进**。
2. **固定步长**：`fixedDeltaSeconds = 1/fps`（默认 1/60），`tickDurationMs = 1000/fps`（**不截断**）；
   `elapsedSeconds = totalTicks * fixedDeltaSeconds`（乘法，**禁止浮点累加**）。**禁止硬编码 1/60 或 16.67**。
3. **确定性**：同输入序列 ⇒ 逐 Tick 同状态。遍历一律走 `World.query`（id 升序）。
4. **Snapshot 不可变**：深拷贝 + 递归 `Object.freeze`，与实时 world 零引用共享。

## 2. 代码约定
- **组件 = POD**：`ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法（连便捷方法都不加）。
  需要操作数据时用**自由函数**（如 `addTag/removeTag/hasTag`）。
- **系统**：`class X implements System { readonly name = 'X'; update(world, ctx) }`；
  **禁止跨 Tick 隐藏状态**，计时一律落在组件字段上。注册顺序 == 执行顺序。
- 新增文件必须在 `src/ecs/{components,systems,prefabs}/index.ts` 与 `src/ecs/index.ts` barrel 导出。
- **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- 预制体工厂 `spawn(world, options)` 一律返回 **`EntityId`**（不是 Entity 对象）。
  装配逻辑集中在 `src/ecs/prefabs/spawn-helpers.ts::spawnCombatant`，`PlayerFactory` / `EnemyFactory`
  只是传入不同 `Faction` 的薄封装——**不要在工厂里重复组件清单或校验逻辑**。
- **组件复用优于新增组件**：`ActionState` 是通用动作状态机（`IDLE/MOVING/DASHING/ATTACKING/HITSTUN`），
  新动作优先加枚举值 + 在 `StateSystem` 里给出退出条件，而不是新开一个状态组件。
- **硬件输入与逻辑意图分离**（M2-T02 起）：`PlayerInputComponent`（真实设备快照）**只挂玩家**；
  `IntentComponent`（`moveVector` 持久 + `wantsToDash`/`wantsToAttack` 单 Tick 脉冲）挂**所有**战斗单位。
  玩法系统**只读 `IntentComponent`**；敌人由 AI/脚本直接写意图。
  意图脉冲由**消费方读后置 `false`**（`DashSystem`/`CombatActionSystem`），**先消费后门控**——
  门控拒绝时脉冲也必须被丢弃，绝不允许缓冲到状态结束后补触发。
- **冲刺起手门控**：`DASHING` **只能自 `IDLE`/`MOVING` 进入**（spec 02 §4.1）。
  `HITSTUN`/`ATTACKING` 不可被冲刺取消（F1/F2 修复，M2-T02）。
  门控必须落在 `DashSystem`——它排在 `StateSystem` **之前**，`StateSystem` 的分支顺序拦不住起手。

## 3. 测试约定
- 浮点位移断言**统一容差 `1e-9`**，**禁止严格相等**（逐 Tick 积分漂移实测 ~1e-15）。
- 测试用**真实** `GameSimulator` + 系统，**不许 mock**；`step(1)` 逐 Tick 推进以钉住时序契约。
- QA 独立套件 `tests/harness/independent-verify.test.ts` 自带独立 fixture，**不共享**工程测试的断言与夹具。
- **`step(n)` 处理的是 tick `0..n-1`**（时钟随后停在 `n`）。写逐 Tick 断言前先算清「step 几次 = 处理到哪个 tick」，
  否则极易差一拍（例：12 Tick 无敌窗口的最后一拍是 tick `t0+11`，标签在 tick `t0+12` 摘除）。
- 碰撞类断言注意**实体可能在命中同一拍末被 `LifespanSystem` 销毁**：需要坐标时先在上一拍快照，
  不要等命中后再 `getComponent(hitbox)`。
- **`ticksInState` 存在相位差（M2-T02 实测教训，极易踩）**：`ticksInState` 由 `StateSystem` 推进，
  因此**由排在 `StateSystem` 之后的系统**写入的状态（如 `CollisionSystem` 写的 `HITSTUN`），
  其进入 Tick **不会被计数**，实际可观测跨度比常量多 1 个 Tick。
  而 `DashSystem`/`CombatActionSystem` 排在 `StateSystem` **之前**，它们写入的状态（`DASHING`/`ATTACKING`）
  进入 Tick **会被计数**。⇒ 任何「N 个 Tick」的常量都必须对照管道相位核算；
  本项目的补偿手段：`applyFreeze` 写入 `hitstopTicks + 1`；`CollisionSystem` 进入 `HITSTUN` 时
  `ticksInState` 种入 `1` 而非 `0`。**改这两个数字前必须先看 spec 04 §6 的逐 Tick 表。**

## 4. 工程风险（已踩过的坑）
- **npm 锁文件是平台相关的**：需在**无 `node_modules` 的隔离目录**生成后再采纳。
- **`npm ci` 严格锁文件驱动**：缺 optional 平台包时**不报错（exit 0）但静默跳过** → vitest `MODULE_NOT_FOUND`。
- **vitest 必须 `pool: 'threads'`**：默认 forks 池在本环境写系统 Temp 被拒（EPERM）。
- **CI 纯逻辑门 = ESLint AST 门**（M2-T02 起，`eslint.config.mjs`，flat config / ESLint 9）：
  对 `src/**/*.ts` 启用 `no-restricted-globals`(window/document)、`no-restricted-properties`(Math.random/Date.now)、
  `no-restricted-syntax`(new Date())。**旧的 `grep -rnE` 门已删除**——它会把注释里的普通英文名词
  （如句末的 `window.`）当违规，逼着人给注释"绕词"。AST 门对注释**零误报**，已用变异测试验证
  （真实访问 → 5 error；仅注释提及 → 0 error）。⇒ `src/` 注释现在**可以**自由使用 `window` / `document` 词面量。
  **M4-T01 又补了 R6 三条 selector**：`CallExpression[callee.property.name="localeCompare"]`、
  `[callee.property.name=/^toLocale/]`、`new Intl` ⇒ 变异测试 3 error、注释提及 0 误报。
  `World.listComponents` 原用 `localeCompare` 排组件名（进入 `snapshot()`！）已改为
  `compareComponentTypeName`（UTF-16 码元序），回归断言在 `tests/harness/ecs.test.ts`（夹具 `Zebra` / `alpha`）。
- **`@typescript-eslint/no-unused-vars` 必须配 `argsIgnorePattern: '^_'`**：否则 `update(world, _ctx)`
  这种"故意不用"的参数会被默认的 `args: 'after-used'` 报错，`npm run lint` 不可能全绿。
- **ESLint 版本钉在 9 线**：`@eslint/js@*` 会拉 10.x 与 eslint 9 冲突，须显式钉 `^9.x`。

## 5. 编排约定（工作室流程）
- **先冻结、再评审、后修复**：禁止在 QA 评审窗口内并发改写受审产物（M0 的 C1 教训）。
- 派单必须带：Task ID / 角色 / 优先级 / 上下文 / Deliverables / **Output Path** / Handoff 指令。
- 成员产出经**主理人中转汇编**，成员之间不直连。
- 高影响动作（git commit / 发布 / 删除）须**人工审批**。
- 默认**不 git commit**：里程碑产物落地后由用户决定是否提交。

## 6. 当前进度
| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0-T01 | Headless 确定性 Harness + 工程基座 | ✅ PASS |
| M1-T01 | 基础移动控制（`MovementSystem` + 3 组件 + `PlayerFactory`） | ✅ |
| M1-T02 | 冲刺 / 动作状态机 / 无敌帧（`DashSystem` + `StateSystem` + 管道） | ✅ PASS（8 文件 / 72 用例全绿） |
| M2-T01 | 基础战斗 / 圆碰撞 / 无敌帧消费（4 组件 + 3 系统 + `EnemyFactory`） | ✅ PASS（9 文件 / 86 用例全绿） |
| M2-T02 | 意图解耦 / 顿帧 Hitstop / 受击硬直与击退 / CI 门禁 ESLint 化 | ✅ PASS（10 文件 / **116 用例全绿**） |
| M3-T01 | 变异引擎基础与事件拦截管道（`HitEvent` / `EventQueue` / `ModifierComponent` / `ModifierSystem` / Zeus Strike） | ✅ PASS（11 文件 / 143 用例全绿，已提交 `7f4bd93`） |
| M3-T02 | 修饰器注册表 + 状态异常容器 + DoT（`ModifierRegistry` / `IModifierHandler` / `StatusEffectComponent` / `StatusEffectSystem` / `DionysusBlightModifier`） | ✅ PASS（12 文件 / **165 用例全绿**，已提交 `02208b7`） |
| M4-T01 | 敌方状态机 AI 与攻击预警（`AIControllerComponent` / `AIState` / `AISystem` / `IntentComponent.aimRadians` / `resolveAITuning`）+ 确定性技术债（`localeCompare` → 码元序，ADR-001 R6） | ✅ PASS（13 文件 / **186 用例全绿**，已提交 `f2ea2fc`） |
| M4-T02 | 死亡生命周期与房间波次调度（`DeadTagComponent` / `DeathSystem` / `EntityDeathEvent` / 九道死亡门 + `CollisionSystem` 三重门 / `EncounterStateComponent` / `EncounterSystem` / `EncounterFactory`） | ✅ PASS（14 文件 / **209 用例全绿**，未提交） |

- 规范管道（**硬契约，不得重排，13 段**）：
  `PlayerControllerSystem → FreezeSystem → AISystem → MovementSystem → DashSystem → StateSystem
   → CombatActionSystem → CollisionSystem → StatusEffectSystem → ModifierSystem
   → DeathSystem → EncounterSystem → LifespanSystem`（`createDefaultSystems(events?, deathEvents?)`）。
  `PlayerControllerSystem`（硬件→意图）取代原 `MovementSystem.bindInput` 成为首段；
  `FreezeSystem` 紧随其后，必须在所有"逐实体推进"系统之前；
  `AISystem`（AI→意图，M4-T01）**必须在 `FreezeSystem` 之后、所有推进系统之前**——它要看到**递减后**的冻结判据，
  否则顿帧恢复拍会与运动系统错开一拍（相位契约，不是风格）；`StatusEffectSystem` **必须在 `CollisionSystem` 之后
  且 `ModifierSystem` 之前**（DoT 相位契约的唯一实现手段，见下）；`ModifierSystem` **必须在 `CollisionSystem` 之后
  （读本 Tick 事件）、`DeathSystem` 之前**；`DeathSystem`（M4-T02）**必须在所有伤害来源
  （`CollisionSystem` / `StatusEffectSystem`）与 `ModifierSystem` 之后**——「Tick 先完整播完，再清点死者」；
  `EncounterSystem` **必须在 `DeathSystem` 之后**（它的全部输入就是死亡标签）且 `LifespanSystem` 之前；
  `LifespanSystem` **必须最后**（否则判定圆少一个 Tick 有效窗口）。M1/M2 六段相对顺序**一字不改**。
- 权威规格：`specs/00_harness_spec.md`、`specs/01_character_controller_spec.md`、`specs/02_dash_and_state_spec.md`、
  `specs/03_combat_hitbox_spec.md`、`specs/04_combat_feedback_spec.md`、`specs/05_boon_modifier_spec.md`、
  `specs/06_status_effect_and_dot_spec.md`、`specs/07_enemy_ai_spec.md`、`specs/08_encounter_and_death_spec.md`。
- **变异引擎（M3-T01）铁律**：
  - 事件总线 `EventQueue<T = HitEvent>` 由 `createDefaultSystems(events?)` **构造注入**（不塞 `SystemContext`、
    不挂 `World`）；`ModifierSystem` 每 Tick 全量 `drain()` ⇒ **Tick 边界 `size === 0`**（非隐藏状态）。
  - 防递归门 `sourceModifier !== null` **必须在持有者判定之前**（否则 `1→2→4→…` 指数爆炸）。
  - `ModifierSystem` **不跳过冻结实体**（顿帧与命中同 Tick 写入；跳过则 Zeus 永不触发）。
  - **`ModifierSystem` 之后注入的判定圆，`activeTicks` 必须 ≥ 2**（当 Tick 不被判定，当 Tick 末即被
    `LifespanSystem` 自减 ⇒ 写 1 会静默失效）。**"1 Tick 延迟"是架构固有属性。**
  - 命中反馈写入**按需门控**：`hitstopTicks > 0 || knockbackForce > 0`。纯伤害判定圆两项皆 `0` ⇒
    不延长顿帧、**不清零击退**（`KnockbackComponent` 是覆盖写）。
- **变异引擎（M3-T02）铁律**：
  - **修饰器效果一律放 `src/ecs/modifiers/*` 的 `IModifierHandler` 实现里，注册进 `ModifierRegistry`**；
    `ModifierSystem` 只做「全量 `drain` → 防递归门 → 遍历攻击者 `modifiers`（升序）→ `registry.get(id)?.onHit(...)`」，
    **不得**再出现任何具体祝福逻辑。`onHit(event, context)` 的 `context` 是
    `ModifierContext extends SystemContext`（多一个 `world`）——**扩展而非修改 `SystemContext`**（C6）。
  - handler **除 `id` 外零字段**（无跨 Tick 隐藏状态）；`drain()` 为空时连 context 都不构造。
  - **DoT 相位靠「管道位置」解决，不靠 `+1` 补偿**（与判定圆/顿帧的补偿路线**不要混用**）：
    `StatusEffectSystem` 排在 `ModifierSystem` **之前** ⇒ 施加当 Tick 不走状态时钟
    ⇒ 第 k 次结算 = `T + k×intervalTicks`、摘除 = `T + durationTicks`，且**字段值 == 常量值**。
    若挪到 `ModifierSystem` 之后，spec 06 §6 的每个数字都会静默少 1。
  - **DoT = 真实伤害**：只调 `applyDamage`。**不生成判定圆、不抛 `HitEvent`、不写顿帧/`HITSTUN`/`KnockbackComponent`、
    不做冻结门控、不检查无敌帧**。写击退会覆盖清零基础命中；进 `HITSTUN` 会变硬直锁。
  - 状态结算**先于**到期判定（否则 `duration = k×interval` 时第 k 次结算消失）；`durationTicks` 取 `intervalTicks` 整数倍。
  - 状态列表按 id **升序唯一**（多样性走 `stacks`）；排序一律 UTF-16 码元序（`<`/`>`），**禁用 `localeCompare`**。
- **敌方 AI（M4-T01）铁律**：
  - `AISystem` **零字段**（除 `readonly name`）；FSM 全部状态落在 `AIControllerComponent`
    （`state`/`ticksRemaining`/`lockedFacingRadians`/`targetEntityId`）。
  - **AI 的输出只有 `IntentComponent`**（`moveVector` / `wantsToAttack` / `aimRadians`）：
    不写 `Transform`/`Velocity`、不建实体、不调 `applyDamage`/`applyFreeze`、**不写 `wantsToDash`**。
    前摇的「锁定出手朝向」经 `IntentComponent.aimRadians` 表达，由 `MovementSystem` 的**静止**分支落地——
    保持「`facingRadians` 只有一个写入者」。`aimRadians === null` ⇒ 与 M1–M3 逐位等价。
  - **门控顺序不可交换**：先判 `isFrozen`（顿帧 = **暂停**，`ticksRemaining` 原地冻结，不吞帧），
    后判 `ActionState.HITSTUN`（硬直 = **打断**：重置 `IDLE`，被作废的前摇**不补触发**，恢复后重新评估）。
    同一次命中同时写 hitstop + HITSTUN，先判硬直会把「暂停」降级成「打断」。
  - **进入前摇那一拍不递减 `ticksRemaining`** ⇒ 前摇恰 `windupTicks` 拍，出手在「进入拍 + `windupTicks`」。
    **冷却结束只回 `CHASING`/`IDLE`**（不直接进 `WINDUP`）⇒ 周期 = `windupTicks + cooldownTicks + 1`。
  - **「发现」拍不移动**：`IDLE → CHASING` 只翻状态、不输出向量（1 Tick 反应延迟，也让两态行为真正不同）。
    但 `IDLE` 的 `dist ≤ attackRadius` 分支**无**延迟，直接起前摇。
  - **AI 挂载是可选能力**：`EnemyFactory.spawn` 默认**不挂** `AIControllerComponent`（默认挂会覆写 M1–M3
    全部手写意图用例）；`ai` 与 `hardwareInput` 互斥（同时给出抛 `RangeError`）；`attackRadius > sightRadius` 抛 `RangeError`。
  - **`wantsToAttack` 是单 Tick 脉冲且同拍被 `CombatActionSystem` 消费**：断言它必须把探针**插在 `AISystem` 正后方**
    （`[...base.slice(0,3), probe, ...base.slice(3)]`），并以 `base[2].name === 'AISystem'` 钉住插入点。
    判定圆在**出手同拍**生成（不是下一拍），并在下一拍仍存活。
  - **自动索敌**：`query` 升序 + **严格 `<`** ⇒ 等距取较小 id；目标**粘性**（锁定后不换，除非失效）。
- **死亡生命周期与遭遇（M4-T02）铁律**：
  - **`DeadTagComponent` 是「死亡」的唯一权威**：零字段组件，**只能**由 `DeathSystem` 在 Tick 末尾挂载
    （`markDead` 幂等）。造成伤害的系统**绝不**自己标记死亡——这是「转移恰好一次、在一个可审计的点」的保证。
    所有门控一律 `isDead(world, id)`，**不得**改用 `hp <= 0` 重新推导（未来加治疗/复活会静默失效）。
  - **`isDead` 对已销毁 id 返回 `false`**（靠 `isAlive` 守卫）。「已销毁」是**独立的**跳过理由，
    **绝不能**折叠进「已死」——`CollisionSystem` 的 owner 门因此保住了「判定圆可以比主人活得久」这条 M1–M3 契约。
  - **死亡是状态，不是删除**：本里程碑**永不销毁战斗单位**。尸体保留全部组件，
    否则房间调度器无法区分「我的成员死了」与「这个 id 从未存在」。
  - **AC-01 是「当 Tick 末尾 / 次 Tick 起」**：标签在致死拍末才挂，所以**同 Tick 之内标签还不存在**。
    ⇒ `CollisionSystem` 需要**三道**门：(a) **owner 门**（死者挥砍整颗失效，在目标循环之前）、
    (b) **target 门**（尸体不是命中目标）、(c) **同 Tick 门**（`targetHealth.hp <= 0` → 跳过，
    堵住「两颗判定圆在同一 Tick 都结算、第二颗写一次多余顿帧」的洞）。**一实体一 Tick 只结算一次。**
    **同归于尽被刻意允许**：Tick 结算原子，AC-01 只约束「次 Tick 起」。
  - **(b) 被 (c) 完全覆盖**（死亡定义就是 `hp <= 0`）⇒ (b) 是**廉价提前退出**，不是唯一防线。
    想独立断言 (b)，必须构造「带标签但 `hp > 0`」的实体——正常玩法产不出来，但这钉住了「门的键是标签」。
  - **门控顺序不可交换**：死亡 > 冻结（暂停，计时原地冻结）> 硬直（打断，重置 `IDLE`，作废前摇不补触发）。
    死亡是唯一**永不失效**的门。`MovementSystem` 的死亡门是**第 0 优先级**（高于冻结）。
  - **`LifespanSystem` 故意不加死亡门**：判定圆不是战斗单位、没有 `HealthComponent`；
    死者的挥砍仍按原计划老化，保住 spec 03 §6 的「恰好活 `activeTicks` 拍」契约。
    死者挥砍的退役由 owner 门在**使用点**执行。
  - **`DeathSystem` 中和意图**（`moveVector=(0,0)` / 两脉冲 `false` / `aimRadians=null`）不是装饰：
    意图生产者跳过死物 ⇒ 再没人写尸体的意图 ⇒ 不清零就会把死时的值**永久冻结**在快照里。
  - **死亡总线是独立的 `EventQueue<EntityDeathEvent>`**（`createDefaultSystems(events?, deathEvents?)` 第二参）。
    `EntityDeathEvent` 只有 `{ tick, entityId }`，**不含策略**。**无强制消费者** ⇒ `DeathSystem` 每拍开头 `clear()`，
    于是 `step()` 后总线上装的**恰好是刚处理那一拍**的死亡，永不积压。
  - **房间 = 挂 `EncounterStateComponent` 的全局单例实体**（无 Transform / 无受击盒 / 无寿命）。
    三态 `IN_PROGRESS / WAVE_CLEAR / ROOM_CLEARED`。`EncounterSystem` **零字段**。
  - **`trackedEntityIds` 空列表 = 「本波尚未生成」**（因此一波必须至少声明一个敌人，否则房间永久卡死）。
    **`isWaveCleared` 对空列表返回 `false`**。
    **提升到下一波（`WAVE_CLEAR`）时清空名单；进入 `ROOM_CLEARED` 时保留最后一波名单**
    （留空等于对已打完的房间说谎）。
  - **`nextSpawnTick` 存绝对 Tick（`-1` = 未排期），不存倒计时**：倒计时在「上一波被清空那一拍」启动时必然差一拍。
    第 0 波在**首个被处理的 Tick** 惰性排期，生成于 `p₀ + delayTicks`；第 `k>0` 波生成于 `q + delayTicks`
    （`q` = 上一波被**检测清空**的拍）。**清空判定与死亡同拍**（`DeathSystem` 在 `EncounterSystem` 之前）
    ⇒ 「从最后一击到下一波生成恰好 `delayTicks` 拍」。
    **`delayTicks = 0` 有不对称**：第 0 波同拍、后续波下一拍（分支 2 先于 3 且 `continue`，生成永不与清空判定同拍）。
  - **`EncounterFactory.spawn` 不生成第一波**（生成是逐 Tick 的决定）⇒ 调用方**必须至少 `step()` 一次**房间才有敌人。
    校验（`resolveEncounterConfig`）在**加载期**做，且对每个敌人规格**dry-run 装配一遍**（一次性 `World`）——
    不抄 `spawnCombatant` 的规则，避免第二真相源。理由：`EncounterSystem` 在 `step()` 内部调 `EnemyFactory.spawn`，
    坏规格若在生成时才暴露会**打断模拟**。
  - **`EnemySpawnOptions` 声明在 `spawn-helpers.ts`**（`= CombatantSpawnOptions`），`EnemyFactory.ts` 再导出。
    理由：`components` 层要能描述一波敌人而**不反向依赖 `prefabs` 的工厂实现**。
    **坑**：`export type { X } from './y'` **不会**把 `X` 带进本地作用域，工厂内部使用还需 `import type`。
  - **`step()` 处理的拍数与相位**（M4-T02 实测）：在 Tick `T` 生成的波次，其成员**首次行动在 `T+1`**。
- **QA 纪律补充（M4-T02 实战验证，强烈建议沿用）**：
  - **变异测试是「门控类」改动的必做步骤**：把 `if (isDead(...))` 临时改成 `if (false && isDead(...))`，
    跑单文件测试，确认**有断言失败**，再还原。本项目 13 处变异全部被捕获（见 `tests/combat/death_and_encounter.test.ts`）。
  - **冗余门会掩盖测试空洞**：先看清「还有哪道门顺手拦住了它」，再设计能**独立**观测该门的场景。
    典型手法：用 `hitstopTicks = 0, knockbackForce > 0` 的判定圆造出「有在飞击退但没冻结」的尸体；
    或直接给尸体手工写 `wantsToAttack` / `wantsToDash` / 手工挂 poison 作为**对抗性探针**。
  - **`grep` vitest 摘要行必须加 `NO_COLOR=1`**，否则 ANSI 转义码会让 `^ *Tests +[0-9]` 匹配失败
    （且 `Failed Tests 1` 会假匹配 `Tests +[0-9]`）。
- **"输入是全局帧"的局限已被根治**（M2-T02）：意图层解耦后敌人**不持有**硬件组件，
  同一 Tick 的按键事件只作用于玩家。残留局限：玩家键位仍是全局的（`DASH_KEY`/`ATTACK_KEY` 不按实体绑定），
  多玩家/重映射需在 `PlayerInputComponent` 上加 `dashKey`/`attackKey`（属 M3）。
- 远端仓库：https://github.com/Jaxuu/my-hades（PUBLIC，默认分支 `main`）——**切勿提交密钥**。
