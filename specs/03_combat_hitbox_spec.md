# 03 · Combat Hitbox Spec（基础战斗、碰撞几何与无敌帧消费）

| Field | Value |
|---|---|
| Spec ID | `SPEC-03-COMBAT-HITBOX` |
| Milestone | **M2 · 基础战斗**（T01） |
| Status | `accepted`（本文件为 M2-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `src/ecs/components/{HealthComponent,FactionComponent,HurtboxComponent,HitboxComponent,StateComponent,InputComponent}.ts`、`src/ecs/systems/{CombatActionSystem,CollisionSystem,LifespanSystem,DashSystem,MovementSystem,StateSystem,pipeline}.ts`、`src/ecs/prefabs/{spawn-helpers,PlayerFactory,EnemyFactory}.ts`、`tests/combat/`、`.github/workflows/ci.yml` |
| Depends on | `specs/00_harness_spec.md`（时钟/输入/ECS/Snapshot 契约）、`specs/01_character_controller_spec.md`、`specs/02_dash_and_state_spec.md`（无敌标签由冲刺产生） |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开）· Vitest（node 环境） |

---

## 1. 目的与范围

### 1.1 目的
在 M1 的移动 / 冲刺 / 动作状态机之上，落地**基础战斗判定**：
把"玩家按下攻击键"翻译成"在面朝方向前方生成一个有限寿命的判定圆"，并用**纯数学**（两点间距离）
判定它与敌对势力受击圆的相交；命中时结算伤害，且**当受击方处于无敌帧时整次碰撞被忽略**。
本 Spec 同时冻结 M2-T01 的两项前置技术债修复（CI 静态门收窄、冲刺上升沿触发）。

### 1.2 In Scope（做什么）
- 组件：`HealthComponent`、`FactionComponent`、`HurtboxComponent`、`HitboxComponent`。
- `StateComponent` 扩展：新增 `ActionState.ATTACKING` 与 `DEFAULT_ATTACK_DURATION_TICKS`。
- `InputComponent` 扩展：`buttonDashJustPressed` / `buttonAttack` / `buttonAttackJustPressed` 与 `ATTACK_KEY`。
- 系统：`CombatActionSystem`、`CollisionSystem`、`LifespanSystem`。
- 管道扩展：`createDefaultSystems()` 追加上述三系统（M1 三段顺序**不变**）。
- 预制体：`spawnCombatant` 共用装配 + `PlayerFactory` 扩展 + 新增 `EnemyFactory`。
- 技术债：`.github/workflows/ci.yml` 纯逻辑门正则收窄；冲刺改为**上升沿触发**。

### 1.3 Out of Scope（显式排除）
- ❌ 击退、受击硬直、死亡/销毁实体、掉落、战利品（M3+）。
- ❌ 多段攻击、连招、攻击取消（cancel）、冲刺攻击、技能位移。
- ❌ 攻击的资源消耗（耐力/充能）与攻击冷却组件（本 Spec 用动作状态门控）。
- ❌ 伤害类型 / 抗性 / 暴击 / 护甲减伤（只做 `hp -= damage`）。
- ❌ 空间划分（broadphase / 网格 / 四叉树）——实体规模极小，暴力双循环即可。
- ❌ 任何外部物理引擎、DOM / Canvas / 图形库（沿用 spec 00 C1）。

### 1.4 约束
- C1 **时间只来自 Tick**：寿命以整数 Tick 计，**禁止**墙钟；积分取 `ctx.fixedDeltaSeconds`。
- C2 **确定性**：同输入序列 ⇒ 逐 Tick 同状态；遍历一律走 `World.query`（id 升序）。
- C3 **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- C4 **POD 契约**：组件为 `ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法
  （伤害结算以自由函数 `applyDamage` 提供）。
- C5 **无跨 Tick 隐藏状态**：系统不得持有隐藏状态（spec 00 §6.1）；计时一律落在组件字段上。
- C6 **纯数学**：碰撞判定只用加减乘与比较，不引入物理引擎、不引入随机。
- C7 **不改时钟/步长**：`FixedClock`、`GameSimulator.step`、`SystemContext` 的既有契约不得改动。

---

## 2. 术语表

| 术语 | 定义 |
|---|---|
| **Faction** | 阵营枚举 `Player` / `Enemy`；**不同阵营即敌对**，同阵营永不互相伤害。 |
| **Hitbox（攻击判定圆）** | 攻击产生的**独立实体**，拥有圆心（自身 `TransformComponent`）、半径、伤害、寿命与已命中账本。 |
| **Hurtbox（受击判定圆）** | 实体可被击中的圆，圆心 = 该实体 `TransformComponent` 位置，半径 = `HurtboxComponent.radius`。 |
| **命中（Hit）** | `圆心距离 < hitbox.radius + hurtbox.radius` 且双方敌对且目标未被本 Hitbox 命中过。 |
| **hitEntities（命中账本）** | `HitboxComponent` 上记录"已被本 Hitbox 命中过的实体 id"的数组，**防止单次攻击多段伤害**（AC-03）。 |
| **activeTicks（寿命）** | Hitbox 剩余存活 Tick 数；`LifespanSystem` 每 Tick 递减，`<= 0` 时销毁实体。 |
| **ATTACKING** | 攻击承诺状态；期间不可再次起手攻击，持续 `DEFAULT_ATTACK_DURATION_TICKS` 后回到 `IDLE`/`MOVING`。 |
| **无敌帧消费契约** | 受击方携带 `Invulnerable` 标签时，本次碰撞被**整体忽略**：不结算伤害，**且不写入命中账本**（AC-04）。 |
| **上升沿（JustPressed）** | 按键由"未按住"变为"按住"的那一个 Tick 为 `true`，其余 Tick 为 `false`。 |
| **规范管道** | 每 Tick 固定的系统执行顺序（硬契约，见 §5.4）。 |

---

## 3. 组件契约

组件均为 `ComponentBase` 子类（POD，无行为），字段为 `public` 可写数据。

### 3.1 `HealthComponent` — 生命值
导出常量：`DEFAULT_MAX_HP = 100`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `hp` | `number` | `100` | 当前生命值；经 `applyDamage` 后**不低于 0** |
| `maxHp` | `number` | `100` | 生命值上限 |

自由函数：
| 函数 | 签名 | 语义 |
|---|---|---|
| `applyDamage` | `(world, id, amount) => void` | `hp = max(0, hp - amount)`；无 `HealthComponent` 时为 no-op |
| `isAlive` | `(world, id) => boolean` | `hp > 0`；**无 `HealthComponent` 视为存活**（生命值是可选特征） |

### 3.2 `FactionComponent` — 阵营
```ts
export enum Faction { Player = 'Player', Enemy = 'Enemy' }
```
| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `faction` | `Faction` | `Faction.Enemy` | 所属阵营 |

自由函数 `areHostile(a, b) => a !== b`：本里程碑最简单的敌对规则（不同阵营即敌对），
为后续"同盟/中立"预留扩展点。

### 3.3 `HurtboxComponent` — 受击判定圆
导出常量 `DEFAULT_HURTBOX_RADIUS = 0.5`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `radius` | `number` | `0.5` | 受击半径；圆心取实体 `TransformComponent` |

> 是否**当前可被击中**不存在这里——那是 `Invulnerable` 标签的职责（spec 02 §3.3），由 `CollisionSystem` 查询。

### 3.4 `HitboxComponent` — 攻击判定圆 + 寿命 + 命中账本
导出常量：
| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_ATTACK_HITBOX_RADIUS` | `1` | 近战攻击判定半径 |
| `DEFAULT_ATTACK_DAMAGE` | `10` | 单次攻击伤害 |
| `DEFAULT_ATTACK_HITBOX_LIFESPAN_TICKS` | `15` | 判定圆存活 Tick 数（@60fps = 0.25 s） |
| `DEFAULT_ATTACK_HITBOX_OFFSET` | `0.75` | 判定圆相对攻击者原点的前向偏移 |

字段：
| 字段 | 类型 | 说明 |
|---|---|---|
| `radius` | `number` | 判定半径 |
| `damage` | `number` | 命中时施加的伤害 |
| `activeTicks` | `number` | 剩余寿命；`<= 0` 由 `LifespanSystem` 销毁 |
| `faction` | `Faction` | **攻击者阵营**（生成时快照） |
| `hitEntities` | `EntityId[]` | 已命中实体 id，**升序**（确定性） |

> `faction` 存在 Hitbox 上而不是每 Tick 回查攻击者：即便攻击者中途被销毁，判定圆仍可正常工作，
> 且命中结算不依赖攻击者存活。

### 3.5 `StateComponent`（扩展）
`ActionState` 新增第四值 `ATTACKING = 'ATTACKING'`。
新增导出常量 `DEFAULT_ATTACK_DURATION_TICKS = 12`（@60fps = 0.2 s）。

### 3.6 `InputComponent`（扩展）
导出常量 `ATTACK_KEY = 'attack'`。

| 字段 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `buttonDash` | `boolean` | `false` | **电平**：冲刺键是否按住（持久，跨空 Tick 保持） |
| `buttonDashJustPressed` | `boolean` | `false` | **上升沿**：本 Tick 刚刚按下冲刺键（宽度恰好 1 Tick） |
| `buttonAttack` | `boolean` | `false` | **电平**：攻击键是否按住 |
| `buttonAttackJustPressed` | `boolean` | `false` | **上升沿**：本 Tick 刚刚按下攻击键 |

派生规则（`MovementSystem.bindInput`，每 Tick 无条件重算，含空输入帧）：
```
wasDashHeld   = keysHeld 含 DASH_KEY   （处理本 Tick 事件之前）
wasAttackHeld = keysHeld 含 ATTACK_KEY （处理本 Tick 事件之前）
… 处理事件、维护升序 keysHeld …
dashHeld   = keysHeld 含 DASH_KEY
attackHeld = keysHeld 含 ATTACK_KEY
buttonDash              = dashHeld
buttonDashJustPressed   = dashHeld   && !wasDashHeld
buttonAttack            = attackHeld
buttonAttackJustPressed = attackHeld && !wasAttackHeld
```
- 电平由 `keysHeld` 推导，空 Tick 不改变 `keysHeld` ⇒ **电平自然保持**（与 M1 行为一致）。
- 上升沿是"按键集合的**转移**"（前未按住 ∧ 后按住），因此**恰好为 true 一个 Tick**。

---

## 4. 战斗语义契约

### 4.1 敌对判定（AC-01）
- 只有 `areHostile(hitbox.faction, target.faction) === true` 的目标才会被结算。
- 同阵营一律跳过 ⇒ 玩家自己的判定圆**不会**打到自己（玩家同时拥有 Hitbox 与 Hurtbox，二者圆在几何上必然重叠）。

### 4.2 攻击起手（AC-02）
- 触发条件（**全部满足**）：`buttonAttackJustPressed === true` ∧ `state ≠ DASHING` ∧ `state ≠ ATTACKING`。
- 效果：`state = ATTACKING`、`ticksInState = 0`，并生成 **1 个** Hitbox 实体。
- 长按不连击：上升沿每按一次只产生一个 Tick 的 `true`；且 `ATTACKING` 期间再次按下会被门控拒绝。

### 4.3 判定圆生成几何（AC-02）
```
dir  = (cos(facingRadians), sin(facingRadians))        // 攻击者面朝单位向量
pos  = attackerPos + dir * DEFAULT_ATTACK_HITBOX_OFFSET
Hitbox 实体 = TransformComponent(pos, facingRadians) + HitboxComponent(半径, 伤害, 寿命, 攻击者阵营)
```
判定圆**不跟随**攻击者：它是世界空间中的固定圆，在 `activeTicks` 内持续参与判定。

### 4.4 无敌帧消费契约（AC-04）
命中判定按固定顺序短路，任一步不满足即跳过该 (Hitbox, 目标) 对：

| 步 | 条件 | 动作 |
|---|---|---|
| 1 | 目标已在 `hitbox.hitEntities` 中 | **跳过**（多段伤害防护，AC-03） |
| 2 | `!areHostile(hitbox.faction, target.faction)` | **跳过**（友军/自身伤害防护，AC-01） |
| 3 | `dx² + dy² >= (hitbox.radius + hurtbox.radius)²` | **跳过**（未相交，AC-03） |
| 4 | `hasTag(target, INVULNERABLE_TAG)` | **跳过**（无敌帧消费，AC-04） |
| 5 | 以上皆否 | `applyDamage`；`hitEntities.push(targetId)` 并保持升序 |

**第 4 步的语义是"整体忽略"，不是"命中但不结算"**：无敌帧下**不写入** `hitEntities`。
这正是"同一个判定圆可以在无敌窗口结束后再命中该目标"的前提；若把无敌帧目标记入账本，
它会永久免疫该次攻击（本 Spec 的 AC-04 第二个用例即为此设防）。

### 4.5 冲刺上升沿触发（技术债修复）
- `DashSystem` 的起手条件由 `buttonDash` 改为 `buttonDashJustPressed`。
- 结果：**长按冲刺键不再于冷却结束的瞬间自动连冲**；必须"松开 → 再按"才能触发第二次冲刺。
- 冷却语义（30 Tick、自冲刺开始计）**保持不变**。

### 4.6 CI 纯逻辑门收窄（技术债修复）
- 旧正则 `\b(document|window|HTMLCanvasElement|requestAnimationFrame|performance\.now|Date\.now|Math\.random)\b`
  会误伤注释里的普通英文单词。
- 新正则 `\b(window\.|document\.|Date\.now\(\)|Math\.random\(\))` 只匹配**实际访问形态**
  （浏览器全局带点、墙钟/随机带调用括号）。
- 残留风险见 §8：`\bwindow\.` 仍会命中句末的英文名词 `window.`，故 `src/` 内注释仍需避免该词面量。

---

## 5. 系统契约与管道顺序

### 5.1 `CombatActionSystem`（新增）
`name === 'CombatActionSystem'`。对同时拥有 `InputComponent` + `StateComponent` + `TransformComponent` + `FactionComponent`
的实体（id 升序）：
1. `if (!input.buttonAttackJustPressed) continue;`
2. `if (state.state === DASHING || state.state === ATTACKING) continue;`
3. `state.state = ATTACKING; state.ticksInState = 0;`
4. 按 §4.3 生成 Hitbox 实体。

> `world.query` 返回的是**新建数组**，因此在遍历中创建实体是安全的；新实体 id 更大且无 `InputComponent`，
> 不会在本 Tick 被本循环再次处理，但会被同一 Tick 稍后运行的 `CollisionSystem` 看到。

### 5.2 `CollisionSystem`（新增）
`name === 'CollisionSystem'`。
- `hitboxIds = query(Transform, Hitbox)`；为空则直接返回。
- `targetIds = query(Transform, Hurtbox, Faction, Health)`；为空则直接返回。
- 对每个 Hitbox × 每个目标，按 §4.4 的五步顺序短路判定。
- 圆相交用**平方距离**比较：`dx*dx + dy*dy < radiusSum*radiusSum`。
  两侧半径均非负，故与 `sqrt(dx²+dy²) < r1+r2` 等价，但省去开方且只用 `+`/`*`/`<`，最利于跨平台确定性。
- `hitEntities.push` 后 `sort((a,b) => a-b)`，保证快照逐字节可复现。

### 5.3 `LifespanSystem`（新增）
`name === 'LifespanSystem'`。对每个拥有 `HitboxComponent` 的实体（id 升序）：
```
hitbox.activeTicks -= 1;
if (hitbox.activeTicks <= 0) world.destroyEntity(id);
```
`query` 返回新建数组，故遍历中销毁实体安全且确定。

### 5.4 规范管道（硬契约）
`src/ecs/systems/pipeline.ts::createDefaultSystems()` 返回**新实例数组**，顺序固定：

```
MovementSystem -> DashSystem -> StateSystem -> CombatActionSystem -> CollisionSystem -> LifespanSystem
```

顺序理由（**不得重排**）：
1. `MovementSystem` 先跑，按**上一 Tick 决定的状态**积分 → 本 Tick 启动的冲刺从**下一 Tick** 开始位移，
   从而"15 Tick 冲刺"恰好对应 15 个位移 Tick（spec 02 §6）。
2. `DashSystem` 次跑，施加本 Tick 的冲刺进入 / 方向锁定 / 无敌标签 / 冷却递减。
3. `StateSystem` 再跑，推进 `ticksInState` —— 使无敌窗口与冲刺前段对齐、冲刺恰在第 `durationTicks` 个 Tick 退出，
   并让 `ATTACKING` 在 `DEFAULT_ATTACK_DURATION_TICKS` 后退出。
   **以上三段为 M1 硬契约，禁止改动。**
4. `CombatActionSystem` 在状态机之后：本 Tick 的动作状态已定，攻击门控判定才准确；
   又在碰撞之前：本 Tick 生成的判定圆本 Tick 即可命中。
5. `CollisionSystem` 在 `DashSystem` 之后，因此读到的 `Invulnerable` 标签正是**本 Tick 已被 DashSystem 更新过**的值
   —— 这是无敌帧消费契约逐 Tick 精确的前提（§6）。
6. `LifespanSystem` **最后**：确保判定圆在被销毁前已经完成本 Tick 的碰撞检测，即寿命为**完整**的 `activeTicks` 个 Tick。

### 5.5 实体过滤与顺序
- 只处理所需组件齐备的实体；缺任一组件则跳过，不报错。
- 所有遍历按 `World.query` 的 id 升序进行（确定性）。

---

## 6. 时序硬契约（逐 Tick，QA 将逐 Tick 断言）

### 6.1 无敌窗口的精确边界
设冲刺起始 Tick 为 `t0`（`startDash` 在 `t0` 的 `DashSystem` 中执行）。`DashSystem` 在 Tick `k` 读到的
`ticksInState` 为 `k - t0`（`t0` 当 Tick 由 `startDash` 置 0）：

| 条件 | Tick 范围 | 标签动作 |
|---|---|---|
| `k - t0 < 12` | `t0 .. t0+11` | `addTag(INVULNERABLE_TAG)`（幂等） |
| `k - t0 >= 12` | `t0+12 ..` | `removeTag(INVULNERABLE_TAG)` |

⇒ **标签在 Tick `t0` 至 `t0+11` 被挂上（共 12 Tick），在 Tick `t0+12` 被摘除。**
因 `DashSystem` 位于 `CollisionSystem` 之前，摘除发生在**同一 Tick 的碰撞检测之前**，
即 Tick `t0+12` 的命中**已经生效**。

### 6.2 验收场景几何（`fps = 60`，`maxSpeed = 5`）
- 玩家：(0, 0)，`facingRadians = 0`；Tick 0 注入 `keyDown('attack')`。
- 玩家判定圆：圆心 **(0.75, 0)**、半径 **1.0**（寿命 15 Tick，Tick 0 生成，Tick 14 末销毁）。
- 敌方受击圆半径 **0.5** ⇒ **相交判据：圆心距离 < 1.5**。
- 敌方在 Tick 1 注入 `keyDown('dash')`（`facingRadians = -π/2`，向 -y 冲刺，每 Tick 0.25）。

**场景 A（敌方起点 (0, 1.9)）—— 无敌帧防身**

| Tick | 敌方 y | 圆心距离 | 标签 | 命中？ | 敌方 HP |
|---|---|---|---|---|---|
| 0 | 1.9 | 2.043 | ❌ | 未相交 | 100 |
| 3 | 1.4 | 1.588 | ✅ | 未相交 | 100 |
| 4 | 1.15 | 1.373 | ✅ | 相交但无敌 | 100 |
| 5 | 0.9 | 1.172 | ✅ | 相交但无敌 | **100** |
| 11 | -0.6 | 0.961 | ✅ | 相交但无敌 | 100 |
| 12 | -0.85 | 1.134 | ✅ | 相交但无敌 | **100** |
| 13 | -1.1 | 1.332 | ❌ | **相交且生效** | **90** |

**场景 B（敌方起点 (0, 4.4)）—— 无敌帧过期后生效**

| Tick | 敌方 y | 圆心距离 | 标签 | 命中？ | 敌方 HP |
|---|---|---|---|---|---|
| 12 | 1.65 | 1.813 | ✅ | 未相交 | 100 |
| 13 | 1.4 | 1.588 | ❌ | 未相交 | **100** |
| 14 | 1.15 | 1.373 | ❌ | **相交且生效** | **90** |

**由该表派生的可断言事实（MUST）**：
1. 判定圆是**独立实体**，攻击者位移不影响其位置。
2. 场景 A：时钟 5 / 12 时敌方**已相交**且**携带 `Invulnerable`**，HP 恒为 100。
3. 场景 A：时钟 13 标签已摘除，同一判定圆立即造成 10 点伤害（HP 90）——证明无敌帧**未被消费**。
4. 场景 B：时钟 13 时无敌已过但**未相交**，HP 仍为 100；时钟 14 相交并造成伤害（HP 90）。
5. 判定圆在 Tick 14 的碰撞检测**之后**才被 `LifespanSystem` 销毁 ⇒ 寿命为完整的 15 个 Tick。
6. 冲刺结束后敌方回到 `IDLE`/`MOVING`，状态机无卡死。

---

## 7. 验收标准（Acceptance Criteria）

| ID | 验收项 | 判据 | 优先级 |
|---|---|---|---|
| **AC-01** | 阵营隔离 | 实体拥有 `FactionComponent`；同阵营命中被跳过（玩家自身判定圆与其受击圆几何重叠但 HP 不变）；跨阵营可命中 | 必达（派发要求） |
| **AC-02** | 攻击生成独立 Hitbox | `buttonAttackJustPressed` ⇒ 实体进入 `ATTACKING` 且世界中新增 **1 个** Hitbox 实体；其圆心位于面朝方向前方 `DEFAULT_ATTACK_HITBOX_OFFSET` 处 | 必达（派发要求） |
| **AC-03** | 圆相交判定 + 单次伤害 | 命中判据 `dx²+dy² < (r_hb + r_hurt)²`；命中后 `hp` 减少 `damage`；同一 Hitbox 对同一目标**只结算一次**（`hitEntities` 去重） | 必达（派发要求） |
| **AC-04** | 无敌帧消费契约 | 目标携带 `Invulnerable` 时**整次碰撞被忽略**：不结算伤害**且不写入 `hitEntities`**；窗口过期后同一判定圆可正常命中 | 必达（派发要求） |
| AC-05 | 寿命与销毁 | `LifespanSystem` 每 Tick 递减 `activeTicks`，`<= 0` 时销毁实体；判定圆存活恰为 `activeTicks` 个 Tick（碰撞先于销毁） | 保障门 |
| AC-06 | 确定性回放 | 同输入序列跑两个独立 Simulator，逐 Tick Snapshot `toEqual` 一致 | 保障门 |
| AC-07 | 冲刺上升沿 | 长按冲刺键在冷却结束后**不再自动连冲**；"松开 + 再按"可再次触发 | 必达（派发要求） |
| AC-08 | 类型安全与纯逻辑 | `npm run typecheck` 零错误、无 `any` 逃逸；`src/` 无 DOM/墙钟/随机（收窄后的静态门）；Vitest 为 node 环境 | 保障门 |

> AC-01…AC-04、AC-07 为任务派发明确要求；AC-05/06/08 为保障前四条可信而设的补充门。

---

## 8. 失败模式（Failure Modes）

| 模式 | 后果 | 缓解 |
|---|---|---|
| 无敌帧目标被写入 `hitEntities` | 该目标对本次攻击**永久免疫**，无敌帧变成"免死金牌" | §4.4 第 4 步在写入之前短路；G2 第三个用例显式断言账本为空 |
| `LifespanSystem` 排在碰撞之前 | 判定圆少一个 Tick 的有效窗口，边界用例随机失败 | §5.4 顺序第 6 条；AC-05 断言存活 Tick 数 |
| 判定圆跟随攻击者 | 攻击者位移会把判定圆拖走，命中范围随移动漂移 | 判定圆为独立实体，只在生成时取一次位置（§4.3） |
| 用 `hitbox.faction` 之外的方式判敌对 | 玩家被自己的攻击打到 | §4.1 + AC-01 用例（几何重叠但零伤害） |
| 攻击门控漏掉 `ATTACKING` | 长按/连按可连击，`ticksInState` 被反复清零 | §4.2 门控同时排除 `DASHING` 与 `ATTACKING` |
| 用 `buttonAttack`（电平）起手 | 长按自动连击 | 只读 `buttonAttackJustPressed`（§3.6） |
| `keysHeld` 未排序 / `hitEntities` 未排序 | Snapshot 因插入顺序不同而不等，破坏确定性 | 两处均 `sort()` |
| 硬编码 `1/60` | 换 fps 后位移与判定错位 | 位移取 `ctx.fixedDeltaSeconds`（M1 已保证） |
| 浮点相等边界判定 | `dist == r1+r2` 时的命中结果依赖实现细节 | 判据用严格 `<`；测试几何刻意避开等值边界（§6.2） |
| 纯逻辑门正则过宽 | 注释里的普通英文单词触发 CI 失败 | §4.6 收窄为访问形态；**残留**：句末 `window.` 仍会命中 ⇒ `src/` 注释避免该词面量 |
| 多实体共用全局输入帧 | 同 Tick 内所有持 `InputComponent` 的实体一起响应同一按键（见 §10 取舍 4） | 测试通过几何/朝向设计使交叉响应不影响断言；根治需引入按实体键位绑定 |

---

## 9. 追溯（Traceability）

- **本 Spec → 测试**：`tests/combat/hit_detection.test.ts`（AC-01…AC-06）；
  `tests/combat/dash.test.ts` G0/G2（AC-07、`ATTACKING` 枚举扩展）；
  AC-08 由 CI 静态门 + `npm run typecheck` 覆盖。
- **本 Spec → 实现**：
  - `src/ecs/components/{HealthComponent,FactionComponent,HurtboxComponent,HitboxComponent}.ts`（新增）
  - `src/ecs/components/{StateComponent,InputComponent}.ts`（扩展）
  - `src/ecs/systems/{CombatActionSystem,CollisionSystem,LifespanSystem}.ts`（新增）
  - `src/ecs/systems/{DashSystem,MovementSystem,StateSystem,pipeline}.ts`（扩展）
  - `src/ecs/prefabs/{spawn-helpers,EnemyFactory}.ts`（新增）、`PlayerFactory.ts`（扩展）
  - `.github/workflows/ci.yml`（纯逻辑门正则收窄）
- **契约依赖登记**：`specs/02_dash_and_state_spec.md` §3.3（`Invulnerable` 标签）、§5.1（管道顺序）。
  spec 02 §10 取舍 5 明确指出"若需严格边沿语义，需增加 `buttonDashPressed` 上升沿标记"——本 Spec §4.5 即该演进。
- 变更本 Spec 须同步更新测试与实现。

---

## 10. 已知取舍（Known Trade-offs）

1. **判定圆用平方距离而非开方**：省去 `sqrt` 且只用 `+`/`*`/`<`，跨平台确定性更好；
   代价是 `dist == r1+r2` 这一等值边界的结果与"先开方再比较"在极少数浮点位上可能不同。
   本里程碑所有测试几何均避开等值边界，故该差异不可观测。
2. **无敌帧"整体忽略"而非"命中但不结算"**：让同一个判定圆能在窗口结束后再命中，
   手感上更符合"无敌帧挡住这一下、无敌结束立刻吃伤害"的动作游戏直觉；
   代价是判定圆的有效命中次数不再等于"接触次数"。
3. **没有 `AttackStatsComponent`**：攻击持续时长用模块常量 `DEFAULT_ATTACK_DURATION_TICKS` 而非组件字段，
   与冲刺（`DashStatsComponent`）不对称。理由是派发的组件清单只要求扩展 `StateComponent`；
   当 M3 需要"不同武器不同前摇"时，应抽出 `AttackStatsComponent` 并让 `StateSystem` 读取。
4. **输入仍是全局帧（本里程碑最大局限）**：`MovementSystem.bindInput` 把同一 Tick 的事件帧应用到**所有**持
   `InputComponent` 的实体，因此玩家与敌人会同时响应同一个按键。这使 `EnemyFactory` 必须携带
   `InputComponent` 才能冲刺，也让测试必须靠几何/朝向设计规避交叉响应。
   根治方案是给 `InputComponent` 增加按实体的键位绑定（`dashKey` / `attackKey`）或引入独立的
   "意图（intent）"组件；本里程碑刻意不做，以保持派发范围。
5. **攻击期间不做位移/转向限制**：`ATTACKING` 只做时间承诺，不锁定移动；`MovementSystem` 的
   dashing/非 dashing 两路逻辑未因攻击改变。若后续要求"攻击定身"，需在 `MovementSystem` 增加 ATTACKING 分支。
6. **`isAlive` 对无 `HealthComponent` 实体返回 `true`**：生命值是可特征而非普遍特征（判定圆、纯装饰实体都没有生命值）。
   若未来要求"所有可命中实体必须有生命值"，应收紧为 `false`。

---

## 11. 修订记录（Revision History）

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| rev.1 | 2026-09-28 | 程基岩 | 初版（M2-T01）：战斗判定圆 + 圆碰撞 + 无敌帧消费；含 CI 正则收窄与冲刺上升沿两项技术债修复，AC-01…AC-08 |
