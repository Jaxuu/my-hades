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
| M4-T01 | 敌方状态机 AI 与攻击预警（`AIControllerComponent` / `AIState` / `AISystem` / `IntentComponent.aimRadians` / `resolveAITuning`）+ 确定性技术债（`localeCompare` → 码元序，ADR-001 R6） | ✅ PASS（13 文件 / **186 用例全绿**，未提交） |

- 规范管道（**硬契约，不得重排，11 段**）：
  `PlayerControllerSystem → FreezeSystem → AISystem → MovementSystem → DashSystem → StateSystem
   → CombatActionSystem → CollisionSystem → StatusEffectSystem → ModifierSystem → LifespanSystem`（`createDefaultSystems()`）。
  `PlayerControllerSystem`（硬件→意图）取代原 `MovementSystem.bindInput` 成为首段；
  `FreezeSystem` 紧随其后，必须在所有"逐实体推进"系统之前；
  `AISystem`（AI→意图，M4-T01）**必须在 `FreezeSystem` 之后、所有推进系统之前**——它要看到**递减后**的冻结判据，
  否则顿帧恢复拍会与运动系统错开一拍（相位契约，不是风格）；`StatusEffectSystem` **必须在 `CollisionSystem` 之后
  且 `ModifierSystem` 之前**（DoT 相位契约的唯一实现手段，见下）；`ModifierSystem` **必须在 `CollisionSystem` 之后
  （读本 Tick 事件）、`LifespanSystem` 之前（注入的判定圆需被判定过才销毁）**；`LifespanSystem` **必须最后**
  （否则判定圆少一个 Tick 有效窗口）。M1/M2 六段相对顺序**一字不改**。
- 权威规格：`specs/00_harness_spec.md`、`specs/01_character_controller_spec.md`、`specs/02_dash_and_state_spec.md`、
  `specs/03_combat_hitbox_spec.md`、`specs/04_combat_feedback_spec.md`、`specs/05_boon_modifier_spec.md`、
  `specs/06_status_effect_and_dot_spec.md`、`specs/07_enemy_ai_spec.md`。
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
- **"输入是全局帧"的局限已被根治**（M2-T02）：意图层解耦后敌人**不持有**硬件组件，
  同一 Tick 的按键事件只作用于玩家。残留局限：玩家键位仍是全局的（`DASH_KEY`/`ATTACK_KEY` 不按实体绑定），
  多玩家/重映射需在 `PlayerInputComponent` 上加 `dashKey`/`attackKey`（属 M3）。
- 远端仓库：https://github.com/Jaxuu/my-hades（PUBLIC，默认分支 `main`）——**切勿提交密钥**。
