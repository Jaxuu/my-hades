# my-hades · 长期约定（不变式）

> Headless 确定性动作肉鸽内核。Node≥22 · TS `strict` · Vitest(node,`pool:'threads'`) · 零运行时依赖（`client/` 例外 pixi.js 8 + howler 2.2）。
> 只留不变式与最易被违反的规则；原理见 `specs/*`（00–22），里程碑硬契约见 `memory/INVARIANTS.md`。

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
- ⚠️ **「无损优化」必须用快照摘要自证**（`listEntities()×listComponents()` 拼串过 FNV-1a，同 seed 跑同一脚本，改前/改后必须**逐位相同**）。**既有测试全绿 ≠ 无损**——M15 实测：把字符串枚举 `Faction` 存进 `Int32Array`（被转成 `0`）让**全部 634 例通过**、摘要却变了（174→198 实体）。同时**性能断言要用「缩放比」而非绝对墙钟**（绝对值随 CI 负载漂 2 倍）。
- ⚠️ **渲染场景图 6 条冻结契约**：`stage` 唯一子节点=camera / `camera.children[last]`=root / `root.children[last]`=fxLayer / `root.children[0]`=首个实体视图 / 无墙时 `camera.children` 长**恰 1** / 空闲时 `fxLayer.children` 长**恰 0**。加**常驻**节点必撞坏其一⇒只能**惰性挂载**（先例 `staticLayer`）或**常驻+显式同步钉桩**（先例 spec 20 §6.3）；禁放宽语义或删断言。
- ⚠️「状态被设置」≠「效果被施加」：只断言状态字段等于构造它的常量，是恒真陷阱的变体，必须另配**效果断言**（M14 实测：关掉震动叠加时**无任何断言失败**）。

## 4 工程风险
- ESLint AST 门（仅 `src/**`）：禁 window/document、`Math.random`/`Date.now`、`new Date()`/`localeCompare`/`toLocale*`/`new Intl`、`pixi.js`、`**/client/**`。`no-unused-vars` ignore 均 `^_`；`no-explicit-any` 全仓生效。
- ESLint 钉 9.x；`vite` 留 5.x（`vitest@2.1.8` peer）；vitest 必须 `pool:'threads'`。根 tsconfig 不 include `client/`⇒`tsconfig.client.json`+`typecheck:client`。
- 夹具陷阱：`createDefaultSystems()` **构造期**读 `zeus_strike`/`poseidon_dash`⇒mock bundle **不得清空词缀表**。尸体永不销毁⇒断言存活数必须过滤 `isDead`。
- npm 锁文件平台相关。远端 github.com/Jaxuu/my-hades（PUBLIC,`main`）——切勿提交密钥。
- 资产：**唯一引用点 `client/assets/manifest.ts`**（`?url` 静态导入 ⇒ 删文件即 `vite build` 失败）；`build.assetsInlineLimit: 0`（否则 <4 KB 资产被内联、不进 `dist/`）；根 tsconfig `types` 含 `vite/client`；生成器 `assets/art/tools/build-atlas.py`（Pillow，构建期工具）。`assets/**` 合计 ≈595 KB（预算 6 MB）。
- 界面美术是 **48×48 九宫格白描框 ⇒ 必须 `border-image`（slice 12）**，`background-size:100% 100%` 会拉成满屏黑条。
- `client/` 侧：**`GameRenderer` 导入图不得含 `howler`**（node 渲染套件只导入 `GameRenderer`）。真因是裸 `window` ⇒ 无 DOM 的 `typecheck` 报 **TS2304**，**不是** howler 导入炸（该前提已实测推翻）；`AudioManager` 只被 `main.ts` 导入。事件旁观用 `TeeEventQueue extends EventQueue` 覆写 `emit`（`src/` 零改动、Liskov 兼容）；run 边界**必须** `bridge.clear()`（`scheduler.reset()` 触不到客户端缓冲）。

## 5 里程碑不变量（明细见 memory/INVARIANTS.md）

> **M0–M16** 的逐里程碑硬契约全在 **`.workbuddy-ai/memory/INVARIANTS.md`**，以避免本文件被注入时截断。改动任何里程碑相关代码前，先读那一份。
> 旧按天日志已蒸馏进 `INVARIANTS.md` 后删除；`memory/YYYY-MM-DD.md` 只保留近期工作带（当前为 `2026-10-02.md`）。

## 6 编排
先冻结、再评审、后修复。派单带 Task ID/角色/优先级/上下文/Deliverables/Output Path/Handoff。高影响动作（commit/发布/删除）须人工审批；默认不 commit。

## 7 进度
M0–M4 ✅209 · M5-T01 ✅212 · M5-T02 ✅234 · M6-T01 ✅264 · M6-T02 ✅285 · M7-T01 ✅336 · M8-T01 ✅359 · M9-T01 ✅394 · M10-T01 ✅414 · M10-T02 ✅436 · M11-T01 ✅467 · M12-T01 ✅500 · M12-T02 ✅578（78 新用例 = 实现 21 + 独立 QA 57；已提交 `3960c2a`(docs) + `18b2d6c`(feat)，**未 push**）· M13-T01 ✅613（35 新用例；五道闸门全绿；管道仍 **17 段**；已提交 `a189367`(docs) + `5ac7a3f`(feat)，**未 push**）· M14-T01 ✅634（21 新用例；四闸门 + `build` 全绿；`src/` 零改动、既有测试零改动、管道仍 **17 段**；已提交 `87b3486`(docs) + `698b4b2`(feat)，**未 push**）· **M15-T01 ✅642**（8 新用例；`src/` 三处**无损**提速，摘要逐位一致；⚠️「600 Tick < 100ms」未达成，实测 ~460ms，已登记 `specs/23` §7 T1；已提交 `02f99c1`）· **M16-T01 ✅803**（spec 024；**161 新用例** = 资产 59 + 渲染 56 + UI 30 + 音频 10 + 性能/无损 6；五道闸门全绿；`src/` **零改动**、`tests/render/` 既有 6 套件零改动、管道仍 **17 段**；性能比值 **1.01–1.09**（3 次全量运行；预算 1.2）；资产 ≈595 KB；真实 Chromium 视觉验收 V1–V9/O1–O4 全过；已提交 `ae4cc52`(docs) + `539d96a`(feat)，**已 push** `origin/main`（远端 `539d96a`））· **M17-T01 ✅893**（spec 025；**90 新用例**（8 文件）；五道闸门全绿；`src/` **零改动**、既有 803 例零改动、管道仍 **17 段**（钉桩 13）；**真浏览器像素实测** 5 种视口房间短边占比**恒 80.0%**、居中到像素、零裁剪；摘要 `f52dfdd4`（= M15/M16 同值）；性能比值中位数 **0.993**；变异实验**双证**；⚠️ 超 `client/` 的两处改动已登记（`vitest.config.ts` 限 worker 并发、`eslint.config.mjs` 忽略 `production/**/*.mjs`）；⚠️ SC-002/SC-009 **主观判定 PENDING**（需人类观察者）；已提交 `b1583a8`(chore/test 配置隔离) + `da17474`(feat M17)，**未 push**）。
权威规格 `specs/00`…`specs/25`。ADR-001(headless ECS) · ADR-002(渲染插值) · ADR-004(确定性 PRNG)。
