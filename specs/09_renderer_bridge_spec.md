# 09 · Renderer Bridge Spec（表现层基建与 PixiJS 逻辑桥接）

| Field | Value |
|---|---|
| Spec ID | `SPEC-09-RENDERER-BRIDGE` |
| Milestone | **M5 · 表现层**（T01） |
| Status | `accepted`（本文件为 M5-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `client/GameRenderer.ts`（新）、`client/GameLoop.ts`（新）、`client/KeyboardInput.ts`（新）、`client/main.ts`（新）、`vite.config.ts`（新）、`index.html`（新）、`tsconfig.client.json`（新）、`eslint.config.mjs`（新增 AC-01 单向依赖门）、`package.json`（新增 `pixi.js` 运行时依赖 + `vite` 开发依赖 + 4 条脚本） |
| Depends on | `specs/00_harness_spec.md`（`GameSimulator` / `FixedClock` / `InputQueue` / `World` 契约）、`specs/01_character_controller_spec.md`（`PlayerInputComponent` / `move` 持久语义）、`specs/02_dash_and_state_spec.md`（`DASH_KEY` 上升沿）、`specs/03_combat_hitbox_spec.md`（判定圆为独立实体 / `HurtboxComponent`）、`specs/04_combat_feedback_spec.md`（`ATTACK_KEY` 上升沿 / 意图解耦）、`specs/05_boon_modifier_spec.md`（`addModifier` 词缀）、`specs/07_enemy_ai_spec.md`（`EnemyFactory.spawn` 的 `ai` 选项）、`specs/08_encounter_and_death_spec.md`（尸体永不销毁 / `DeadTagComponent` / `isDead`）、`docs/architecture/ADR-001-headless-ecs-foundation.md`（R1–R6 确定性铁律） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vite 5 · PixiJS 8.21 · Vitest（node 环境，内核）· ESLint 9（flat config） |

---

## 1. 目的与范围

### 1.1 目的

M0–M4 交付了一个**完全无头、无墙钟、无随机**的确定性模拟内核（209 个 Vitest 用例，13 段固定管道）。
内核的正确性已由机器证明，但它**从未被任何人看到过**——没有任何一个模块把 `World` 里的
`TransformComponent` 变成屏幕上的一个像素。

M5-T01 落地**表现层的第一个切片**，只解决一个问题：**把只读的逻辑世界，以固定的、可复现的规则，
投影成一屏可被人眼观察的几何图形，并让键盘输入按拍回流进模拟。**

它同时是**项目第一次引入运行时依赖**（`pixi.js`）与**第一个表现层目录**（`client/`）。
因此本 Spec 的核心判据不是「画面好不好看」，而是**单向依赖与只读边界是否被结构性地守住**：

> 一句话总结本 Spec 的判据：**逻辑层对表现层一无所知；表现层对逻辑层只读；丢帧不改变模拟结果。**

### 1.2 In Scope（做什么）

- **新增表现层目录**：`client/`，含 `GameRenderer` / `GameLoop` / `KeyboardInput` / `main`。
- **新增运行时依赖**：`pixi.js@^8.21.0`（`dependencies`）；**新增开发依赖** `vite@^5`（`devDependencies`）。
- **新增工程配置**：`vite.config.ts`（静态 `index.html` 入口 + 固定 `server.port` + `strictPort: false`）、
  `index.html`（`#app` 容器 + `/client/main.ts` 模块入口 + 键位提示）、
  `tsconfig.client.json`（`lib` 含 DOM、`include` 仅 `client/**` 与 `vite.config.ts`、`noEmit`）。
- **新增脚本**：`dev` / `build` / `preview` / `typecheck:client`。
- **AC-01 强制门**：`eslint.config.mjs` 对 `src/**/*.ts` 新增 `no-restricted-imports`，
  禁止导入 `pixi.js` 与任何指向 `client/` 的路径。
- **数据绑定**：渲染层持有 `Map<EntityId, EntityView>`，每帧把逻辑 `TransformComponent` 同步到 Pixi `Container`。
- **生命周期同步**：新实体建视图；`DeadTagComponent` → 播死亡效果后回收；`destroyEntity` → 立即回收。
- **几何占位符**：玩家 / 敌人 / 判定圆 / 受击盒的最小可视表示。
- **输入回流**：`KeyboardInput` 维护按键集合，每拍 `flush(sim)` 注入 `move` / `keyDown` / `keyUp`。
- **帧循环**：`GameLoop` 用真实 `deltaMS` 累加、按 `sim.tickDurationMs` 追帧、`renderer.syncWorld`。

### 1.3 Out of Scope（显式排除）

- ❌ **精灵图 / 动画 / 美术资产 / 音效**：本切片只用几何占位符（圆 / 方块 / 线）。
- ❌ **渲染插值 / 帧同步平滑**：`ADR-002`（渲染层插值与帧同步策略）尚未决定，本切片**按拍硬同步**，
  不做逻辑帧间插值。已知代价见 §10 取舍 2。
- ❌ **摄像机 / 缩放 / 世界坐标裁剪 / 视口跟随**：世界原点即屏幕原点，`PX_PER_UNIT` 为唯一缩放。
- ❌ **UI 框架 / HUD 组件化 / 菜单 / 暂停界面**：HUD 只是一个直接写 `textContent` 的最小元素。
- ❌ **对象池 / 视锥剔除 / 批渲染调优**：占位符规模（≤ 数十实体）不需要。
- ❌ **对 `src/` 的任何改动**：本切片对 `src/` 的改动期望为**零**（§1.4 C1）。
- ❌ **测试执行**：表现层的人工/自动化测试归 QA（严守真）；本切片只保证**可测试的接口形状**。
- ❌ **生产部署 / 构建产物优化 / CDN**：`vite build` 只作为「能构建」的存在性证明。

### 1.4 约束

- C1 **单向依赖（AC-01，硬）**：`client/` 可以单向 import `src/` 的类型与组件；
  `src/` **绝对禁止** import `client/`、`pixi.js` 或任何 DOM/BOM 相关代码。由 ESLint 强制（§3.1）。
- C2 **`src/` 零运行时依赖（硬）**：`pixi.js` / `vite` 只允许出现在 `client/` 与根工程配置；
  `src/` 的 `package.json` 运行时依赖集合**保持为空**。
- C3 **渲染层只读（硬）**：渲染层**不得**写回逻辑状态——禁止 `addComponent` / `removeComponent` /
  `destroyEntity` / `applyDamage` / 任何对组件字段的赋值。它只调用 `world.query` /
  `world.getComponent` / `world.isAlive` 等只读 API。
- C4 **渲染层不参与时序契约（硬）**：丢帧、卡顿、后台标签页**不得**改变模拟结果。
  `GameLoop` 的追帧上限只丢弃**渲染帧预算**，不丢弃已完成的逻辑拍。
- C5 **类型安全**：`client/**` 满足 `strict`；禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C6 **时间只来自 `sim`**：`GameLoop` 必须使用 `sim.tickDurationMs`，**禁止**硬编码 `16.67` 或 `1/60`
  （沿用 ADR-001 R3）。
- C7 **不改内核契约**：`FixedClock` / `GameSimulator` / `SystemContext` / `World` / 13 段管道的既有契约
  **不得改动**；本切片对 `src/` 零改动。
- C8 **`PX_PER_UNIT` 是渲染层唯一持有的常量契约**：逻辑层不知道像素；`10` 这个数字只存在于 `client/`。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **表现层（Render Layer）** | `client/` 目录。逻辑世界的**只读消费者**，把组件数据投影为像素。 |
| **逻辑世界（World）** | `src/ecs/World.ts` 的 `World`。实体 / 组件的权威数据源，本切片**只读**它。 |
| **实体视图（`EntityView`）** | 渲染层为某个 `EntityId` 持有的表现对象，含 `container` / `kind` / `isDying` / `deathElapsedMs`。 |
| **绑定表（Binding Table）** | `GameRenderer` 内部的 `Map<EntityId, EntityView>`，实体 id → 视图的唯一映射。 |
| **`PX_PER_UNIT`** | 世界单位 → 像素的固定缩放比，**`= 10`**。渲染层唯一持有的常量契约。 |
| **视图分类（Kind）** | 由组件存在性决定的视图种类：`hitbox` / `player` / `enemy`（见 §4.3）。 |
| **死亡效果（Death FX）** | 带 `DeadTagComponent` 的实体视图在 `DEATH_FADE_MS` 内淡出 + 缩放，随后被回收。 |
| **回收（Recycle）** | 从绑定表移除视图并 `container.destroy()`。逻辑实体本身**永不**被渲染层销毁。 |
| **追帧（Catch-up）** | `GameLoop` 用累加器把真实时间换算成整数逻辑拍并逐拍 `step(1)`。 |
| **螺旋死亡（Spiral of Death）** | 一次大 `deltaMS`（如后台标签页回前台）触发过多 `step`，导致本帧更长、下一帧更多，无限恶化。 |
| **拍（Tick）** | 逻辑层的固定时间单位；`sim.step(1)` 恰好推进一拍。 |

---

## 3. 契约

### 3.1 AC-01 · 单向依赖（由 ESLint 强制执行）

依赖方向**只能是** `client/ → src/`：

```ts
// ✅ client/ 允许：单向 import 内核的类型与组件
import type { World } from '../src/ecs/World';
import { TransformComponent } from '../src/ecs/components/TransformComponent';
import { PlayerFactory } from '../src/ecs/prefabs/PlayerFactory';

// ❌ src/ 绝对禁止（ESLint no-restricted-imports 会 fail）
import { Application } from 'pixi.js';
import { GameRenderer } from '../client/GameRenderer';
```

执行手段（`eslint.config.mjs`，仅作用于 `src/**/*.ts`）：

```js
'no-restricted-imports': ['error', {
  paths: [{ name: 'pixi.js', message: '... (ADR-001 R1, spec 09 AC-01)' }],
  patterns: [{
    group: ['pixi.js/*', '**/client', '**/client/**',
            '../client', '../client/**', '../../client', '../../client/**',
            '../../../client', '../../../client/**'],
    message: '... (ADR-001 R1, spec 09 AC-01)',
  }],
}],
```

**可检验判据**：在 `src/` 下任写一个 `import ... from 'pixi.js'` 或 `from '../client/...'`，
`npx eslint <该文件>` 必须报 `no-restricted-imports`（error）；删除探针后 `npm run lint` 必须全绿。

### 3.2 AC-02 · 数据绑定表

渲染层持有 `Map<EntityId, EntityView>`；**每帧渲染前**遍历逻辑实体，凡有 `TransformComponent` 者，
把 `Container` 的 `x / y / rotation` 同步为：

| Container 字段 | 逻辑来源 | 公式 |
|---|---|---|
| `container.x` | `TransformComponent.x` | `x * PX_PER_UNIT` |
| `container.y` | `TransformComponent.y` | `y * PX_PER_UNIT` |
| `container.rotation` | `TransformComponent.facingRadians` | `facingRadians`（**不翻转符号**） |

- **`PX_PER_UNIT = 10` 是渲染层唯一持有的常量契约**。逻辑层**不知道**像素的存在；
  `src/` 里没有任何 `PX_PER_UNIT`、没有任何 `* 10`。
- **`facingRadians` 是 atan2 约定**（`+x` = `0`，`+y` = `+PI/2`）。世界 y 直接映射屏幕 y（向下），
  因此 Pixi 的 `container.rotation = facingRadians` **可直接用，不翻转符号**。

### 3.3 AC-03 · 生命周期同步

`syncWorld(world)` 每帧四步：

1. **建视图**：逻辑实体有 `TransformComponent` 但绑定表缺失 → 按 §4.3 分类并创建 `Container` + 图形。
2. **同步 Transform**：按 §3.2 同步 `x / y / rotation`。
3. **推进死亡效果**：带 `DeadTagComponent` 的视图进入 `isDying`，按真实帧时间累加 `deathElapsedMs`，
   在 `DEATH_FADE_MS` 内完成淡出 + 缩放，**结束后回收并退役该 id**（见 §4.4）。
4. **清理已销毁实体**：绑定表中存在、但 `world.isAlive(id) === false` 的视图**立即回收**（**不退役**）。

**必须同时处理「带死亡标签」与「从 query 消失」两种情况**，理由是二者是**两个独立事实**（spec 08 §3.1 / §4.4）：

- **尸体永不销毁**（M4-T02 铁律）：战斗单位死亡后仍 `world.isAlive`，只是挂了 `DeadTagComponent`。
  它**不会**从 `world.query` 里消失，所以**不能**靠「实体从 query 消失」来判断「该播死亡效果了」——
  必须显式读 `DeadTagComponent`。
- **判定圆会被销毁**：`LifespanSystem` 会把过期判定圆 `destroyEntity`，此时它从 `query` 与 `isAlive` 里
  一起消失。这类实体**没有**死亡效果，必须靠「不在 `isAlive`」直接回收。

把两者折叠成一个信号，必然二选一地错：要么尸体永远不播死亡效果（等它消失，而它永不消失），
要么判定圆被销毁时误播一次死亡效果。

### 3.4 AC-04 · 几何占位符

| 实体 | 判定依据（视图分类，见 §4.3） | 视觉 |
|---|---|---|
| **玩家** | `FactionComponent.faction === Faction.Player` | 蓝色实心圆（半径 = `PLAYER_RADIUS * PX_PER_UNIT`）+ **朝向指示线**（自圆心指向 `facingRadians`，长度 ≥ 半径） |
| **敌人** | `FactionComponent.faction === Faction.Enemy` | 红色**方块**：`rect`，边长 = `hurtboxRadius * 2 * PX_PER_UNIT` |
| **判定圆（Hitbox）** | 有 `HitboxComponent`（**优先于阵营判断**） | 半透明圆，半径 = `hitbox.radius * PX_PER_UNIT`；玩家阵营黄、敌方红 |
| **受击盒（Hurtbox）** | 可选 | 细描边圆，半径 = `hurtbox.radius * PX_PER_UNIT` |

- **判定圆是独立实体**（自带 `TransformComponent`），不是挂在攻击者身上的子节点——
  因此它天然由步骤 1 的「遍历逻辑实体」创建，与攻击者视图互相独立。
- **Hitbox 判定优先于阵营**：视图分类**先看 `HitboxComponent`**，命中即为判定圆；
  否则再看 `FactionComponent` 决定玩家/敌人。因为判定圆可能同时（在未来的某天）持有阵营，
  而它的视觉契约由「它是判定圆」唯一决定。

### 3.5 硬约束 A · 渲染层只读

渲染层**只调用**只读 API：`world.query` / `world.getComponent` / `world.hasComponent` /
`world.isAlive` / `sim.tick` / `sim.tickDurationMs` / `sim.world`。

**禁止**：`world.addComponent` / `world.removeComponent` / `world.destroyEntity` /
`world.createEntity` / `applyDamage` / `markDead` / `addTag` / `addModifier` /
对任何组件字段的赋值 / `sim.step` 之外的任何模拟推进（`sim.step` 只允许出现在 `GameLoop`，
且只为把**输入**推进一拍）。

> 唯一允许「写」的通道是 `sim.inject(...)`：它是**输入**，不是状态。逻辑状态只能由 `sim.step()` 演化。

**可检验判据**：`GameRenderer` 的源码中不出现 `addComponent` / `destroyEntity` / `applyDamage`
等写入符号；`syncWorld` 的签名只接受 `World`（只读消费），不返回任何东西。

### 3.6 硬约束 B · 渲染层不参与时序契约

- **丢帧 / 卡顿不影响模拟结果**：`GameLoop` 的追帧上限（`MAX_STEPS_PER_FRAME`）只限制**本帧**消耗的
  逻辑拍数；被丢弃的只是**累加器余量**（渲染帧预算），**不是**已发生的逻辑状态。
- **顿帧是纯逻辑概念**：hitstop / 冻结由 `FreezeSystem` 在逻辑层实现，渲染层**照常每帧同步**——
  被冻结的实体的 `TransformComponent` 本拍没变，渲染层自然画在同一个位置，不需要（也不允许）
  在渲染层再实现一次「顿帧」。
- **后台标签页**：长时间不渲染后再回前台，`deltaMS` 会很大。上限机制把这一帧的逻辑拍数封顶，
  溢出丢弃，**避免螺旋死亡**。代价：这一帧的模拟**慢于**真实时间（游戏「掉速」而非「追赶爆炸」）。

**可检验判据**：`GameLoop` 用 `sim.tickDurationMs`（不出现 `16.67` / `1/60` 字面量）；
单帧 `step` 次数 ≤ `MAX_STEPS_PER_FRAME`。

---

## 4. 语义契约

### 4.1 每帧顺序（`GameLoop`）

```
app.ticker.add((ticker) => {
  accumulator += ticker.deltaMS;              // 真实帧时间（唯一墙钟来源，仅用于喂拍数）
  let steps = 0;
  while (accumulator >= sim.tickDurationMs && steps < MAX_STEPS_PER_FRAME) {
    input.flush(sim);                          // 先注入：inject 对 tick < sim.tick 抛 RangeError
    sim.step(1);                               // 再推进：step(1) 处理的正是 sim.tick 这一拍
    accumulator -= sim.tickDurationMs;
    steps += 1;
  }
  if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;  // 溢出丢弃，防螺旋死亡
  renderer.syncWorld(sim.world);               // 每渲染帧同步一次
});
```

**顺序铁律（源自 `GameSimulator.inject` 的实现）**：`inject` 对 `tick < sim.tick` 抛 `RangeError`，
而 `step(1)` 处理的正是 `sim.tick` 这一拍。因此**必须先 `inject` 再 `step(1)`**；
若颠倒，注入的事件会落在「已经处理过的拍」上，被 `RangeError` 拒绝。

### 4.2 输入回流语义（`KeyboardInput`）

| 输入 | 语义 | 注入形态 |
|---|---|---|
| WASD | **持久** | 每拍注入一次当前向量：`{ kind:'move', tick: sim.tick, vector }`。`PlayerInputComponent.moveVector` **只在收到 `move` 事件时被覆盖**，故每拍注入当前向量最稳。 |
| J（攻击） | **上升沿单拍脉冲** | 维护 DOM 按键状态；仅在「未按 → 按下」时注入一次 `{ kind:'keyDown', tick, key: ATTACK_KEY }`；释放时注入 `keyUp`。 |
| K（冲刺） | **上升沿单拍脉冲** | 同攻击，键名常量 `DASH_KEY`。 |

- 键名常量 `DASH_KEY` / `ATTACK_KEY` 从 `src/ecs/components/PlayerInputComponent` 导入（单向依赖）。
- **上升沿只在 `flush` 的那一拍注入一次**：`PlayerControllerSystem` 从 `keysHeld` 的「释放前 ∧ 持有后」
  推导 `buttonDashJustPressed` / `buttonAttackJustPressed`，故 keyDown/keyUp 必须成对，
  且「按住不放」不得重复注入 keyDown。

### 4.3 视图分类（`kind`）

对每个有 `TransformComponent` 的实体，分类顺序（**不可交换**）：

1. `world.hasComponent(id, HitboxComponent)` → `kind = 'hitbox'`（判定圆优先）。
2. 否则 `world.getComponent(id, FactionComponent)?.faction`：
   - `Faction.Player` → `kind = 'player'`
   - `Faction.Enemy` → `kind = 'enemy'`
3. 否则（无 `FactionComponent`）→ 跳过（不创建视图）。

### 4.4 死亡效果与回收

- 触发条件：`world.isAlive(id) && world.hasComponent(id, DeadTagComponent)`（即 `isDead(world, id)`）。
- 效果：`isDying = true` 后，每帧按真实 `deltaMS` 累加 `deathElapsedMs`，
  以 `t = min(1, deathElapsedMs / DEATH_FADE_MS)` 线性插值 `alpha = 1 - t`、`scale = 1 - DEATH_SHRINK * t`。
- 回收：`deathElapsedMs >= DEATH_FADE_MS` → 从绑定表移除并 `container.destroy()`。
- **视图一旦进入 `isDying` 就只推进死亡效果**，不再同步 Transform（尸体位置已被 `MovementSystem` 冻结，
  同步与否都无变化，但跳过同步让「死亡后不再被世界驱动」在渲染层也可读）。
- **退役（Retire）——死亡效果的终止条件**：FX 播完的那一刻，该 id 必须被记入渲染层的
  `retired` 集合；此后 `createMissingViews` **不再为该 id 建视图**。

  **为什么必须退役**：尸体**永不销毁**（spec 08 §4.4 / §10 取舍 1），它仍 `world.isAlive`、
  仍持有 `TransformComponent`。若只 `recycle` 而不退役，下一帧 `createMissingViews` 会**立刻重建**视图，
  `syncTransforms` 再次看到 `isDead` ⇒ 重新 `isDying = true`、`deathElapsedMs = 0`，
  于是死亡效果**以 `DEATH_FADE_MS` 为周期无限重播**（方块每 400ms 闪回一次），
  直接违反本任务的验收标准「打死方块后方块消失」。

  **`retired` 用 `Set<EntityId>` 是安全的**：`EntityId` 由 `World.createEntity`（`World.nextId`）
  **单调递增分配、永不复用**，所以一个已退役的 id 不可能再合法地需要一个视图。
  这条依赖必须写在代码注释里——若未来 id 被复用，退役集合会永久隐藏一个合法实体，是更糟的失败模式。

  **只在死亡效果播完这条路径上退役**。`recycleDestroyed`（实体被 `destroyEntity`，如判定圆寿命耗尽）
  **不退役**：那条路径是自纠正的（已销毁实体不会再出现在 `query` 里），退役它只会平白引入
  「id 复用即永久隐藏」的风险，却没有换来任何正确性。

- `destroy()` 同步清空 `views` 与 `retired`。

### 4.5 已销毁实体的立即回收

`world.isAlive(id) === false` → 立即 `destroy()` 并移除，**不播**死亡效果。
这是判定圆（`LifespanSystem` 销毁）与任何未来对象池回收的路径。

---

## 5. 系统与管道

### 5.1 渲染层「管道」（顺序即语义）

表现层没有 ECS 系统，但有等价的固定阶段。`GameLoop` 每帧执行：

```
Ticker(deltaMS) → accumulator += deltaMS
  → [追帧循环] KeyboardInput.flush(sim) → GameSimulator.step(1)（≤ MAX_STEPS_PER_FRAME 次）
  → GameRenderer.syncWorld(world)
       ├─ ① 为缺失实体建视图（分类见 §4.3）
       ├─ ② 同步 Transform（§3.2，PX_PER_UNIT = 10）
       ├─ ③ 推进死亡效果并在结束后回收（§4.4）
       └─ ④ 清理已销毁实体（§4.5）
  → PixiJS 渲染（app.ticker 自动 render）
```

### 5.2 与内核管道的关系

渲染层**不插入**、**不修改**、**不感知**内核的 13 段管道（`src/ecs/systems/pipeline.ts`）。
它只观察管道的**输出**（`World` 的当前状态）。内核每 `step(1)` 完整跑一遍 13 段，
渲染层在**所有**逻辑拍跑完后同步一次——这是「渲染不参与时序契约」（§3.6）的结构保证。

### 5.3 依赖注入

`GameLoop` 通过构造注入 `sim` / `renderer` / `input`，三者互不 import：
`GameLoop` 依赖 `GameSimulator`（内核）、`GameRenderer`（同目录）、`KeyboardInput`（同目录）。
`main.ts` 是唯一的组装点（composition root）。

---

## 6. 时序硬契约

> **拍编号铁律**（沿用 spec 08 §6）：`sim.step(n)` 处理的是 processed-tick `0 .. n-1`，
> 之后 `sim.tick === n`。渲染层的一切时序都以 `sim.tick` 为准。

### 6.1 一帧的标准时序（60Hz 显示器，`tickDurationMs = 1000/60 ≈ 16.667`）

| 阶段 | 输入 | 输出 |
|---|---|---|
| `deltaMS` 累加 | 真实帧间隔（如 `16.7`） | `accumulator = 16.7` |
| 追帧循环第 1 次 | `accumulator(16.7) >= tickDurationMs(16.667)` | `flush` + `step(1)`；`accumulator ≈ 0.033` |
| 追帧循环第 2 次 | `accumulator(0.033) < 16.667` | 退出循环 |
| 同步 | `sim.world` | 视图位置按 `PX_PER_UNIT` 更新 |

### 6.2 追帧上限（防螺旋死亡）

| 场景 | `deltaMS` | 无上限 | 有上限（`MAX_STEPS_PER_FRAME = 5`） |
|---|---|---|---|
| 正常帧 | ~16.7 | 1 拍 | 1 拍 |
| 一次卡顿 | ~100 | 6 拍 | 5 拍 + 累加器清零 |
| 后台回前台 | ~3000 | ~180 拍（螺旋） | 5 拍 + 累加器清零 |

**契约**：无论 `deltaMS` 多大，单帧 `step` 次数 **≤ `MAX_STEPS_PER_FRAME`**；溢出时累加器**清零**，
使下一帧从干净状态开始（游戏「掉速」而非「追赶爆炸」）。

### 6.3 输入与拍的相位（AC-02 的注入侧）

对每一拍 `p`（`sim.tick === p` 时）：
1. `flush(sim)` 注入 `move`（当前向量）+ 本拍上升沿的 `keyDown` / `keyUp`（`tick = p`）。
2. `step(1)` 处理 tick `p`，`PlayerControllerSystem` 读到本拍输入。
3. `sim.tick === p + 1`。

**陷阱**：`inject` 对 `tick < sim.tick` 抛 `RangeError`——注入必须用 `sim.tick`（当前拍），
且必须在 `step(1)` **之前**。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 陈述 | 判据 |
|---|---|---|
| **AC-01** | **单向依赖**：渲染层可 import `src/` 的类型与组件；`src/` 绝不 import 渲染层或 `pixi.js`。 | `eslint.config.mjs` 对 `src/**/*.ts` 的 `no-restricted-imports` 命中 `pixi.js` 与 `client/` 路径（§3.1 探针测试）；`client/**` 全绿且能 import `../src/...`。 |
| **AC-02** | **数据绑定表**：渲染层持有 `Map<EntityId, Container>`；每帧把有 `TransformComponent` 者的 `x/y/rotation` 同步为 `x*PX_PER_UNIT` / `y*PX_PER_UNIT` / `facingRadians`。 | `GameRenderer` 存在 `Map<EntityId, EntityView>`；`PX_PER_UNIT = 10` 定义在 `client/`；`src/` 中无 `PX_PER_UNIT` / 无 `* 10` 缩放；同步不翻转 `rotation` 符号。 |
| **AC-03** | **生命周期同步**：新实体建视图；带 `DeadTagComponent` 播死亡效果后移除**并退役**（不再重建）；`destroyEntity` 立即移除。 | `syncWorld` 四步齐全；`isDead` 分支与 `!isAlive` 分支**同时存在且独立**（§3.3）；死亡效果在 `DEATH_FADE_MS` 内完成并回收；**FX 播完后该 id 不再被 `createMissingViews` 重建**（`viewCount` 稳定收敛，无周期振荡）。 |
| **AC-04** | **几何占位符**：玩家蓝圆 + 朝向线；敌人红方块（边长 = `hurtboxRadius*2*PX_PER_UNIT`）；判定圆半透明圆（玩家阵营黄 / 敌方红，半径 = `radius*PX_PER_UNIT`）；受击盒可选细描边。 | `client/` 内存在对应 `Graphics.circle` / `Graphics.rect` 调用与阵营配色分支；判定圆分类优先于阵营分类（§4.3）。 |
| **AC-05** | **渲染层只读**：不写回逻辑状态。 | `GameRenderer` 源码不含 `addComponent` / `destroyEntity` / `applyDamage` / `markDead` / `addTag` / `addModifier` / 组件字段赋值；`syncWorld(world)` 返回 `void`（§3.5）。 |
| **AC-06** | **渲染层不参与时序契约**：丢帧 / 卡顿不影响模拟；顿帧是纯逻辑概念。 | `GameLoop` 使用 `sim.tickDurationMs`（无 `16.67` / `1/60` 字面量）；单帧 `step` ≤ `MAX_STEPS_PER_FRAME`；溢出清累加器（§6.2）。 |
| **AC-07** | **`src/` 零回归**：既有 209 用例 / lint / typecheck 100% 通过。 | `npm run test` = 209 passed；`npm run lint` 全绿；`npm run typecheck` 全绿。 |
| **AC-08** | **工程可构建**：`vite build` 成功产出 `dist/`；`typecheck:client` 全绿。 | `npm run build` 退出码 0 且生成 `dist/`；`npm run typecheck:client` 全绿。 |

---

## 8. 失败模式（Failure Modes）

| 失败模式 | 症状 | 本 Spec 的防线 |
|---|---|---|
| **反向依赖** | 某个 `src/` 模块 `import` 了 `pixi.js` 或 `client/`，内核被拖入浏览器环境 | ESLint `no-restricted-imports`（§3.1） |
| **渲染层写回状态** | 渲染回调顺手改了 `transform.x`，模拟静默分叉 | 只读 API 白名单（§3.5）；`syncWorld` 返回 `void` |
| **尸体不播死亡效果** | 靠「实体从 query 消失」判断死亡，而尸体永不销毁 ⇒ 死亡效果永不触发 | 显式读 `DeadTagComponent`（§3.3 / §4.4） |
| **死亡效果无限重播** | FX 播完只回收不退役，下一帧为仍在世的尸体重建视图 ⇒ 方块周期性闪回 | 死亡 FX 路径**退役**该 id，`createMissingViews` 跳过退役 id（§4.4） |
| **误退役合法实体** | 在 `recycleDestroyed` 路径也退役，未来 id 复用时永久隐藏一个活实体 | 只在死亡 FX 路径退役；`retired` 依赖「id 永不复用」不变式（§4.4） |
| **判定圆误播死亡效果** | 把「不在 `isAlive`」折叠成「已死」，判定圆被销毁时播一次死亡效果 | 两个分支独立（§3.3 / §4.5） |
| **螺旋死亡** | 后台回前台后单帧 `step` 上百次，越追越慢 | `MAX_STEPS_PER_FRAME` + 溢出清累加器（§6.2） |
| **注入被拒 / 落错拍** | 先 `step` 后 `inject`，事件落在已处理的拍上 ⇒ `RangeError` | 「先 inject 再 step(1)」顺序铁律（§4.1） |
| **输入重复触发** | 按住 J/K 不放，每拍都注入 `keyDown` ⇒ 连发冲刺/攻击 | 只在上升沿注入一次（§4.2） |
| **朝向镜像** | 翻转 `facingRadians` 符号，朝向线指向反方向 | `rotation = facingRadians`，不翻转（§3.2） |
| **缩放不一致** | 逻辑用像素、渲染再乘一次，位置整体偏大 | `PX_PER_UNIT` 只在渲染层；`src/` 无像素概念（C8） |
| **帧时间硬编码** | `GameLoop` 写死 `16.67`，换 fps 后追帧错乱 | 只用 `sim.tickDurationMs`（C6 / AC-06） |
| **DOM 类型泄漏进内核** | 根 `tsconfig.json` 的 `lib` 被塞进 DOM，内核可误用浏览器 API | 根 `include` 保持不动；DOM 只在 `tsconfig.client.json`（§1.4 C1） |

---

## 9. 追溯（Traceability）

| 来源 | 本 Spec 的落地 |
|---|---|
| ADR-001 R1（`src/` 禁止 DOM / 图形库） | AC-01 + ESLint `no-restricted-imports`（§3.1） |
| ADR-001 R2（时间只由 `step` 推进） | `GameLoop` 不读墙钟决定模拟，只用 `deltaMS` 喂**拍数**（§4.1 / §3.6） |
| ADR-001 R3（禁止硬编码 `1/60` / `16.67ms`） | C6 + AC-06（只用 `sim.tickDurationMs`） |
| ADR-001 R4（状态对外只读） | 硬约束 A（§3.5） |
| ADR-001 §8「候选 ADR-002 渲染层插值与帧同步策略」 | §1.3 Out of Scope（本切片按拍硬同步，不做插值） |
| spec 00（`GameSimulator` / `FixedClock` / `InputQueue`） | `GameLoop` 的追帧循环 + `KeyboardInput.flush`（§4.1 / §4.2） |
| spec 01（`move` 持久语义） | 每拍注入当前 WASD 向量（§4.2） |
| spec 02 / 03（`DASH_KEY` 上升沿） | `KeyboardInput` 上升沿注入（§4.2） |
| spec 04（`ATTACK_KEY` 上升沿 / 意图解耦） | 同上 |
| spec 03（判定圆为独立实体） | 视图分类优先 `HitboxComponent`（§4.3） |
| spec 08（尸体永不销毁 / `DeadTagComponent`） | AC-03 的两个独立回收分支（§3.3 / §4.4 / §4.5） |
| 任务派发 M5-T01 Task D1–D4 | D1 §1.2；D2 §3.1；D3 本文件；D4 §4 / §5 |

---

## 10. 已知取舍（Known Trade-offs）

1. **几何占位符而非精灵图**。代价：画面不可用于验收美术。收益：本切片只证明**桥接**成立，
   美术接入是纯增量（换 `Graphics` 为 `Sprite`，不动绑定表与生命周期逻辑）。

2. **按拍硬同步，不做插值**。代价：60Hz 显示器上可能肉眼可见的轻微抖动（渲染帧与逻辑拍不对齐）。
   收益：渲染层与逻辑层零相位耦合，`ADR-002` 未决前不引入未经验证的插值复杂度。
   插值是 `ADR-002` 的明确主题，本切片刻意留白。

3. **`PX_PER_UNIT` 硬编码为 `10`**。代价：无法运行时缩放（无摄像机）。收益：一个常量足以让
   「逻辑单位 → 像素」的转换**只存在于一个地方**，且 `src/` 保持对像素无知（C8）。

4. **渲染层不持有游戏状态**。代价：每次同步都要重新 `query`。收益：绑定表是**纯缓存**，
   可以被随时清空重建而不影响逻辑；不存在「渲染层有一份影子状态」的分叉风险。

5. **`MAX_STEPS_PER_FRAME = 5`**。代价：极端卡顿时游戏「掉速」（模拟慢于真实时间）。
   收益：杜绝螺旋死亡——一个卡顿的机器不会把一次卡顿放大成永久卡顿。

6. **`vite` 固定在 5.x**。代价：不使用 Vite 6/7 的新特性。收益：与既有 `@eslint/js` / `typescript` /
   `vitest` 版本组合保持稳定，且任务明确要求不升级既有依赖。

7. **渲染层无自动化测试**。代价：`client/` 的正确性目前只由 `typecheck:client` + `vite build` 保证。
   收益：表现层的验证方式（人工看画面）与内核（机器断言）本就不同；把 jsdom 拖进来会污染
   内核的 node-only 测试环境（`vitest.config.ts`）。表现层测试的引入需要单独的 `ADR`。

---

## 11. 修订记录（Revision History）

| 版本 | 里程碑 | 变更 | 状态 |
|---|---|---|---|
| `v1.0` | M5-T01 | 初版：`client/` 表现层（`GameRenderer` / `GameLoop` / `KeyboardInput` / `main`）、`PX_PER_UNIT = 10` 绑定契约、死亡效果与双路回收、几何占位符、`no-restricted-imports` 单向依赖门、Vite 工程配置；AC-01 .. AC-08。 | `accepted` |
