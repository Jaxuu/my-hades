# my-hades · 长期约定（不变式）

> Headless 确定性动作肉鸽内核。Node≥22 · TS `strict` · Vitest(node,`pool:'threads'`) · 零运行时依赖（`client/` 例外 pixi.js 8）。
> 只留不变式与最易被违反的规则；原理见 `specs/*`（00–20），里程碑硬契约见 `memory/INVARIANTS.md`。

## 1 铁律
1. `src/` 禁 DOM/墙钟/随机；时间只由 `step()` 推进。`elapsedSeconds=totalTicks*fixedDeltaSeconds`（乘法），禁硬编码 1/60。
2. 同输入⇒逐 Tick 同状态。遍历一律 `World.query`（id 升序）；字符串排序用 UTF-16 码元序，禁 `localeCompare`/`toLocale*`/`Intl`。
3. Snapshot=深拷贝+递归 freeze。组件=POD（禁方法），操作用自由函数。系统=`{readonly name;update(world,ctx);reset?()}`，禁跨 Tick 隐藏状态，注册序==执行序。
4. 禁 `any`/`!`/`@ts-ignore`；类型导入用 `import type`；新文件必须在 `index.ts` barrel 导出。
5. 预制体 `spawn(world,…)=>EntityId`；装配集中 `spawn-helpers.ts::spawnCombatant`。
6. `PlayerInputComponent` 只挂玩家；`IntentComponent` 挂所有战斗单位。脉冲**先消费后门控**，拒绝也丢弃，绝不缓冲。
7. `ActionState` 通用动作机：新动作优先加枚举+`StateSystem` 给退出条件。`DASHING` 只能自 `IDLE`/`MOVING` 进入，门控在 `DashSystem`（排在 `StateSystem` 前）。
8. 数据驱动：业务数值一律来自 `assets/data/*.json`；工厂只装配与查表。加载在 Bootstrap **异步**完成，`step()` 内零 IO、零校验抛错（加载期大声抛 `SchemaError`）。

## 2 管道（硬契约 17 段，不得重排）
`TransformSnapshot→PlayerController→Freeze→AI→Hazard→Movement→Dash→State→CombatAction→Collision→StatusEffect→Modifier→Death→Encounter→Reward→Pickup→Lifespan`
`createDefaultSystems(hitEvents?,deathEvents?,dashEvents?)`。`TransformSnapshot` 恒 idx0；`Lifespan` 恒 LAST。新事件：`events.ts` 加接口→新建 `EventQueue<T>`（构造注入）→`createDefaultSystems` **尾部追加参数**。同实体位移/物理相位挂 `MovementSystem`(idx5) 尾部；只有「独立生命周期+独立事件源」才新增段。
**钉桩 9 处**（改管道必同步；`grep -rl "'TransformSnapshotSystem'" tests/`）：`tests/combat/{feedback,boons,status_effects,death_and_encounter,armor_and_dash,aoe_and_lifecycle,economy_and_victory}`+`tests/ai/enemy_fsm`+`tests/physics/walls_and_projectiles`。段数钉桩 `toHaveLength(N)`（**绝不**放宽）：`aoe_and_lifecycle`、`walls_and_projectiles`。

## 3 测试
- 浮点位移容差 `1e-9`，禁严格相等。真实 `GameSimulator`+系统，不许 mock；`step(1)` 钉时序；`step(n)` 处理 tick `0..n-1`。
- `ticksInState`：`StateSystem` **之后**写入的（Collision 的 `HITSTUN`）进入拍不计入⇒跨度+1；之前写入的（`DASHING`/`ATTACKING`）计入。
- 实体可能命中同拍末被 `LifespanSystem` 销毁⇒要坐标就在上一拍快照。
- ⚠️ 恒真断言陷阱：`字段===构造它的那个常量` 恒真⇒必须另配**字面量钉桩**或**行为断言**。
- ⚠️「不消费随机」必须观察生成器下一个值（`noDraw === new Random(SEED).nextUint32()`），不能写「结果是 `null`」。
- ⚠️ 按组件存在性枚举战斗单位时必须**显式排掉玩家**（玩家也有 `Transform`+`Health`）。
- 门控类改动必做**变异实验**（临时破坏→确认断言失败→**备份还原**，绝不用 `git checkout --`）；`grep` vitest 摘要加 `NO_COLOR=1`。`client/UIManager.ts` 无 node 单测⇒靠 `typecheck:client`+`vite build`。

## 4 工程风险
- ESLint AST 门（仅 `src/**`）：禁 window/document、`Math.random`/`Date.now`、`new Date()`/`localeCompare`/`toLocale*`/`new Intl`、`pixi.js`、`**/client/**`。`no-unused-vars` ignore 均 `^_`；`no-explicit-any` 全仓生效。
- ESLint 钉 9.x；`vite` 留 5.x（`vitest@2.1.8` peer）；vitest 必须 `pool:'threads'`。根 tsconfig 不 include `client/`⇒`tsconfig.client.json`+`typecheck:client`。
- 夹具陷阱：`createDefaultSystems()` **构造期**读 `zeus_strike`/`poseidon_dash`⇒mock bundle **不得清空词缀表**。尸体永不销毁⇒断言存活数必须过滤 `isDead`。
- npm 锁文件平台相关。远端 github.com/Jaxuu/my-hades（PUBLIC,`main`）——切勿提交密钥。

## 5 里程碑不变量（明细见 memory/INVARIANTS.md）

> **M0–M13** 的逐里程碑硬契约全在 **`.workbuddy-ai/memory/INVARIANTS.md`**，以避免本文件被注入时截断。改动任何里程碑相关代码前，先读那一份。
> 旧按天日志（`2026-09-28.md` / `2026-09-29.md`）已蒸馏进 `INVARIANTS.md` 后删除；`memory/YYYY-MM-DD.md` 只保留近期工作带（当前为 `2026-09-30.md`）。

## 6 编排
先冻结、再评审、后修复。派单带 Task ID/角色/优先级/上下文/Deliverables/Output Path/Handoff。高影响动作（commit/发布/删除）须人工审批；默认不 commit。

## 7 进度
M0–M4 ✅209 · M5-T01 ✅212 · M5-T02 ✅234 · M6-T01 ✅264 · M6-T02 ✅285 · M7-T01 ✅336 · M8-T01 ✅359 · M9-T01 ✅394 · M10-T01 ✅414 · M10-T02 ✅436 · M11-T01 ✅467 · M12-T01 ✅500 · M12-T02 ✅578（78 新用例 = 实现 21 + 独立 QA 57；已提交 `3960c2a`(docs) + `18b2d6c`(feat)，**未 push**）· **M13-T01 ✅613**（35 新用例；五道闸门全绿；管道仍 **17 段**；**未 commit**）。
权威规格 `specs/00`…`specs/21`。ADR-001(headless ECS) · ADR-002(渲染插值) · ADR-004(确定性 PRNG)。
