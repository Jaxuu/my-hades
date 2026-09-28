# M2-T02 · QA 对抗验证与质量门报告

| Field | Value |
|---|---|
| Task | **M2-T02-Q01** 质量保障（独立对抗验证 + feedback 套件补齐 + QA 报告） |
| 阶段 | M2 · 基础战斗（T02）收尾门 |
| 验证者 | 严守真（quality-lead）· **独立验证者（fresh eyes，证伪视角）** |
| 验证对象 | `engineering-lead` 的 M2-T02 交付（意图解耦 + 顿帧 / 受击硬直 / 击退 + CI ESLint 门） |
| 验收基线 | `specs/04_combat_feedback_spec.md`（AC-01 … AC-08） |
| 工作区 | `D:/Project/Wkbd-project/my-hades` |
| 环境 | Windows 10 + Git Bash，Node v22，Vitest 2.1.9（node 环境 / `pool:'threads'`） |
| 日期 | 2026-09-28 |

> **评审原则**：不采信 engineering-lead 的自述断言，全部以**独立探针实测**重推时序，再从敌意视角攻击 spec 契约。
> **未修改 `src/` 产品代码**（唯一的 src 触碰是一次性变异门禁探针 + 两次可逆变异，均已复原并复核）；**未执行任何 git commit / push**。
>
> **修订记录（rev.2 · F1/F2 已关闭）**：engineering-lead 按 team-lead 裁定**修实现不改规格方向**，为 `DashSystem` 补齐 `IDLE`/`MOVING` 起手门控（F1/F2 同根因，一处修复），并新增 2 条 G6 回归用例。本人**独立复核**（自建探针 + 反向变异）确认 **F1/F2 已关闭**，三道门复跑 **116 用例全绿**。**质量门判定由 CONCERNS 更正为 PASS**。详见 §5、§7、§13。

---

## 0. 结论速览

| 项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 退出码 0（零错误） |
| `npm run lint` | ✅ 退出码 0（**0 error / 0 warning**） |
| `npm run test` | ✅ **10 文件 / 116 用例全通过**（改造前 96；**+20**） |
| 独立对抗验证（Mission A，9 项） | ✅ 8 项攻破失败（契约成立）；⚠️ **1 项攻破成功**（F1，**已修复并复核关闭**，见 §5） |
| 变异测试（门禁有效性） | ✅ 真实访问 → 5 error；**注释零误报**；复原后 lint 回到 0 |
| 新增测试可证伪性（反向变异） | ✅ 变异 `applyFreeze` → **8 条用例立即失败**；变异 `DashSystem` 门控 → **恰 F1/F2 两条失败**；均复原 |
| Flaky 探测（随机顺序 × 2） | ✅ 全绿，无 flaky |
| **质量门判定** | ✅ **PASS**（F1/F2 已关闭；AC-01…AC-08 全数通过；见 §5 / §7 / §13） |

**一句话**：M2-T02 的**三项派发明确要求（AC-01 顿帧 / AC-02 无缝恢复 / AC-03 硬直+击退）经独立逐 Tick 实测全部成立**，AC-04…AC-08 保障门亦全过；变异测试证明 ESLint AST 门精确且零误报（技术债已根治）。敌意验证曾攻破 1 处 spec 自相矛盾（F1：`DashSystem` 未门控 `HITSTUN`/`ATTACKING`，受击者可冲刺**逃出硬直**、攻击可被冲刺打断）；engineering-lead 已按裁定**修实现不改规格方向**（`DashSystem` 起手门控 `IDLE`/`MOVING`，脉冲无条件消费后丢弃），本人**独立复核确认 F1/F2 关闭**。最终判定 **PASS**。

---

## 1. 三道门原始证据

### 1.1 typecheck
```
$ npm run typecheck        # tsc --noEmit
（无输出）
EXIT=0
```

### 1.2 lint
```
$ npm run lint             # eslint .
（无输出）
EXIT=0
```

### 1.3 test（改造后）
```
$ npm run test
 ✓ tests/harness/ecs.test.ts                 (5 tests)
 ✓ tests/harness/input-timing.test.ts        (6 tests)
 ✓ tests/harness/independent-verify.test.ts  (19 tests)
 ✓ tests/combat/movement.test.ts             (12 tests)
 ✓ tests/combat/hit_detection.test.ts        (12 tests)
 ✓ tests/combat/dash.test.ts                 (20 tests)
 ✓ tests/combat/feedback.test.ts             (28 tests)   ← 改造前 10
 ✓ tests/harness/clock.test.ts               (6 tests)
 ✓ tests/harness/snapshot.test.ts            (4 tests)
 ✓ tests/harness/determinism.test.ts         (2 tests)
 Test Files  10 passed (10)
      Tests  114 passed (114)
EXIT=0
```

### 1.4 Flaky 探测（随机顺序）
```
$ npx vitest run --sequence.shuffle     # 两轮
Test Files  10 passed (10)   /   Tests  114 passed (114)     # run 1
Test Files  10 passed (10)   /   Tests  114 passed (114)     # run 2
```
→ 随机顺序下稳定全绿，**未观察到 flaky**（详见 §8）。

---

## 2. Mission A · 独立对抗验证（9 项）

方法：先用**一次性探针**（`tests/combat/__probe*.test.ts`，测后删除）以真实 `GameSimulator` 逐 Tick 打印原始状态，据此**独立重推** spec §6 的时序表，再逐项攻击。**未照抄 engineering-lead 的断言。**

### 2.1 实测逐 Tick 表（探针 A，玩家 (0,0) / 敌人 (1.5,0)，Tick 0 `keyDown('attack')`）

| Tick | 玩家 state/ticks | 玩家 x | 敌人 state/ticks | 敌人 x | 玩家 Frz | 敌人 Frz |
|---|---|---|---|---|---|---|
| 0 | ATTACKING/0 | 0 | HITSTUN/1 | 1.5 | 5 | 5 |
| 1 | ATTACKING/0 | 0 | HITSTUN/1 | 1.5 | 4 | 4 |
| 2 | ATTACKING/0 | 0 | HITSTUN/1 | 1.5 | 3 | 3 |
| 3 | ATTACKING/0 | 0 | HITSTUN/1 | 1.5 | 2 | 2 |
| 4 | ATTACKING/0 | 0 | HITSTUN/1 | 1.5 | **1** | **1** |
| 5 | ATTACKING/**1** | 0 | HITSTUN/**2** | **1.7** | 0 | 0 |
| … | … | 0 | HITSTUN | +0.2/Tick | 0 | 0 |
| 11 | ATTACKING/7 | 0 | HITSTUN/8 | 2.9 | 0 | 0 |
| **12** | ATTACKING/8 | 0 | **IDLE/0** | **3.100000000000001** | 0 | 0 |
| 16 | ATTACKING/12 | 0 | IDLE/4 | 3.100… | 0 | 0 |
| **17** | **IDLE/0** | 0 | IDLE/5 | 3.100… | 0 | 0 |

→ **与 spec 04 §6.3 表逐格一致**（含 `remainingTicks` 高配一格的内部读数、`ticksInState` 种入 1、Tick 12 退出硬直、末值 3.1）。

### 2.2 逐项攻击结果

| # | 攻击项 | 攻击方法 | 结果 | 关键实测证据 |
|---|---|---|---|---|
| 1 | 顿帧边界恰 4 Tick | 逐 Tick 读 `remainingTicks` / `isFrozen` | ✅ **未攻破** | Tick1..4 冻结；Tick4 末 `remainingTicks=1`⇒`isFrozen=true`；Tick5 末 `=0`⇒`false`；组件仍在（`remainingTicks===0`，快照形状稳定） |
| 2 | AC-02 无缝恢复 | 真实命中路径逐 Tick 读攻击者 `ticksInState` | ✅ **未攻破** | 攻击者 Tick0=0，Tick1..4 恒 0（不推进），Tick5=1（**从 0 继续，非重置**），Tick16=12，**Tick17 退出**（=12+4+1） |
| 3a | 击退总位移公式 | 逐 Tick 统计位移 Tick 数 | ✅ **未攻破** | 位移恰 **8** 个 Tick（Tick5..12），每 Tick `0.2`，总 `1.6`，末值 `x=3.1` |
| 3b | 与 maxSpeed 无关 | 两套 rig（`maxSpeed=0.5` / `1000`） | ✅ **未攻破** | 末值**逐位相同** `3.100000000000001`（`toBe`） |
| 3c | 不响应反向意图 | 每 Tick 写受击者 `intent.moveVector=(-1,0)` | ✅ **未攻破** | 末值与不注入 rig **逐位相同** |
| 3d | 方向 = 远离判定圆圆心 | 敌人置于 `(0.5,1.0)` | ✅ **未攻破** | 击退向量 `= normalize(-0.25,1)·12 ≈ (-2.9104, 11.6417)`；Δy>0、Δx<0；单 Tick 位移模长 `=12·dt` |
| 4 | 无敌帧命中零反馈 | 受击者挂 `Invulnerable` | ✅ **未攻破** | 不扣血、**不冻结（双方）**、不进 `HITSTUN`、不挂 `KnockbackComponent`、**不写 `hitEntities`**（可后续再命中） |
| 5 | 脉冲不被缓冲 | 冻结 Tick 注入冲刺/攻击脉冲 | ✅ **未攻破** | 冻结期 `FreezeSystem` 清零意图；解冻 Tick 不补触发；**解冻后全新按键仍正常生效**（抑制非永久） |
| 6 | `FreezeComponent` 语义 | 直接调用自由函数 | ✅ **未攻破** | 归零后组件**不移除**（`remainingTicks===0`）；`applyFreeze` 取 `max` **只延长不缩短**；`ticks<=0` 为 no-op（不创建组件） |
| 7 | 解耦回归守卫 | 注入全局 `keyDown('dash'/'attack')` + `move` | ✅ **未攻破** | 敌人**不持** `PlayerInputComponent`；全局输入帧**无法驱动敌人**（不冲刺 / 不攻击 / 不位移 / 不生成判定圆），而玩家正常响应 |
| 8 | 门禁有效性（变异） | 临时新增 src 探针文件 | ✅ **未攻破** | 真实访问 → **5 error**；仅注释 → **0 error**；测后删除、lint 回 0（详见 §6） |
| 9 | 复核 spec §6.2/§6.3 表 | 与实测逐格比对 | ✅ **一致** | 见 §2.1；**无任何不符**（唯一的 spec 内部矛盾在 §8，见 §5） |

**攻破成功项：1（#5 相关面外的 `HITSTUN` 逃逸）→ 见 §5 F1。**

> 补充实测（探针）：全局 `move` 事件**只**写入玩家的 `PlayerInputComponent`，对敌人零影响（探针 R：敌人 x 恒 1.5）；敌人 `IntentComponent` 必须由 AI/脚本直接写入——这正是解耦的预期行为，也说明"用全局 move 驱动敌人"的写法在本里程碑**已失效**。

---

## 3. Mission B · 新增用例清单（`tests/combat/feedback.test.ts`，10 → 28）

| 组 | 用例 | 一句话证明 |
|---|---|---|
| **G0**(+1) | `reports isFrozen true through tick T+N and false from T+N+1` | 顿帧边界精确：Tick1..4 冻结、Tick5 解冻，且组件归零不移除 |
| **G1**(+2) | `holds the attacker perfectly still while it keeps HOLDING the stick` | **【用户明确要求】**残余意图零漂移：硬件仍按住（`input.x===1`）但逻辑意图被清零（`intent.x===0`），坐标逐 Tick 位不变；解冻后恢复 |
| | `resumes the attacker on the REAL hit path and exits ATTACKING on tick 17` | AC-02 真实命中路径：攻击者 `ticksInState` 冻结期恒 0、Tick5 从 0 续计、Tick17 退出（12+4+1） |
| **G2**(+5) | `sweeps exactly DEFAULT_HITSTUN_TICKS displacement ticks…` | 击退全窗口：恰 8 个位移 Tick、总 1.6、末值 3.1、Tick12 退出硬直 |
| | `produces a BIT-IDENTICAL knockback displacement for enemy maxSpeed 0.5 vs 1000` | 击退与 `maxSpeed` 无关（**逐位相同**） |
| | `produces a BIT-IDENTICAL displacement whether or not the victim holds a reverse intent` | 击退不响应受击者移动意图（**逐位相同**） |
| | `knocks the victim AWAY from the hitbox centre on a non-axial hit` | 非轴向击退：方向 `≈(-0.2425,0.9701)`、Δy>0、Δx<0、模长 `=12·dt` |
| | `falls back to the hitbox facing when the centres coincide` | 退化方向回退 `facingRadians`（spec §4.4 边界） |
| **G5**(+1) | `neither damages, freezes, stuns nor knocks back an Invulnerable victim` | 无敌帧命中**零反馈**（不扣血/不冻/不硬直/不击退/不入账本） |
| **G6**(+2) | `clears an AI-driven dash pulse raised during the freeze…` | 冻结期脉冲被 `FreezeSystem` 清零（读后 `wantsToDash===false`），解冻不补触发；**新脉冲仍生效** |
| | `does not buffer a player key press made during the freeze…` | 玩家按键版：冻结中按键不缓冲；解冻后"释放+新按"仍能冲刺 |
| **G7**(+2) | `hitstopTicks = 0 lands the hit but freezes NEITHER side` | 配置边界：命中生效、双方均不冻结 |
| | `knockbackForce = 0 pins the victim in place…` | 配置边界：零位移致判定圆**持续重叠**，`hp` 只降一次、`hitEntities` 恰 1 条——**补回并强化去重覆盖** |
| **G8**(+1) | `mounts lazily, only ever extends…, no-ops for ticks <= 0` | `applyFreeze`/`isFrozen` 语义：惰性挂载、取 max、`<=0` no-op、归零保留 |
| **G9**(+2) | `clears the dash and attack pulses once a consumer reads them` | `wantsToDash`/`wantsToAttack` 为单 Tick 脉冲（消费后置 false） |
| | `keeps moveVector persistent across empty input frames` | `moveVector` 持久（空帧保持） |
| **G10**(+2) | `gives PlayerInputComponent to the player but not the enemy` | 硬件组件仅玩家持有 |
| | `cannot make the enemy dash, attack or move from the global input frame` | 全局输入帧无法驱动敌人（玩家正常响应作对照） |

**总计：新增 18 条（10 → 28）；全套件 96 → 114。**

### 3.1 `hit_detection.test.ts` 去重覆盖评估（未修改）

G1 第三用例（`a single hitbox deals damage at most once per target`）**仍能证明去重**：它在顿帧窗口（Tick1..4）断言"敌人仍重叠（`centreDistance < 1.5`）**且** `hp` 未二次下降"。由于 `CollisionSystem` 在 Tick1..4 仍对重叠目标逐一测试，若去重守卫失效则 `hp` 会再降 → 该断言即失败。故**无需改动**（最小改动原则）；且去重语义已被新增的 `knockbackForce = 0` 用例（重叠持续 14 Tick 仍只扣一次）**进一步强化**。结论：**覆盖保留，未削弱**。

---

## 4. AC-01 … AC-08 对照表

| AC | 验收项 | 断言位置（文件:行 / 用例） | 实测结果 | 结论 |
|---|---|---|---|---|
| **AC-01** | 顿帧（双方冻结 4 Tick、不响应意图） | `feedback.test.ts` G0 L150-212（3 用例）+ G5 L525 + G7 L601 | 攻守双方 Tick1..4 冻结；坐标位不变、状态机不推进、意图被清零 | **ADEQUATE** |
| **AC-02** | 顿帧后无缝恢复（不重置不跳过） | `feedback.test.ts` G1 L214-326（4 用例） | `ticksInState` 冻结期恒 0，解冻从 0 续计至 12，Tick17 退出 | **ADEQUATE** |
| **AC-03** | 受击硬直 + 反向强制位移（无视 maxSpeed / 意图） | `feedback.test.ts` G2 L328-490（9 用例） | HITSTUN 恰 8 Tick；总位移 1.6、末值 3.1；`maxSpeed`/反向意图**逐位无关**；非轴向与退化方向正确 | **ADEQUATE** |
| **AC-04** | 确定性回放 | `feedback.test.ts` G3 L491-521；`hit_detection` G3；`determinism.test.ts` | 两独立 Simulator 逐 Tick `toEqual` 一致 | **ADEQUATE** |
| **AC-05** | 纯逻辑门 ESLint 化（注释不误伤、0 error 0 warning） | `eslint.config.mjs` + `.github/workflows/ci.yml` L80-81 + §6 变异测试 | `npm run lint` 0 error；真实访问报 5 error；**注释零误报** | **ADEQUATE** |
| **AC-06** | 意图解耦不破坏既有契约 | `feedback.test.ts` G10 L741-765；`hit_detection.test.ts` G2（敌人改为意图驱动）；`movement/dash.test.ts` | 敌人无 `PlayerInputComponent`；全局输入帧无法驱动敌人；既有 96 用例重构后全绿 | **ADEQUATE** |
| **AC-07** | 管道顺序硬契约 | `feedback.test.ts` G4 L507-523；`pipeline.ts` | `createDefaultSystems()` 顺序逐字匹配 | **ADEQUATE** |
| **AC-08** | 类型安全（typecheck 零错、无 any/非空断言） | `npm run typecheck` + G8/G9（POD / 自由函数语义） | 退出码 0；组件仍为纯数据、变更经自由函数 | **ADEQUATE** |

> **无「规格写了但没测」的关键项。** 用例数自洽性已复核：spec 04 §7 AC-06 / §9 称"既有 **86** 用例"，即 M2-T02 引入 `feedback.test.ts`（10 条）之前的存量；86 + 10 = **96**（本次改造前基线），算术**完全吻合**，非文档滞后。

---

## 5. 发现的缺陷 / spec 不符

### F1（Major · spec 保真度）· 受击者可用冲刺**逃出** `HITSTUN`

- **现象**：实体处于 `HITSTUN`（非冻结 Tick）时，只要有一个冲刺脉冲（玩家按键或 AI 写意图），`DashSystem` 会把状态改为 `DASHING`，硬直**当场失效**。
- **复现步骤**（真实 pipeline，探针已实测）：
  ```
  sim = new GameSimulator({ fps: 60, systems: createDefaultSystems() });
  player = PlayerFactory.spawn(sim.world, { x: 1.5, y: 0, facingRadians: 0, maxSpeed: 5 });
  enemy  = EnemyFactory.spawn (sim.world, { x: 0,   y: 0, facingRadians: 0, maxSpeed: 5 });
  enemy.IntentComponent.wantsToAttack = true;      // AI/脚本驱动敌人攻击
  sim.step(1);                                     // Tick 0：玩家被命中 → HITSTUN + 冻结
  sim.step(4);                                     // Tick 1..4：冻结
  sim.inject({ kind:'keyDown', tick:5, key:'dash' });
  sim.step(1);                                     // Tick 5
  ```
- **期望 vs 实测**：
  - 期望：`player.state === HITSTUN`（spec 04 §8「受击者**不得**继续冲刺，硬直失效」为**失败模式**；spec 02 §4.1「`IDLE|MOVING` → `DASHING`」，冲刺不得自 `HITSTUN` 起手）。
  - 实测：`player.state === DASHING`（**硬直被冲刺打断**）。
- **根因**：`src/ecs/systems/DashSystem.ts:70-77` 的非 `DASHING` 分支只判 `wantsToDash && cooldownRemaining === 0`，**未门控 `HITSTUN`**。由于 `DashSystem` 排在 `StateSystem` **之前**，它在 `StateSystem` 见到 `HITSTUN` 之前就把它改写成 `DASHING` —— 故 spec §8 声称的缓解（"`StateSystem` 的 `HITSTUN` 分支置于 `DASHING`/`ATTACKING` 之前"）**不足以拦截冲刺路径**。
- **影响面**：受击硬直（AC-03 的"硬直"语义）可被单帧冲刺输入取消；玩家与 AI 敌人都可触发（本里程碑无 AI，故仅在脚本/AI 场景可达）。**AC-01/02/03 的数值断言不受影响**（它们不注入冲刺脉冲）。
- **建议修复方向**：在 `DashSystem` 起手处增加状态门控，仅允许自 `IDLE`/`MOVING` 进入冲刺（与 spec 02 §4.1 对齐），例如：
  ```
  if (state.state === ActionState.ATTACKING || state.state === ActionState.HITSTUN) {
    /* 消耗脉冲但不起手 */ intent.wantsToDash = false; continue;
  }
  ```
  或明确修订 spec：若"冲刺可取消硬直"是**有意**设计，须同步删除 spec 04 §8 的该条失败模式并更新 spec 02 §4.1 状态图。**二者择一，不可两存。**

### F2（Major · spec 保真度，**M2-T01 血缘**）· 冲刺可**打断攻击承诺** `ATTACKING`

- **现象**：玩家在 `ATTACKING` 期间按下冲刺 → `DashSystem` 无门控 → 状态转 `DASHING`，攻击承诺被打断（判定圆已生成，但攻击状态被取消）。
- **复现**：Tick0 `keyDown('attack')` → Tick5（解冻后）`keyDown('dash')` → 实测 `player.state === DASHING`（期望 `ATTACKING`）。
- **期望 vs 实测**：spec 02 §4.1（冲刺仅自 `IDLE|MOVING` 进入）+ spec 03 §1.3（**攻击取消 cancel 属 Out of Scope**）⇒ 期望仍 `ATTACKING`；实测 `DASHING`。
- **根因**：同 F1（`DashSystem.ts:70-77` 缺状态门控）。
- **影响面**：`ATTACKING` 的"时间承诺"可被冲刺取消（spec 03 §4.2 的"长按不连击/承诺窗口"语义被旁路）。**该行为自 M2-T01 引入 `ATTACKING` 起即存在**，非 M2-T02 新增；M2-T02 未触碰 `DashSystem` 的起手门控（仅改为读意图 + 加 `isFrozen`）。
- **建议**：与 F1 合并修复（同一处门控）。

> **除 F1/F2 外，未发现其它缺陷或 spec 不符。** 其余 8 项 Mission A 攻击全部未攻破，spec §6.2/§6.3 逐 Tick 表与实测**逐格一致**。

### F1 / F2 关闭确认（rev.2 · 本人独立复核）

engineering-lead 按 team-lead 裁定**修实现不改规格方向**（F1/F2 同根因，一处修复）：

- **修复**：`src/ecs/systems/DashSystem.ts:74-91` —— 非 `DASHING` 分支**先无条件读后置 `false` 脉冲**（`wantsToDash` 消费后即清零），**再**仅当 `state ∈ {IDLE, MOVING}` 时起手；`HITSTUN`/`ATTACKING` 不可打断，且被消费的脉冲**丢弃**（不缓冲）。`DASHING` 分支 / 冷却 / `isFrozen` 未动。
- **本人独立复核（自建探针，未采信其自述）**：
  - F1（玩家侧）：玩家被命中 → `HITSTUN/1` → Tick5 按冲刺 → **仍 `HITSTUN/2`**（非 `DASHING`）；Tick12 退出硬直；Tick14 全新按键 → `DASHING`。✅
  - F2（玩家侧）：`ATTACKING` 期间按冲刺 → **仍 `ATTACKING`**；Tick17 退出；Tick19 全新按键 → `DASHING`。✅
  - 脉冲丢弃（敌人侧）：`HITSTUN` 期抬 `wantsToDash` → 消费为 `false`、不起手；跨 Tick 13（硬直结束后）**不补触发**。✅
- **反向变异自证（本人执行）**：将门控临时改为恒 `true` → `feedback.test.ts` **恰 2 条失败**（F1/F2 回归），其余 28 条通过；随即复原（`DashSystem.ts:87-88` 已复核恢复）。证明回归用例**精确命中、非空洞**。
- **新增回归用例**：`tests/combat/feedback.test.ts` G6 新增 2 条（`refuses to let a dash pulse cancel HITSTUN (F1 regression)` / `…cancel ATTACKING (F2 regression)`），共 28 → 30。
- **规格同步（spec 04 rev.3）**：§5.1（DashSystem 行）、§5.2（顺序理由点 4，明确"仅靠 `StateSystem` 不足以拦截冲刺路径"）、§7（AC-03 增补"`HITSTUN` 不可被冲刺取消"）、§8（重写缓解 + 新增 F1/F2 两行）均已订正，方向正确、与实现一致。

**结论：F1 / F2 CLOSED。**

---

## 6. 变异测试 · 门禁有效性证据（Mission A #8）

**方法**：临时在 `src/` 下新增两个 `.ts` 探针文件，分别运行 `npx eslint <file>`，随后**删除**并复跑 `npm run lint`。

### 6.1 真实访问探针（`src/__qa_mutation_probe.ts`）→ **报错**
```
D:\...\src\__qa_mutation_probe.ts
   6:13  error  Unexpected use of 'window'.        …            no-restricted-globals
   7:13  error  Unexpected use of 'document'.      …            no-restricted-globals
   8:13  error  'Math.random' is restricted from being used. …  no-restricted-properties
   9:13  error  'Date.now' is restricted from being used.    …  no-restricted-properties
  10:13  error  src/ must stay wall-clock free — no `new Date()`  no-restricted-syntax
✖ 5 problems (5 errors, 0 warnings)
EXIT=1
```
→ **四条纯逻辑禁令全部命中**（window / document / Math.random / Date.now / new Date()）。

### 6.2 仅注释探针（`src/__qa_comment_probe.ts`，正文只含 `window.` / `document.` / `Math.random()` / `Date.now()` / `new Date()` 的**文字**）→ **零误报**
```
$ npx eslint src/__qa_comment_probe.ts
（无输出）
EXIT=0
```
→ 这正是本次技术债修复要解决的问题：**旧 `grep` 会误伤注释里的普通英文名词（如句末 `window.`），AST 门不会**。

### 6.3 复原
```
$ rm -f src/__qa_mutation_probe.ts src/__qa_comment_probe.ts
$ npm run lint
（无输出）EXIT=0
```
→ **无残留**（`find src tests -name "__*probe*" -o -name "__qa*"` 返回空）。

### 6.4 反向变异（证明新增用例非空洞）
将 `src/ecs/components/FreezeComponent.ts` 的 `const armed = ticks + 1;` 临时改为 `ticks`（模拟 spec §8 的"`applyFreeze` 写入 `ticks` 而非 `ticks+1`"缺陷）→ `feedback.test.ts` **立即 8 条失败**（G0 边界、G1 残余意图、G1 AC-02、G8 语义等），随即**复原**（`git diff` 复核 `ticks + 1` 已恢复，无 src 残留）。→ **新增断言具备可证伪性。**

---

## 7. 质量门判定

> ### ✅ PASS（rev.2）
> - **AC-01 / AC-02 / AC-03（三项派发明确要求）经独立逐 Tick 实测全部成立**；AC-04…AC-08 保障门全过；变异测试证明 ESLint AST 门精确且零误报；套件 96 → **116** 全绿。
> - **F1 / F2 已由 engineering-lead 修复，并经本人独立复核关闭**（自建探针 + 反向变异自证；见 §5、§13）。
> - 修复方向正确：**修实现不改规格方向**（`DashSystem` 起手门控 `IDLE`/`MOVING`，与 spec 02 §4.1 / spec 04 §8 对齐）；spec 04 rev.3 同步、方向一致。

**关注项（均已关闭）：**

| ID | 严重度 | 关注项 | 状态 |
|---|---|---|---|
| **F1** | Major（spec 保真度） | `HITSTUN` 可被冲刺逃逸 | ✅ **CLOSED** — `DashSystem` 起手门控 `IDLE`/`MOVING` + 脉冲无条件消费；本人独立复核 + 反向变异自证 |
| **F2** | Major（spec 保真度，M2-T01 血缘） | `ATTACKING` 可被冲刺取消 | ✅ **CLOSED** — 同 F1 同一处门控 |

**过程关注项（非质量缺陷，提请 team-lead / 用户知悉）：**

| ID | 说明 | 处置建议 |
|---|---|---|
| **P-1** | spec 02 rev.2 顺带订正（**超出 F1/F2 裁定字面**）：§6 tick 30 行 / §7 AC-04 / §10 取舍 5 原写"按住键冷却后自动再冲"，与**未改动的 `dash.test.ts` G2**（上升沿，明确断言不自动再冲）矛盾。engineering-lead 已订正为**边沿语义**并记入 rev.2 | 本人复核：该订正**事实正确**（实现为边沿触发，`dash.test.ts` G2 已固化），属 M2-T01 遗留规格滞后，**建议保留**；因超出原裁定字面，提请 team-lead / 用户**追认范围**（或另立文档工单） |

**无 Blocker / Critical。** 门控判定：**PASS**（advisory —— 最终放行由用户决定）。

---

## 8. Flaky 风险评估：**低**

- 2 轮随机顺序（`--sequence.shuffle`）全绿；套件无随机数、无定时器、无网络、无文件 IO、无并发共享状态。
- `pool:'threads'` + `environment:'node'`，无 jsdom / 全局污染。
- 新用例全部走真实 `GameSimulator` + 真实预制体，浮点断言用 `1e-9` 容差或 `toBe`（仅在**逐位相同**语义处使用，如 maxSpeed/意图无关性）；无"依赖执行顺序"的断言。
- 结论：**无需隔离的 flaky 测试**。

---

## 9. 签收基线（Artifact Hashes）

| 文件 | sha256（rev.2 复核后） |
|---|---|
| `eslint.config.mjs` | `f67309e5fc267176a8c7aa99bcf37e1d4070574cbe812a104775fa4f082ada41` |
| `.github/workflows/ci.yml` | `2cf2021d3f43bc6aab69132bfb06760265457336527f82c71c8b2a03d04f3ba0` |
| `package.json` | `cc515435ee70e698436585e80dce076ea6e3d983144a0e0c6c26847eadd27e78` |
| `specs/04_combat_feedback_spec.md`（rev.3） | `00501e8291dd3a32202e594485028d85e1eb0351d4f3592958044e1b8d7719b6` |
| `specs/02_dash_and_state_spec.md`（rev.2） | `b2bc834e8173824054551bf7f443a5987dfb07ae4ccd0eea1cfd1352013c10b1` |
| `src/ecs/components/FreezeComponent.ts` | `29f1d9b62cdf58a2a6f288bf58d261f6e687fb5b7c14b0d32843009ac591421c` |
| `src/ecs/systems/FreezeSystem.ts` | `8917ce52ed4b8842b74aab9246555c67d9c3e3c0d65f9e518ee4f77277ba2b34` |
| `src/ecs/systems/CollisionSystem.ts` | `368eddbb78aa80cfccfa70613a8f0aad8e0c31b414720633d72c4216515a57df` |
| `src/ecs/systems/DashSystem.ts`（F1/F2 修复） | `146dbbf506e8be0dce609c659f1956e05daf73b4cff2a2513fa5f172819d0296` |
| `tests/combat/feedback.test.ts`（30 用例） | `e66c37c5adb11f3e02cef6560e468cb39a91bbbd3674ca75216a5a046ede7f56` |
| `tests/combat/hit_detection.test.ts`（G3 时机订正） | `d1ff64daa45971c38689f8ecf16e45aa992a8508a8f380e5a79b80a221828094` |

> ⚠️ 若任一 `src/` 或上述文件在本表哈希之外发生变更，本门结论**自动失效**，需重跑。

---

## 10. 已知覆盖盲区与残留风险

1. **F1 / F2（冲刺状态门控）** —— ✅ **已关闭**（rev.2）：engineering-lead 补齐 `DashSystem` 起手门控并新增 2 条 G6 回归（`HITSTUN` / `ATTACKING` 期间冲刺脉冲被消费丢弃、不打断），本人独立复核 + 反向变异确认（变异门控恰使这 2 条失败）。
2. **冻结期间"攻击脉冲"变体**：G6 已覆盖冲刺脉冲（AI + 玩家两路）；攻击脉冲的"不缓冲"由同一 `FreezeSystem` 清零路径保障，未单列用例（低风险，同一代码路径）。
3. **判定圆 `ownerEntityId` 悬垂**：`CollisionSystem` 以 `world.isAlive(ownerEntityId)` 守卫，但本里程碑**无法销毁实体**（无死亡），该分支不可达，故无用例；待 M3 引入死亡后需补测。
4. **多段命中下的顿帧 `max` 延长**：`applyFreeze` 的 `max` 语义已由 G8 直接验证，但"同一实体连续两次命中取 max"未在真实命中路径上端到端覆盖（需两枚判定圆，超出本里程碑 Out of Scope）。
5. **F2 血缘**：`ATTACKING` 可被冲刺取消自 M2-T01 即存在；本次未回溯 M2-T01 的 QA 报告，未确认其是否曾被登记。

---

## 11. 待用户审批项 / 下一步建议

**待用户审批：**
1. 是否接受 **PASS** 判定并放行 M2-T02。
2. **追认 P-1 范围**：spec 02 rev.2 对 §6 tick 30 / §7 AC-04 / §10 取舍 5 的边沿语义订正**超出 F1/F2 裁定字面**（属 M2-T01 遗留规格滞后，本人复核事实正确）——是否追认保留，或另立文档工单。
3. 是否将本次 `feedback.test.ts` 的 **30 条**用例（含 2 条 F1/F2 回归）**并入常驻回归网**（已随 `npm run test` 生效）。

**下一步建议：**
1. 保持两条硬契约的回归断言常驻：①"`CollisionSystem` 写入点晚于 `StateSystem`"（相位补偿）；②"`DashSystem` 起手门控 `IDLE`/`MOVING`"（F1/F2）。防止后续重排管道 / 改动门控时静默回归。
2. M3 引入敌人 AI 与实体死亡后，补 `ownerEntityId` 悬垂分支与"多段命中取 `max`"的端到端用例。
3. 换机 / CI 前用 §9 的 sha256 校验受审产物未被并发改写。

---

## 12. 附：本次触碰的文件清单

| 文件 | 变更 | 说明 |
|---|---|---|
| `tests/combat/feedback.test.ts` | **改**（10 → 28 用例，rev.1） | 保留既有 10 条断言原样，新增 G0/G1/G2/G5…G10 共 18 条 |
| `tests/combat/feedback.test.ts` | **改**（28 → 30 用例，rev.2 · engineering-lead） | 新增 G6 F1/F2 回归 2 条 |
| `src/ecs/components/FreezeComponent.ts` | 临时变异 → **已复原** | rev.1 反向变异；复核 `ticks + 1` 已恢复 |
| `src/ecs/systems/DashSystem.ts` | 临时变异 → **已复原** | rev.2 反向变异（门控恒 `true`）；复核 `IDLE`/`MOVING` 已恢复 |
| `src/__qa_mutation_probe.ts`、`src/__qa_comment_probe.ts` | 临时新增 → **已删除** | 门禁有效性探针 |
| `tests/combat/__probe*.test.ts`、`__reverify.test.ts` | 临时新增 → **已删除** | 时序实测 / F1·F2 复核探针 |

> **`src/` 产品代码最终零残留变更**（两次反向变异均已复原并复核）；`hit_detection.test.ts` 的 G3 时机订正由 engineering-lead 完成，本人已复核；**未执行 git commit / push**。

---

## 13. rev.2 · F1/F2 复核日志（本人独立执行）

| 步骤 | 命令 / 方法 | 结果 |
|---|---|---|
| 1 | 复跑三道门 | `typecheck` 0 · `lint` 0 · `test` **116/116**（10 文件） |
| 2 | 自建探针复核 F1（玩家被命中 → `HITSTUN` → Tick5 冲刺） | Tick5 **仍 `HITSTUN/2`**（非 `DASHING`）；Tick12 退出；Tick14 新按键 → `DASHING` ✅ |
| 3 | 自建探针复核 F2（`ATTACKING` → Tick5 冲刺） | Tick5 **仍 `ATTACKING`**；Tick17 退出；Tick19 新按键 → `DASHING` ✅ |
| 4 | 自建探针复核"脉冲丢弃不缓冲"（敌人 `HITSTUN` 期抬脉冲） | 脉冲被消费为 `false`；跨 Tick13 不补触发 ✅ |
| 5 | 反向变异：`DashSystem` 门控临时恒 `true` | `feedback.test.ts` **恰 2 条失败**（F1/F2 回归），其余 28 条通过 → 回归用例精确命中、非空洞 |
| 6 | 复原 + 残留检查 | `DashSystem.ts:87-88` 已恢复 `IDLE`/`MOVING`；`find src tests -name "__*"` 为空 |
| 7 | 规格复核 | spec 04 rev.3（§5.1 / §5.2 点 4 / §7 AC-03 / §8 / §9）方向正确、与实现一致；spec 02 rev.2 边沿语义订正**事实正确**（见 §7 P-1） |
| 8 | git 状态 | **无 commit / push**（HEAD 仍为 `0fb01e7`） |

**最终结论：F1 / F2 CLOSED；质量门判定 PASS。**
