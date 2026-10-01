# 22 · Audio & Juice Spec（事件桥接、屏幕震动、受击火花与音频管线）

| Field | Value |
|---|---|
| Spec ID | `SPEC-22-AUDIO-JUICE` |
| Milestone | **M14 · 视听表现**（T01） |
| Status | `accepted`（本文件为 M14-T01 验收基线） |
| Owner | engineering-lead（程基岩） |
| Applies to | `client/ClientEventBridge.ts`（**新**）、`client/VFXManager.ts`（**新**）、`client/AudioManager.ts`（**新**）、`client/GameRenderer.ts`（`syncWorld` 第三参 / `syncCamera` / `syncEffects` / `sparkCount` / `shakeTimeRemainingMs` / `reset` / `destroy`）、`client/GameLoop.ts`（加性可选 `bridge` + `AudioSink`）、`client/main.ts`（装配 / run 边界清缓冲 / 金币观察）、`tests/render/juice_m14.test.ts`（**新**，17 例）、`tests/audio/audio_manager.test.ts`（**新**，4 例）、`package.json` + `package-lock.json`（`howler` + `@types/howler`） |
| Depends on | `specs/09_renderer_bridge_spec.md`（`stage` / `root` / `fxLayer` 子节点契约、单向依赖门）、`specs/10_render_juice_spec.md`（插值 / 跳字 / `fxLayer` 恒为 root 最后子节点）、`specs/05_boon_modifier_spec.md` §3.1（`HitEvent`）、`specs/08_encounter_and_death_spec.md` §3.3（`EntityDeathEvent`）、`specs/12_armor_and_dash_boons_spec.md` §3.3（`DashEvent`）、`specs/20_engine_optimization_and_camera_spec.md` §2.1 I13 / §4.3（相机 / 冻结场景图契约 / 静态层惰性挂载先例）、`specs/21_hub_and_meta_progression_spec.md`（`SaveState` / hub / run 边界）、`docs/architecture/ADR-001-headless-ecs-foundation.md`、`docs/architecture/ADR-002-render-interpolation.md`、`docs/architecture/ADR-004-deterministic-prng.md` |
| Runtime | Node.js ≥ 22 · TypeScript（`strict` 全开 + `noImplicitOverride` / `noUncheckedIndexedAccess` / `exactOptionalPropertyTypes`）· Vitest（node 环境，`pool:'threads'`）· ESLint 9（flat config）· PixiJS 8.21 · howler 2.2 · Vite 5 |

---

## 1. 目的与范围

### 1.1 目的

到 M13 为止，一次命中的**全部**可感反馈都还停留在「世界状态本身」：掉血、跳字、受击闪光、击退。它们都是**持续状态**的可视化，没有一个是**瞬时冲击**的渲染——引擎明明已经在 `src/ecs/events.ts` 里把「一次命中落地」「一个实体死亡」「一次冲刺开始」发布成了显式的**事实**（`HitEvent` / `EntityDeathEvent` / `DashEvent`），但这些事实全部在**同一个 tick 内**被 `ModifierSystem` drain、被 `DeathSystem` clear，等到 `step()` 返回时总线已经空了。于是表现层**看不到**它们，游戏「打上去没手感」。

M14-T01 补上这一层，并且只用**客户端**的方式补：

1. **事件桥接（AC-01）**：在**不动 `src/` 一行**的前提下，让客户端能观察到引擎已经发布的三条事件。手段是 `TeeEventQueue<T> extends EventQueue<T>`——一个在 `emit` 时**先留一份客户端副本、再委派给基类**的「分接」队列。把三个这样的队列注入 `createDefaultSystems(hit, death, dash)`，管道**依然看到普通 `EventQueue`**（Liskov），语义逐字不变。
2. **屏幕震动（AC-02）**：命中时给相机叠加一个**衰减的随机偏移**，让打击有重量。无命中时偏移**恰好为 0**，相机与 M12 的跟随逐位一致。
3. **受击火花（AC-03）**：命中点炸出几根黄白色小线条，按「速度 + 阻力」散开、淡出、~180ms 内销毁。火花住在**世界空间**的一个**惰性挂载**层里——空闲态下场景图与 M14 之前**逐位相同**。
4. **音频管线（AC-01）**：三个**代码合成的占位音**（命中闷响 / 冲刺扫频 / 金币叮），经 **howler** 播放。零资源文件 ⇒ 零 404；无 `AudioContext` / 被自动播放策略拦截 ⇒ **静默降级**，绝不抛错。

> 一句话判据：**「桥接」让客户端看见引擎已经发布的事实、而引擎毫不知情；「震动 / 火花」把这些事实变成瞬时冲击；「音频」让冲击有声——三者的每一行都写在 `client/` 里。**

### 1.2 In Scope（做什么）

- **事件桥接**：`ClientEventBridge` + `TeeEventQueue<T>` + `FrameEvents`；三个 tee 队列注入管道；`drainFrame()`（每帧恰好一次）/ `clear()`（run 边界）。
- **屏幕震动**：`GameRenderer` 新增 `shakeTimeMs` / `shakeIntensity`；`syncWorld` 新增**可选第三参**（本帧事件）；`syncCamera` 在 lerp 结果上叠加衰减随机偏移；无命中恒为 0。
- **受击火花**：`VFXManager` 维护独立 `particleLayer`；命中在 `HitEvent.position`（判定圆中心，**像素化**）生成 6 根火花、冲刺生成 5 根；真实帧时间推进；层惰性挂载 / 摘除。
- **音频管线**：`AudioManager` 以 howler 播放三个**合成 WAV data URI** 占位音；`playHit()` / `playDash()` / `playCoin()`；静默降级；`setMuted` / `dispose`。
- **装配**：`main.ts` 建 `ClientEventBridge` → 注入管道 → `GameLoop(sim, renderer, input, bridge, audio)`；`GameLoop` 每帧 drain 一次并分发给渲染器与音频；run 边界（`onStartRun` / 数据热重载）清缓冲；金币音由**每帧读 gold** 驱动。

### 1.3 Out of Scope（显式排除）

- ❌ **不改 `src/` 任何一行**：管道恒 17 段、顺序不变；事件类型 / `EventQueue` / `GameSimulator` / `World` 全部零改动。**判据：`git diff --stat src/` 空输出。**
- ❌ **不新增 `GameSimulator.onFrameEnd` 回调**：那是把纯表现概念塞进 `src/core`，违背第一硬契约（§7 T1 记录被拒理由）。
- ❌ **不做真实音频资产**：只有代码合成的占位音；无 `assets/audio/*`、无加载器、无混音总线、无音乐。
- ❌ **不做屏幕震动的高级形态**：只有「位置随机偏移 + 线性衰减」，无方向性震动、无旋转震动、无 trauma 累积模型、无设置项。
- ❌ **不做粒子系统**：只有一种火花（命中）/ 一种尾焰（冲刺），无发射器、无贴图、无碰撞、无池化复用（每次命中新建、销毁即回收）。
- ❌ **不做死亡 / 金币火花**：死亡已有 M5 的淡出缩放 FX；金币只有**声音**、无粒子。
- ❌ **不做移动端 / 触摸音效解锁**：沿用 howler 的自动解锁，不自建手势监听。
- ❌ **不改任何既有测试断言**：采用惰性挂载路线（§7 T2），冻结契约零改动。

---

## 2. 术语与不变量

| 术语 | 定义 |
|---|---|
| **事件桥接（Event Bridge）** | 客户端对 `src/` 事件总线的**旁观者**：分接每条事件的一份副本，管道本身无感 |
| **Tee 队列（Tee Event Queue）** | `EventQueue<T>` 的子类；`emit` 时**先留副本、再委派**，两条消费者互不影响 |
| **帧事件（FrameEvents）** | 一个**渲染帧**累积的三类事件（命中 / 死亡 / 冲刺）；一帧最多跨 `MAX_STEPS_PER_FRAME=5` 个逻辑 tick |
| **屏幕震动（Screen Shake）** | 命中时叠加在相机跟随结果上的、随时间线性衰减的随机像素偏移 |
| **火花（Spark）** | 一个短 `Graphics` 线条；位置 + 速度 + 阻力 + alpha 淡出，~180ms 寿命 |
| **粒子层（Particle Layer）** | `VFXManager` 拥有的 `Container`；**惰性**挂入相机子树、空闲即摘除 |
| **占位音（Placeholder Sound）** | 启动时由代码合成 PCM、封成 WAV data URI 的极短音，交给 `new Howl(...)` |
| **静默降级（Silent Degradation）** | 无音频后端时所有音频方法 no-op，绝不抛错 |

### 2.1 不变量（I1 – I14）

- **I1 — 绝对单向依赖。** 逻辑层 `src/` **零改动**；`client/` 单向只读 `World`。事件桥接是**纯旁观者**：只保留引擎已发布事实的副本，不写任何逻辑状态。判据：`git diff --stat src/` 空输出。
- **I2 — 桥接是 Liskov 子类。** `TeeEventQueue<T>` **是** `EventQueue<T>`；注入 `createDefaultSystems` 后，管道的 `drain()` / `clear()` 语义**逐字不变**（基类队列照常被消费），客户端副本是**独立字段**，两者互不干扰。
- **I3 — 缓冲生命周期由客户端拥有。** `GameSimulator.restartRun` 的 `scheduler.reset()` 只能清到 `DeathSystem` / `ModifierSystem` 自己的总线，**触不到**客户端缓冲 ⇒ 必须在 **run 边界**显式 `clear()`（`onStartRun` / 数据热重载）。
- **I4 — 每帧恰好消费一次。** `GameLoop` 每渲染帧调用 `bridge.drainFrame()` **一次**，顺序在 `sim.step` **之后**（`syncFrame`），把同一份 `FrameEvents` 分发给渲染器与音频。
- **I5 — 无命中 ⇒ 震动恒为 0。** `shakeTimeMs <= 0` ⇒ `shakeIntensityAt()` **恰为** `0` ⇒ `syncCamera` **不加**任何偏移 ⇒ 相机与 M12 跟随逐位一致（spec 20 AC-03 的收敛断言保持）。
- **I6 — 粒子层惰性挂载。** 粒子层**仅当存在存活粒子时**挂入 `cameraContainer`（插在 `root` **之前**，故 `root` 恒为相机最后子节点）；粒子清空即**摘除**。空闲态下相机子节点集合与 M14 之前相同。
- **I7 — 粒子非 `Text`，且不入 `root` 子树。** 火花一律是 `Graphics`；粒子层挂在**相机**（非 `root`）之下，因此 `juice-verify` / `interpolation` 的 `allTexts(root)` 计数**不可能**被火花污染。
- **I8 — 表现层只用真实帧时间。** 火花寿命与震动衰减都读 `app.ticker.deltaMS`；**绝不回灌 `src/`**，`World` 的 `snapshot()` 不含任何视听状态。
- **I9 — 音频静默降级。** 无 `window` / 无 `Howl` / `AudioContext` 缺失 / 自动播放被拦截 ⇒ `AudioManager` 的每个方法 **no-op**，**绝不抛错**；构造失败时 `isAvailable === false`。
- **I10 — howler 隔离（结论不变，理由已更正）。** `howler` 只被 `AudioManager` 导入；`AudioManager` 只被 `main.ts` 导入；**`GameRenderer` 的导入图不含 howler**。`GameLoop` 只经**不含 howler** 的 `AudioSink` 接口与音频交互。
  - **真因（实测更正）**：`AudioManager` 曾引用**裸 DOM 全局 `window`**；若 `tests/**`（经 `GameRenderer`）传递导入它，则**无 DOM 的 `npm run typecheck`**（`lib: ["ES2022"]`）会报 **TS2304**。原表述「howler 在 import 期触碰 `window` 会炸」**经实测为假**——node 下 `howler` 可正常导入、`new Howl` 亦不抛（见 `tests/audio/audio_manager.test.ts`）。此后 `AudioManager` 已改用 `globalThis.window`（§3.3），TS2304 通路被消除，但**导入图隔离仍是硬约束**（设计纪律：howler 只属于音频通道）。
- **I11 — 占位音零 404。** 三个音在启动时以代码合成 PCM、封成 `data:audio/wav;base64,...`，**无任何网络 / 资源请求**。
- **I12 — 冻结场景图契约保持。** `stage` 唯一子节点为 camera、`root` 恒为 camera 最后子节点、`fxLayer` 恒为 `root` 最后子节点、`root.children[0]` 为首个实体视图——四条在**空闲态**逐位成立（spec 20 I13、§3.4 六条 F 契约）。
- **I13 — 相机收敛不受影响。** 无命中时 `camera.x` 精确收敛到 `screenWidth/2 − playerPx`（假 app 下即 `−playerPx`），`toBeCloseTo(..., 6)` 仍成立。
- **I14 — 加性可选签名。** `syncWorld(world)` 与 `syncWorld(world, alpha)` 的类型与行为**逐位不变**；`GameLoop` 的原三参构造**行为逐位不变**；新增参数全部**可选、默认 no-op**。

---

## 3. 数据结构

### 3.1 `client/ClientEventBridge.ts`

```ts
export interface FrameEvents {
  readonly hits: readonly HitEvent[];
  readonly deaths: readonly EntityDeathEvent[];
  readonly dashes: readonly DashEvent[];
}

export const EMPTY_FRAME_EVENTS: FrameEvents;   // 冻结的空帧常量

export class TeeEventQueue<T> extends EventQueue<T> {
  override emit(event: T): void;   // 先 push 客户端副本，再 super.emit
  drainFrame(): T[];               // 返回副本（新数组）并清空
  clearFrame(): void;              // 丢弃副本，不触碰基类
  get frameSize(): number;
}

export class ClientEventBridge {
  readonly hitQueue:   TeeEventQueue<HitEvent>;
  readonly deathQueue: TeeEventQueue<EntityDeathEvent>;
  readonly dashQueue:  TeeEventQueue<DashEvent>;
  drainFrame(): FrameEvents;       // 每帧恰好调用一次
  clear(): void;                   // run 边界
}
```

- **为什么是子类而不是新回调（§7 T1）**：`TeeEventQueue` 让 `src/` 零改动、类型上完全 Liskov 兼容，且 `GameSimulator` 不必新增任何概念。
- **`override` 关键字**：`noImplicitOverride` 要求覆写显式标注。
- **死亡总线的关键不对称**：`DeathSystem` 在**每 Tick 开头**对死亡总线调 `clear()`（`src/ecs/systems/DeathSystem.ts` §update）。`TeeEventQueue` **只覆写 `emit`**，`clear()` 走基类 ⇒ 基类队列被清空、**客户端副本保留**（`tests/render/juice_m14.test.ts` B 组钉桩）。

### 3.2 `client/VFXManager.ts`

```ts
export const SPARK_LIFETIME_MS = 180;

export class VFXManager {
  get layer(): Container;          // 惰性挂载 / 摘除的载体
  get hasParticles(): boolean;
  get particleCount(): number;
  spawnHitSparks(x: number, y: number): void;      // 6 根，全向
  spawnDashBurst(x, y, dirX, dirY): void;          // 5 根，朝冲刺反向
  advance(deltaMs: number): void;                  // 速度 + 阻力、alpha 淡出、过期销毁
  clear(): void;                                   // 清空粒子、保留层
  destroy(): void;                                 // 清空 + 摘除 + 销毁层
}
```

| 常量 | 值 | 含义 |
|---|---|---|
| `SPARK_COLOR` | `0xfff1a8` | 黄白色 |
| `SPARK_COUNT_HIT` / `SPARK_COUNT_DASH` | 6 / 5 | 每次命中 / 冲刺的火花数 |
| `SPARK_SPEED_MIN` / `MAX` | 70 / 160 px/s | 初速范围 |
| `SPARK_DRAG` | 0.86 | 每帧速度保留（阻力） |
| `SPARK_LENGTH_PX` / `THICKNESS_PX` | 5 / 1.5 | 火花体尺寸 |

- **坐标单位是像素**（不是世界单位）：`PX_PER_UNIT` 是渲染层的唯一常量，把它挡在 `VFXManager` 之外既避免第二份拷贝、也避免 `GameRenderer ⇄ VFXManager` 循环导入。调用方（`GameRenderer`）负责 `* PX_PER_UNIT`。
- **`Math.random` 在此合法**：`client/**` 不受 `src/**` 的 AST 门约束；随机性绝不进入模拟（I8）。

### 3.3 `client/AudioManager.ts`

```ts
export class AudioManager {
  get isAvailable(): boolean;
  playHit(): void;
  playDash(): void;
  playCoin(): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}
```

| 占位音 | 合成 | 时长 |
|---|---|---|
| `playHit` | 220→60 Hz 下沉 + 噪声，指数包络 | 0.12s |
| `playDash` | 200→1200 Hz 上升扫频，sin 窗 | 0.15s |
| `playCoin` | 1000 Hz 正弦，指数包络 | 0.10s |

- 合成产物是**单声道 16-bit PCM WAV**，编码为 `data:audio/wav;base64,...`（`encodeWavDataUri`），交给 `new Howl({ src: [dataUri], format: ['wav'] })`。采样率 22050。
- `build()` 把整段构造包在 `try/catch` 里；`typeof (globalThis as { window?: unknown }).window === 'undefined' || typeof Howl === 'undefined'` ⇒ `available: false`。每个播放方法先查 `available` / `muted`，再各自 `try/catch`。
- **为什么是 `globalThis.window` 而不是裸 `window`**：裸 DOM 全局在**无 DOM 的 `npm run typecheck`**（`lib: ["ES2022"]`）下是 **TS2304**——一旦 `tests/**` 传递导入本模块即报错。`globalThis.window` 在浏览器里**就是** `window`，因此**行为等价**，且能被 DOM-less 环境正常类型检查（这是 I10 真因的直接修复）。

### 3.4 `GameRenderer` 常量与 `GameLoop` 缝

```ts
const SHAKE_DURATION_MS = 180;   // 命中后震动时长（真实 ms）
const SHAKE_INTENSITY = 6;       // 命中瞬间的峰值偏移（px）
```

```ts
// client/GameLoop.ts —— 不含 howler 的结构化接口
export interface AudioSink {
  playHit(): void;
  playDash(): void;
  playCoin(): void;
}
constructor(sim, renderer, input, bridge: ClientEventBridge | null = null, audio: AudioSink | null = null);
```

- `AudioManager` **结构上**满足 `AudioSink`，但**不导入**它（避免任何把 howler 拖进 `GameLoop` 的可能）。

---

## 4. 语义

### 4.1 AC-01 —— 事件桥接与音频桥接

**装配**：

```
main.ts:
  bridge = new ClientEventBridge()
  sim = new GameSimulator({ systems: createDefaultSystems(bridge.hitQueue, bridge.deathQueue, bridge.dashQueue), … })
  audio = new AudioManager()
  loop = new GameLoop(sim, renderer, input, bridge, audio)
```

**每帧（`GameLoop.syncFrame`，在 `sim.step` 之后）**：

```
events = bridge.drainFrame()          // 恰好一次
audio.playHit() × events.hits.length
audio.playDash() × events.dashes.length
renderer.syncWorld(world, alpha, events)
```

**run 边界清缓冲**：`onStartRun`（`restartRun` 之后）与数据热重载 `onReload`（`renderer.reset()` 同侧）都调 `bridge.clear()`。理由（I3）：`restartRun` 的 `scheduler.reset()` 清的是 `DeathSystem` / `ModifierSystem` 的总线，**客户端缓冲不在 scheduler 内**，若不显式清，重启后会把「引用已被销毁实体」的事件重放到新局。

**金币音**：引擎**没有**「拾取」事件总线，因此金币音由 `main.ts` 的 `installCoinChime` **每帧读 `readGold(world)`** 驱动——`gold` 上升即响（§7 T4）。这是与 HUD 同一处的纯读。

**为什么 `emit` 里「先副本、后委派」**：管道在 `emit` 之后立刻可能 `drain()`（`ModifierSystem`）或 `clear()`（`DeathSystem`），所以副本必须在 `super.emit` **之前**留下，否则 `drain` 之后基类数组已被换新，副本就取不到了。

### 4.2 AC-02 —— 屏幕震动

`syncWorld` 新增**可选第三参** `frameEvents?: FrameEvents`（I14：单参 / 双参调用类型与行为逐位不变）。帧内新增相位：

```
syncEffects(deltaMs, frameEvents):
  1. advanceShake(deltaMs)          // shakeTimeMs -= deltaMs（到 0 截断）
  2. vfx.advance(deltaMs)           // 先老后生：新火花从满血开始
  3. for hit in frameEvents.hits:
       vfx.spawnHitSparks(hit.position * PX_PER_UNIT)
       shakeTimeMs = SHAKE_DURATION_MS; shakeIntensity = SHAKE_INTENSITY
     for dash in frameEvents.dashes:
       vfx.spawnDashBurst(...)
  4. syncVfxLayer()                 // 挂 / 摘粒子层
```

`syncCamera`（在 `syncEffects` **之后**、故本帧命中本帧生效）：

```
camera.x += (targetX - camera.x) * CAMERA_LERP_FACTOR      // 既有 lerp，逐字不变
camera.y += (targetY - camera.y) * CAMERA_LERP_FACTOR
shake = shakeIntensityAt()                                  // = 0 when shakeTimeMs<=0
if (shake > 0):                                             // 无命中 ⇒ 整段跳过
  camera.x += (Math.random() - 0.5) * shake
  camera.y += (Math.random() - 0.5) * shake
```

`shakeIntensityAt() = shakeIntensity * (shakeTimeMs / SHAKE_DURATION_MS)`，`shakeTimeMs <= 0` 时**返回硬 0**（I5/I13）。

**为什么震动的顺序在 `syncCamera` 之前**：`syncEffects` 在**本帧**把 `shakeTimeMs` 重新拉满，`syncCamera` 随后采样 ⇒ 命中的视觉冲击**同帧**可见，而不是下一帧。

**为什么无命中时必须是硬 0**：`tests/render/camera_follow.test.ts` / `camera_adversarial.test.ts` 有「连续 N 帧后 `camera.x` 收敛到 `screenWidth/2 − playerPx`」的 `toBeCloseTo(..., 6)` 断言。只要无命中时偏移恰为 0，跟随 lerp 就与 M12 逐位一致，断言原样通过。

### 4.3 AC-03 —— 受击火花与惰性挂载

**新场景图（空闲态 = 与 M14 之前逐位相同）**：

```
app.stage
 └─ camera (Container)
     ├─ staticLayer (Container)      // 惰性；仅「世界有墙」时存在（camera 索引 0）
     ├─ particleLayer (Container)    // 惰性；仅「存在存活火花」时存在（插在 root 之前）
     └─ root (Container)
         ├─ view[0..n]
         └─ fxLayer                  // 恒为 root 最后子节点
```

- `syncVfxLayer()`：`hasParticles` ⇒ `cameraContainer.addChildAt(layer, max(0, children.length-1))`（插在 `root` **之前**，`root` 保持最后子节点）；否则 `removeChild(layer)`。
- **为什么插在 `root` 之前**：让火花画在**地板 / 墙体之上、实体视图之下**；同时 `root` 恒为相机最后子节点（spec 20 I13 / F2），`camera.children[last]` 恒为 `root`（各套件的 `renderRoot` 助手不变）。
- **为什么惰性**（§7 T2，路线 **(a)**）：常驻的新节点会撞上 F1–F6 之一；惰性挂载让**空闲态**（既有测试的**唯一**状态——既有测试从不传第三参，故从不产生火花）场景图**逐位不变**，无需改动任何既有断言。先例：`staticLayer` 的惰性挂载 / 拆除（spec 20 §4.3）。
- **火花原点**：`HitEvent.position` 是**判定圆中心**（spec 05 §3.1），本 spec **采用判定圆中心**（§7 T3）；`VFXManager` 因此**不需要 `World` 引用**，保持与逻辑层解耦。

### 4.4 管道与契约

- **管道恒 17 段**、顺序不变：M14-T01 **不新增 / 不重排任何段**，只把三个 tee 队列作为既有三总线的**注入实例**（`src/ecs/systems/pipeline.ts` 的签名与实现**零改动**）。
- **`syncWorld` 相位顺序**（新增项以 ▲ 标注）：
  `syncStaticGeometry → createMissingViews → syncTransforms → ▲syncEffects → syncCamera → syncHazards → advanceFloatingTexts → detectDamage → advanceDeaths → recycleDestroyed`。
- **`reset()` / `destroy()`**：`reset()` 归零 `shakeTimeMs` / `shakeIntensity`、`vfx.clear()`、`syncVfxLayer()`（摘层）；`destroy()` 先 `vfx.destroy()`（会自行摘除）再 `cameraContainer.destroy({children:true})`，避免对粒子层重复销毁。
- **`GameLoop` 加性可选**：`bridge === null` ⇒ `syncWorld(world, alpha)`（原行为）；`audio === null` ⇒ 不播音。

---

## 5. 验收标准

| ID | 验收标准 | 证据 |
|---|---|---|
| **AC-01** | 事件桥接 + 音频桥接：`src/` 零改动（`git diff --stat src/` 空）；三个 tee 队列注入管道后生产/消费语义逐字不变；每帧 drain 一次、run 边界 clear；howler 只被 `AudioManager` 导入、`GameRenderer` 导入图不含 howler；三个占位音以 data URI 合成、零 404；无后端时静默降级 | `juice_m14.test.ts` B 组（6 例）+ `audio_manager.test.ts`（4 例）+ `typecheck:client` + `vite build`（bundle 含 howler / data URI） |
| **AC-02** | 屏幕震动：命中拉满、线性衰减到**恰为 0**、无命中恒为 0；**命中确实位移相机**（非仅武装）；单参 / 双参 `syncWorld` 逐位不变；相机收敛断言保持 | `juice_m14.test.ts` S 组（3 例）+ 既有 `camera_follow` / `camera_adversarial` / `renderer_bridge` / `interpolation` / `juice-verify` 全绿 |
| **AC-03** | 受击火花：命中 6 根 / 冲刺 5 根、`Graphics` 非 `Text`、世界空间惰性挂载、寿命后层摘除、空闲态场景图与 M14 前逐位相同 | `juice_m14.test.ts` P 组（5 例）+ G 组（3 例，惰性挂载对抗） |
| **AC-04** | 装配与单向依赖：`main.ts` 注入 bridge / audio；`GameLoop` 加性可选；run 边界清缓冲；ESLint AST 门（`src/**`）零放宽 | `typecheck:client` + `typecheck` + `lint` 全通过；`GameLoop` / `main` 未被 node 测试导入 |
| **AC-05** | 零回归：既有 **613** 用例全绿；新增 **21** 用例（`juice_m14` 17 + `audio_manager` 4）后共 **634** 全绿；无任何既有测试断言被修改 | `npm test` → `35 files / 634 passed` |

---

## 6. 测试契约

### 6.1 `tests/render/juice_m14.test.ts`（新增，17 例）

- **B 组 · 事件桥接（6）**：`TeeEventQueue` 既留副本又喂基类；死亡总线 `clear()` 后副本仍在；`drainFrame` 三总线扇出并清空、二次 drain 为空；`bridge.clear()` 只清副本、不碰基类；**端到端**——真实 `GameSimulator` + tee 队列，一次真实命中后 `bridge.hitQueue.size === 0`（管道仍消费）而 `events.hits.length === 1`（客户端看见），并把该事件的每个字段**钉成字面量**（`attackerId 0` / `targetId 1` / `hitboxEntityId 2` / `position.x 0.75` / `position.y 0` / `damage 10` / `sourceModifier null`），渲染器随即 `sparkCount === 6` / `shakeTimeRemainingMs === 180`；**转发证明**——`zeus_strike` 词缀仍会触发（`sourceModifier` 序列 `[null, 'zeus_strike']`），若 `emit` 不再 `super.emit` 则该断言失败。
- **S 组 · 屏幕震动（3）**：命中拉满 180ms、9 帧（180/20）衰减到 0、随后相机精确收敛（`toBeCloseTo(…, 6)`）；空帧 / 单参 `syncWorld` 均保持静止；**位移钉桩**——`Math.random` 固定为 0 ⇒ `camera.x/y toBeCloseTo(-6, 9)`（关掉 `syncCamera` 的 shake 叠加即失败）。
- **P 组 · 火花（5）**：命中 6 根且挂在**非 root** 的相机子节点、`root` 仍为最后子节点、每个火花是 `Graphics`、`allTexts(root)` 为 0；冲刺 5 根；寿命后层摘除、`camera.children` 回到长度 1；`fxLayer.children` 恒为 0；`reset()` 清火花与震动。
- **G 组 · 惰性挂载对抗（3）**：**G-B** 惰性层与静态层**两序交叉**（先粒子后墙 / 先墙后粒子 ⇒ 恒 `[static?, particle?, root]`，`root` 恒最后）；**G-C** 六轮 spawn→expire **不累积 / 不泄漏容器**（同一 `Container` 每轮复挂）；**G-D** 有墙时 `reset()` 只留 `root`、粒子层仍挂载时 `destroy()` 清空 stage。

> 其中**独立验证（quality-lead）**在工程首版的 12 个用例基础上**追加 5 例**（tee 转发 e2e / 位移钉桩 / G-B / G-C / G-D），并**强化 1 例**（真实命中 e2e 的字段字面量钉桩），合计 **17** 例。

### 6.2 既有套件（**零改动**）

采用惰性挂载路线（§7 T2），F1–F6 六条冻结契约在空闲态逐位成立，**未修改任何既有断言**：

| 契约 | 出处 | 状态 |
|---|---|---|
| F1 `stage.children` 长度 1 且 `[0]===camera` | `camera_follow` / `camera_adversarial` | 未改 |
| F2 `camera.children[last]===root` | `camera_follow` / `camera_adversarial` | 未改 |
| F3 `root.children[last]===fxLayer` | `interpolation` / `juice-verify` / `camera_adversarial` | 未改 |
| F4 `root.children[0]` = 首个实体视图 | `interpolation` / `renderer_bridge` | 未改 |
| F5 无墙时 `camera.children` 长度 1 | `camera_follow` / `camera_adversarial` | 未改 |
| F6 空闲时 `fxLayer.children` 长度 0 | `juice-verify` / `interpolation` | 未改 |

### 6.3 音频覆盖（已从「零覆盖」变为「已覆盖」）

`AudioManager` 的**静默降级**（I9）**已被 node 测试覆盖**：`tests/audio/audio_manager.test.ts`（4 例，node 环境、**无 jsdom**）对**真实** `AudioManager` 钉桩：

- 无 `window`（node 环境）⇒ `isAvailable === false`；
- 无后端时 `playHit` / `playDash` / `playCoin` / `setMuted` 全部 no-op 且**绝不抛错**（I9）；
- `dispose()` 可安全调用两次；
- 有 `window` 但无真实音频后端时，构造与每个调用仍不抛错（`try/catch` 韧性）。

> 首版 spec 断言「`AudioManager` 不在 node 测试里、因为 howler 会在 import 期因 `window` 炸」——**该前提经实测为假**，且把 I9 这条「最不能出错」的契约留成了零覆盖。本文件已把该空洞关闭（并更正 I10 的理由，§2.1）。

**仍然存在的空洞**只剩一条：**真实播放需要浏览器的 `AudioContext`**（三个 `data:audio/wav;base64` 占位音与活的 Howl 连线是浏览器专属，node 无 jsdom 无法验证）。其证据是 `npm run typecheck:client` 通过 + `npm run build` 通过，且 bundle 中检出 howler 标记与 `data:audio/wav;base64` 字面量。

**测试纪律**（沿用仓库既有约定）：真实 `GameSimulator` + 真实 `createDefaultSystems()`，不 mock；浮点容差 `1e-9`；断言值一律**字面量**（如 `180` / `6` / `5`）。

---

## 7. 已知取舍（Known Trade-offs）

| ID | 取舍 | 后果 / 缓解 |
|---|---|---|
| **T1** | **事件桥接选 `TeeEventQueue` 子类，而非 `GameSimulator.onFrameEnd` 回调** | 回调会向 `src/core` 注入一个纯表现层概念，违背第一硬契约。子类方案让 `src/` 零改动、Liskov 兼容、`GameSimulator` 不新增概念。代价：客户端多一层缓冲，且缓冲**不在** `scheduler.reset()` 覆盖范围内 ⇒ 必须自己管 run 边界（I3 / §4.1） |
| **T2** | **粒子层选「惰性挂载」（路线 a），而非「常驻 + 同步钉桩」（路线 b）** | 常驻新节点会撞上 F1–F6 之一，需改 `camera_follow` / `camera_adversarial` / 三套件 `renderRoot` 助手等 **5 处**断言。惰性挂载让空闲态场景图逐位不变、既有断言零改动。代价：粒子层挂 / 摘有极小开销，且**画在实体之下**（不能盖住实体）。**产品方已明确接受该代价并给出理由**：2D 俯视角下，打击火花若完全遮挡实体，会让玩家看不清敌人的**抬手动作**（windup 前摇）——即遮挡伤害可读性。故「画在实体之下」不只是约束下的妥协，也是正确的动作可读性选择 |
| **T3** | **火花原点取 `HitEvent.position`（判定圆中心），而非目标 `TransformComponent`** | 判定圆中心是事件自带、恒有效（目标可能已销毁）；取目标坐标需把 `World` 拖进 `VFXManager`，破坏其解耦。代价：火花从挥击判定圆心（约等于命中处）而非严格「贴在敌人身上」 |
| **T4** | **金币音无事件总线，改用「每帧读 gold」观察** | 引擎没有拾取事件，唯一诚实信号是钱包本身。与 HUD 同源的纯读、绝不写 `World`。代价：金币音与「拾取」不是严格一一对应（一次性 +50 只响一声），可接受 |
| **T5** | **占位音走「代码合成 WAV data URI + `new Howl`」，而非裸 `OscillatorNode`** | data URI 让 howler 成为**真实**依赖（拥有加载 / 静音 / 音量 / 播放），且零资源文件 ⇒ 零 404。代价：启动时多做几毫秒合成、data URI 略增 bundle |
| **T6** | **震动偏移直接叠加在 lerp 结果上（而非独立 base 状态）** | 无命中时偏移恰为 0 ⇒ 与 M12 逐位一致。震动期间 lerp 的状态被随机偏移「污染」，但震动是瞬态（~180ms）且随后自动收敛。代价：震动与跟随轻微耦合（可接受，且换来最小改动） |
| **T7** | **火花速度阻尼与帧率耦合（每帧 `*= 0.86`）** | 效果仅 ~180ms，帧率耦合不可见；一次乘法比指数阻尼更省、更可预测。代价：非 60fps 下阻力手感略有差异 |
| **T8** | **`shakeIntensityAt` 硬截断为 0（线性衰减）** | 保证「无命中 ⇒ 硬 0」这条 bit-exact 契约（相机收敛断言的前提）。代价：震动结束略有「顿感」，非平滑曲线 |

---

## 8. 失败模式（Failure Modes）

| ID | 失败模式 | 为何不会发生 / 如何被捕获 |
|---|---|---|
| **F1** | 桥接把 `src/` 拖下水（改 `src/` 或放宽规则） | 只新增 `client/` 文件 + `createDefaultSystems` **注入**；`git diff --stat src/` 空 + ESLint AST 门是判据 |
| **F2** | howler / `AudioManager` 进入 `GameRenderer` 的导入图 | `AudioManager` 只被 `main.ts` 导入；`GameLoop` 只经 `AudioSink`；`GameRenderer` 只导入 `VFXManager`（纯 pixi）。真因是 `AudioManager` 的裸 DOM 全局引用会被 `tests/**` 传递导入、破坏**无 DOM 的 `npm run typecheck`**（TS2304，§2.1 I10）——**不是**「howler 在 import 期炸」（实测为假） |
| **F3** | 客户端缓冲在重启后重放「引用已销毁实体」的陈旧事件 | run 边界（`onStartRun` / 热重载）显式 `bridge.clear()`（I3） |
| **F4** | 一帧内多次 `drainFrame()` ⇒ 事件丢失 / 重复 | `GameLoop.syncFrame` 每帧**恰好** drain 一次并复用同一份 `FrameEvents`（I4） |
| **F5** | 无命中却仍有微小震动 ⇒ 相机收敛断言失败 | `shakeIntensityAt()` 在 `shakeTimeMs<=0` 时**返回硬 0**，`syncCamera` 整段跳过偏移（I5/I13） |
| **F6** | 粒子层常驻 ⇒ 撞坏 F1–F6 冻结契约 | 惰性挂载：仅存活粒子时存在、插在 `root` 之前、清空即摘除（I6/I12） |
| **F7** | 火花被算成 `Text` ⇒ `juice-verify` 跳字计数失败 | 火花一律 `Graphics`，且挂在**相机**（非 `root`）之下，`allTexts(root)` 不可能看到（I7） |
| **F8** | 音频后端缺失 / 自动播放被拦截 ⇒ 抛错中断游戏 | `build()` 整体 `try/catch`；每个播放方法先查 `available` 再各自 `try/catch`；`available:false` ⇒ no-op（I9） |
| **F9** | 占位音触发 404 / 资源加载失败 | 全部是代码合成的 data URI，零网络请求（I11） |
| **F10** | 三参 `syncWorld` 破坏既有单参 / 双参调用 | 第三参**可选**且默认 `undefined`；`bridge===null` 走原 `syncWorld(world, alpha)`；既有套件未传第三参 ⇒ 逐位不变（I14） |
| **F11** | `destroy()` 对粒子层重复销毁 | `vfx.destroy()` 先自行摘除层，再 `cameraContainer.destroy`；`reset()` 只 `clear()`（保留层） |
| **F12** | 金币音在无钱包世界抛错 | `readGold` 无钱包返回 `0`；`playCoin` 在 `available:false` 时 no-op |
| **F13** | **变异实验 M1 曾暴露一个真实测试空洞**：把 `syncCamera` 里的 shake 叠加整段关掉后，**没有任何断言失败** | 「命中 ⇒ `shakeTimeRemainingMs === 180`」「衰减到 0」「随后重新收敛」三组断言只证明震动被**武装 / 衰减**，不证明它真的被**加到相机上**。已由独立验证补上的**位移钉桩**（`Math.random` 固定为 0 ⇒ `camera.x/y toBeCloseTo(-6, 9)`，`juice_m14.test.ts` S 组）堵上：关掉叠加后该断言**立即失败**。这条空洞是本次独立验证最有价值的产出，留档以免回归 |

---

## 9. 追溯表（Traceability）

| 需求 | 不变量 | 语义 | 验收 | 测试 |
|---|---|---|---|---|
| 事件桥接 + 音频桥接 | I1 I2 I3 I4 I9 I10 I11 | §3.1 §3.3 §4.1 | AC-01 | `juice_m14` B 组 + `audio_manager`（4 例）+ `typecheck:client` + `vite build` |
| 屏幕震动 | I5 I8 I13 I14 | §3.4 §4.2 | AC-02 | `juice_m14` S 组 + 五套件同步 |
| 受击火花 | I6 I7 I8 I12 | §3.2 §4.3 | AC-03 | `juice_m14` P 组 + G 组 |
| 装配与单向依赖 | I1 I4 I10 I14 | §4.1 §4.4 | AC-04 | `typecheck:client` / `typecheck` / `lint` |
| 零回归 | （spec 09 / 10 / 20 冻结契约） | §4.4 §6.2 | AC-05 | `npm test` → 634 全绿 |

---

## 10. 参考

- `src/ecs/events.ts`（`HitEvent` / `EntityDeathEvent` / `DashEvent` / `EventQueue`）
- `src/ecs/systems/pipeline.ts`（17 段管道 / 三总线注入点）
- `src/core/GameSimulator.ts`（`restartRun` 的 `scheduler.reset` / run 边界）
- `src/ecs/systems/DeathSystem.ts`（每 Tick 开头 `clear()` 死亡总线）
- `specs/09_renderer_bridge_spec.md` §4.3 / §4.4（`stage` / `root` / `fxLayer` 契约、单向依赖门）
- `specs/10_render_juice_spec.md` §4（插值 / 跳字 / `fxLayer` 冻结契约）
- `specs/20_engine_optimization_and_camera_spec.md` §2.1 I13 / §4.3（相机 / 冻结场景图 / 静态层惰性挂载先例）
- `specs/21_hub_and_meta_progression_spec.md`（`SaveState` / hub / run 边界）
- `docs/architecture/ADR-001-headless-ecs-foundation.md`（无 DOM / 无随机 / 无墙钟）
- `docs/architecture/ADR-002-render-interpolation.md`（渲染插值）
- `docs/architecture/ADR-004-deterministic-prng.md`（单流 PRNG / 确定性）
- howler（https://howlerjs.com/）· `@types/howler`
