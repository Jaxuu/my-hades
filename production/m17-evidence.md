# M17 · 相机缩放与视口自适应 —— 验收证据

**Feature**: `specs/025-camera-zoom-viewport` · **Tasks**: T029–T033 · **Date**: 2026-10-02
**对照基线**: [`m17-baseline.md`](./m17-baseline.md)（改动前 `539d96a`）

---

## 0 结论速览

| 项 | 结果 |
|---|---|
| 五道闸门 | ✅ **全绿**（`test` / `typecheck` / `typecheck:client` / `lint` / `build`） |
| 测试 | ✅ **893 passed / 58 files**，失败 0、跳过 0（基线 803 + **新增 90**） |
| 逻辑内核 | ✅ `git diff --stat src/` **空** |
| 既有测试 | ✅ `git status --porcelain tests/` **只显示 8 个新增文件**，零改动 |
| 管道 | ✅ 仍 **17 段**；`grep -rl "'TransformSnapshotSystem'" tests/` = **13**（= 基线） |
| 场景图冻结契约 | ✅ F1–F6 逐条不变（既有 13 套件零改动 + 新增 9 例缩放激活路径复验） |
| SC-001 / 002 / 005 / 008 | ✅ **真浏览器像素实测**：5 种视口下房间短边占视口短边 **恒 80.0%**，居中到像素 |
| SC-003 | ✅ **真浏览器 DOM 实测**：HUD 几何在 5 种视口下**逐位相同** |
| SC-004 | ✅ 状态摘要 `f52dfdd4` 逐位相同（`zoomActive` 601/601 帧、`z = 2.880`） |
| SC-006 | ✅ 803 例零改动全绿 |
| SC-007 | ✅ 性能比值**中位数 0.993**（预算 1.2） |
| SC-009 | ✅ 震动偏移在 `z=8.64` 与 `z=1` 下**完全相同**（15.000 px），无漂移 |

**唯一未闭环项**：SC-002 / SC-009 的**主观观感判定**需要**人类观察者**（见 §4、§10）。机器可判定的部分已全部完成。

---

## 1 五道闸门（改动后）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `NO_COLOR=1 npm test` | ✅ **893 passed / 58 files**，失败 0 |
| 2 | `NO_COLOR=1 npm run typecheck` | ✅ 通过（无输出） |
| 3 | `NO_COLOR=1 npm run typecheck:client` | ✅ 通过（无输出） |
| 4 | `NO_COLOR=1 npm run lint` | ✅ 通过（无输出） |
| 5 | `NO_COLOR=1 npm run build` | ✅ `✓ built in 10.31s` |

### 1.1 ⚠️ 期间发现并解决的**真实交付问题**：新测试的 CPU 争用打翻了既有性能断言

`tests/performance/stress.test.ts` G2（M15，**纯 `src/` 套件，不含任何 `client/` import**）断言
「300 敌 / 50 敌」的墙钟耗时比值 `< 9`（典型 ~7.1）。它自身对邻居负载敏感（M16 报告已登记该风险）。

**诊断链（每一步都有实验支撑）**：

1. **观测**：加入 M17 的 8 个新套件后，全量运行时 G2 失败率 **4/5**（ratio 9.84 / 10.21 / 10.14 / 12.45）。
2. **隔离**：把 8 个新套件**移出**后再跑全量 ⇒ **803/803 通过两次**（ratio 5.99 / 7.83）。
   ⇒ 失败**确由新套件的 CPU 争用引起**，不是 `src/` 回归（`src/` 零改动、该套件不 import `client/`）。
3. **归因**：比值分母（50 敌 ≈ 250 ms）在两态下相当，而分子（300 敌）从 ~1990 ms 涨到 ~2700 ms（**+36%**）
   —— 长的那个测量窗口**成比例地更容易撞上被争用的时段**，于是比值被系统性抬高。
4. **两处处置**：
   - **削减新套件的 CPU 足迹**：
     `camera_zoom_lossless` 原本为同一测量跑 **4 次** 601-Tick × 150 敌脚本；改为**一次测量**，
     并把「未渲染对照」换成 **M15/M16 已独立算出、且既有 `render_art_lossless.test.ts` 每次都在断言的
     摘要字面量 `f52dfdd4`** ⇒ 成本 3.19 s → **1.44 s**，而证明强度**不降反升**（对照由另一个里程碑在另一天算出）。
     `camera_zoom_room_mode` 的收敛帧数与行走步数按数学下限收紧（`0.8^n` 收敛到 1 ULP 需 ~158 帧 ⇒ 取 250）⇒ 417 ms → 234 ms。
   - **限制 worker 池并发**（`vitest.config.ts`）：默认 `maxThreads` = 核数（本机 8）⇒ 8 个 worker **加**主进程
     把 CPU 打满，而那正是该断言被测量的环境。改为 `maxThreads = floor(可用并行度 / 2)`（本机 4），
     留出余量。**未改动任何断言**（FR-017 不受影响）。
5. **复测**：全量连跑 **6 次全部绿**，ratio 7.14 / 7.31 / 6.20 / 8.90 / 8.28 / 7.04（分子回到 ~1750–2230 ms）。
   代价：全量墙钟 ~20.5 s → **~26–30 s**（约 +30%）。

> **教训（已登记进 `INVARIANTS.md`）**：**新增测试本身会改变既有性能断言的通过率**。
> 「既有测试零改动」**不等于**「既有测试零影响」——墙钟类断言需要一个不被自我争用打满的测量环境。

> 另：`production/m17-probe.mjs`（浏览器验收工具，Node 侧脚本）会触发 `no-undef`（`process` / `Buffer` /
> `fetch` / `console` 不在浏览器配置里）⇒ 在 `eslint.config.mjs` 的 `ignores` 中**精确**加入
> `production/**/*.mjs`（**不**整目录忽略，未来的 `.ts` 仍会被 lint；**未**触碰任何 `src/` 规则块）。

---

## 2 核心合规检查（quickstart §2）

```console
$ git diff --stat src/
(空输出)                                    ← ✅ 逻辑内核零改动

$ grep -rl "'TransformSnapshotSystem'" tests/ | wc -l
13                                          ← ✅ 与基线一致（tasks.md 原写「9」为 M16 时口径，见 baseline §3）

$ git status --porcelain tests/
?? tests/harness/camera_zoom_lossless.test.ts
?? tests/render/camera_zoom_{degradation,fit,resize,room_mode,scene_graph,screen_space,sharpness}.test.ts
                                            ← ✅ 只有新增，既有文件零改动
```

`client/` 新增 import 仅两处：`isInHub`（`src/`，只读，方向合法）与 `TextureSource`（pixi.js）。
`src/` 中**无任何** `client` 引用（ESLint AST 门 + `grep` 双证）。

---

## 3 既有测试零回归（quickstart §3 · SC-006 / FR-017）

- 全量 **894 passed**，其中**既有 803 例逐字未动**。
- 最脆弱的三条断言全部原样成立：
  - `camera_follow` G2 / `camera_adversarial` C1 —— `toBeCloseTo(…, 6)` 跟随收敛（无 `screen` ⇒ `z = 1`）；
  - `camera_adversarial` C4 —— 带 `screen`(800×600) **无墙** ⇒ `camera.x ≈ 385`（退化路径）；
  - `camera_follow` G3 / `tilemap_art` —— 墙块 `x === wall.x × PX_PER_UNIT`（局部坐标不随 `z` 变）。

---

## 4 视觉验收（真浏览器 · SC-001 / SC-002 / SC-008）

**方法**：`production/m17-probe.mjs` —— 用**缓存的 Playwright Chromium**（`chromium-1243`）经 **CDP**
（Node 22 内置 `WebSocket`，零依赖）以**真实时间**驱动（headless Chrome 的 `--virtual-time-budget`
无法让异步启动 + rAF ticker 完成，已实测失败）。每个视口**独立重新加载页面**（跨 3840×1080 → 1080×1920
的原地 resize 会让 SwiftShader 丢失画布，已实测）。

**测量**：隐藏 DOM（`#ui-layer` / `#hud` / `#gold` / `#keys`）后截图，在 Node 中**解码 PNG**
（自写最小解码器：`zlib.inflateSync` + 反滤波）求「非清屏色像素」的包围盒 ⇒ 即**房间的屏幕矩形**。

| 视口 | 房间矩形 | 房间中心 vs 视口中心 | 房间短边 / 视口短边 | 完整可见 | 预期 `z` |
|---|---|---|---|---|---|
| 1920×1080 | **864×864** @ (528,108) | (960.0, 540.0) = (960.0, 540.0) | **80.0%** | ✅ | 8.64 |
| 2560×1440 | **1152×1152** @ (704,144) | (1280.0, 720.0) = (1280.0, 720.0) | **80.0%** | ✅ | 11.52 |
| 3840×1080（32:9） | **864×864** @ (1488,108) | (1920.0, 540.0) = (1920.0, 540.0) | **80.0%** | ✅ | 8.64（**高度受限**） |
| 1080×1920（9:16） | **864×864** @ (108,528) | (540.0, 960.0) = (540.0, 960.0) | **80.0%** | ✅ | 8.64（**宽度受限**） |
| 800×600 | **480×480** @ (160,60) | (400.0, 300.0) = (400.0, 300.0) | **80.0%** | ✅ | 4.8 |

- **SC-001**：1920×1080 下 80.0% ∈ [55%, 85%] ✅；房间**完整可见、居中到像素**（裁剪/溢出 = 0）。
- **SC-002**：2560×1440 下同样 80.0% ✅（与 1080p 观感一致）。
- **SC-008**：32:9 与 9:16 下均**以受限方向 fit**、完整可见 ✅（32:9 用高度、9:16 用宽度，实测与推导一致）。
- 像素级吻合：`100 世界单位 × 10 px × z` = 864 / 1152 / 480，与实测**完全相等**。
- 页面控制台：`[assets] 35 assets ready`、**零 exception**、零站外请求。

**截图**（`production/m17-shots/`，DOM 隐藏后仅画布内容）：`v1-1920x1080.png` · `v2-2560x1440.png` ·
`v5a-32x9-3840x1080.png` · `v5b-9x16-1080x1920.png` · `v6-800x600.png`。

**观察者协议（SC-002 主观判定）**：
- 客观部分（房间大小 / 居中 / 完整可见 / 像素吻合）**已由上表机器判定**。
- **「房间大小合适、内容清晰可读」的观感判定 = PENDING**：需要 **≥1 名人类观察者**在真机上按
  [quickstart §4](./quickstart.md) 对照**改动前截图**做二值判定。本报告**不代替**该判定。
  复现命令：`NO_COLOR=1 npm run dev` → `http://localhost:5173`；或直接跑
  `node production/m17-probe.mjs`（需先起 dev server）。

---

## 5 HUD / 覆盖层跨倍率不变（quickstart §5 · SC-003 / FR-006 / FR-007）

**方法**：同一次真浏览器会话中，对每个视口读 `getBoundingClientRect()`。

| 视口 | `#hud` | `#gold` | `#gold` 右内边距 |
|---|---|---|---|
| 1920×1080 | **207.547×145.000 @ (12.000,12.000)** | **141.594×70.000** @ (1766.406,12.000) | **12.000** |
| 2560×1440 | **207.547×145.000 @ (12.000,12.000)** | **141.594×70.000** @ (2406.406,12.000) | **12.000** |
| 3840×1080 | **207.547×145.000 @ (12.000,12.000)** | **141.594×70.000** @ (3686.406,12.000) | **12.000** |
| 1080×1920 | **207.547×145.000 @ (12.000,12.000)** | **141.594×70.000** @ (926.406,12.000) | **12.000** |
| 800×600 | **207.547×145.000 @ (12.000,12.000)** | **141.594×70.000** @ (646.406,12.000) | **12.000** |

⇒ **世界倍率在 4.8 → 11.52 之间变化时，HUD 的尺寸与内边距逐位相同、位置恒定锚在边缘**
（`gold` 的 `left` 随视口宽度平移，右内边距恒为 12 px）。**相对基线变化 = 0** ✅

机制：HUD 是 DOM，不在 Pixi 场景图内 ⇒ `cameraContainer.scale` 物理上够不到它。
`tests/render/camera_zoom_screen_space.test.ts` 把这条边界钉死（7 例：无 DOM 节点进入场景图、
世界空间内容全在相机子树内、分类完备）。

---

## 6 视口变化自动重适配（quickstart §6 · SC-005）

- 机器判定：`tests/render/camera_zoom_resize.test.ts`（14 例）—— 四种目标视口逐个重算、极端宽高比零裁剪、
  固定视口下模式判定**不抖动**、收缩视口时模式**恰好翻转一次且不回摆**、相机在阈值两侧**收敛不振荡**。
- 真浏览器：§4 表中 5 种视口**各自独立加载**均正确适配（含 32:9 / 9:16 极端比例）。
- 「不出现肉眼可辨的跳变」的**主观**部分同 §4 观察者协议（PENDING）。

---

## 7 高 DPI 与保锐采样（quickstart §7 · FR-008 / FR-009）

- **FR-008**：`tests/render/camera_zoom_sharpness.test.ts`（3 例）断言 `AssetCatalog.load()` 之后
  `TextureSource.defaultOptions.scaleMode === 'nearest'`（**字面量**），且**在首个纹理创建之前**就已设置
  （用记录型 loader 探针证明，而非仅断言终态）；降级目录也保持该设置。
- **FR-009**：`client/main.ts` 的 `app.init` 增加 `resolution: devicePixelRatio`（守卫读，不可读降级 `1`）
  与 `autoDensity: true`，并把 `antialias` 改为 `false`。**这是真实缺陷修复**：改动前 `resolution` 默认 `1`，
  高 DPI 屏靠浏览器拉伸画布 ⇒ **改动前就是糊的**。
- 该文件**不可被 node 测试导入**（模块顶层 `void main()` + `mountCanvas` 触碰 `document`，与既有
  `client/UIManager.ts` 同一先例）⇒ 由 `typecheck:client` + `build` + 真浏览器承担。
- 真浏览器：§4 截图中瓦片边缘锐利、无渗色（`dpr = 1` 的 headless 环境；**高 DPI 观感**属观察者协议 PENDING）。

---

## 8 玩法逐位不变（quickstart §8 · SC-004 / FR-012 / FR-013）

`tests/harness/camera_zoom_lossless.test.ts`（3 例）：

```
[M17 lossless] zooming digest f52dfdd4 vs pinned f52dfdd4
               (zoomActive on 601/601 frames, z = 2.880)
```

- 601-Tick × 150 敌压测脚本在**缩放激活**的渲染器下运行，状态摘要
  （`listEntities() × listComponents()` 过 FNV-1a）**等于 `f52dfdd4`**。
- **`f52dfdd4` 不是本文件自己算出来的**：它是 M15 与 M16 **独立算出**、且既有
  `render_art_lossless.test.ts` **每次运行都在断言**的「**未渲染**跑法」摘要。所以
  「渲染后的摘要 === `f52dfdd4`」**就是**「渲染后 === 未渲染」——而对照由另一个里程碑在另一天算出，
  比再跑一遍同样的循环**更强**（也省掉一次 0.4 s 的重复测量，见 §1.1）。断言用**字面量**，不是「等于自己算的值」。
- **反空真**：`zoomActive` 在 **601/601** 帧为真、`z = 2.880`（30×30 房 @1920×1080）、
  `camera.scale.x = 2.880`、`entityCount > 100`、`tick = 601` —— 证明缩放**确实生效**、
  摘要相等不是因为悄悄降级。
- **同文件内还保留一个廉价对照**：小世界（`start_room` + depth-1 波）分别**不渲染**与**渲染**跑 121 Tick，
  断言两份摘要相等、且渲染器**未消费 PRNG**（与孪生体的下一个 `nextUint32()` 相同）。
- `snapshot()` 深冻结且渲染前后 `toEqual`。
- `src/` 零改动（§2）+ 渲染器不调用任何 `World` 写 API（§12 变异实验反向证明）。

---

## 9 压测与性能（quickstart §9 · SC-007 / FR-018）

**方法**：`before` = 从 `git show HEAD:client/GameRenderer.ts` 逐字提取的**改动前实现**；
`after` = 当前实现且 `zoomActive === true`（反空真断言 `z = 2.880`）。同机、同场景
（30×30 `stress_room` + 150 敌，`entityCount > 100`）、同脚本（12 轮 × 40 帧，**逐轮交替**取比值），
连续 **3 次**独立运行取**中位数**。

| 运行 | before ms/帧 | after ms/帧 | 比值 |
|---|---|---|---|
| 1 | 0.1810 | 0.1797 | **0.993** |
| 2 | 0.1630 | 0.1430 | **0.877** |
| 3 | 0.1306 | 0.1442 | **1.104** |
| **中位数** | — | — | **0.993** ✅（预算 **1.2**） |

- 判定用**比值**，**未使用**任何绝对墙钟阈值（宪法 Principle IV）。
- 实现期还消掉了一处重复计算：`syncZoom` 与取景曾各自求一次 `z` ⇒ 改为**每帧只算一次**并经
  `ZoomFrame` 沿调用链传递（无跨帧缓存）。中位数由 **1.094 → 0.993**。
- 该基准脚本与其依赖的 `GameRendererLegacy.ts` 属**一次性测量工具**，测量后**已删除**
  （不把 1800 行改动前副本长期留在 `client/`）。

---

## 10 震动与缩放共存（quickstart §10 · SC-009 / FR-019）

`tests/render/camera_zoom_room_mode.test.ts` ⑤（2 例）：

- 把 `Math.random` 钉到 `0`（既有 `juice_m14` 的同一手法）⇒ 每帧震动偏移恒为 `(0−0.5)×6 = −3 px`。
- 同一场景分别以 **`z = 8.64`（房间模式）** 与 **`z = 1`（退化）** 跑 200 帧：
  两者的相机相对各自目标的偏移**都是 −15.000 px**，差值 `< 1e-6`。
  **若震动被 `z` 缩放，房间侧会偏 ~129.6 px** ⇒ 断言会响亮失败。
- 另断言 300 帧连续震动下 `renderer.zoom` **恒为 8.64**（无反馈回路、无漂移）。
- 「两者互不干扰」的**主观**判定同 §4 观察者协议（PENDING）。

---

## 11 退化路径（quickstart §11 · FR-014 / FR-021）

`tests/render/camera_zoom_degradation.test.ts`（11 例）覆盖四条退化路径，每条都断言
`zoom === 1`（**字面量**）、`zoomActive === false`、`roomFits === false`（不进入任何取景模式）、
不抛错、不阻塞渲染，且目标与**旧公式逐位相同**——逐位相同性用**在纯浮点里重放旧递推**
（`x += (target − x) × 0.2`）来判定，而非 `toBeCloseTo`。

| # | 路径 | 结果 |
|---|---|---|
| D1 | 无 `screen`（鸭子类型替身） | ✅ `z === 1`，目标 = `screen/2 − playerPx` 逐位相同 |
| D2 | 视口 `NaN` / `Infinity` / `0` / 负（5 个子例） | ✅ `z === 1`，无 `NaN`、无除零 |
| D3 | 无墙世界（**视口可读**） | ✅ `zoomActive === false`；`camera.x ≈ 385`（= C4 的既有期望） |
| D4 | `isInHub(world)` 为真（营地，**墙仍在**） | ✅ `zoomActive === false`，不抛错 |

**边界另一侧也钉住**：`zoomActive === true ∧ z === 1`（100×100 房 @1920×1080，`fitZoom = 1.08`）
时**有意不逐位等价** —— 房间模式生效、相机收敛到房间中心 (460, 40)，而旧公式会给 (860, 440)。
⇒ **逐位等价的键是谓词，不是 `z` 的取值**（spec Edge Case 的边界划分）。

> ⚠️ 实测发现的一处细节（已被测试捕获并修正我的错误假设）：`screenWidth()/screenHeight()` 是**逐轴**
> 守卫读，只把**非有限**值归零；`{width: 0, height: 600}` 的旧行为是 `screenW = 0, screenH = 600`。
> 退化分支因此**必须**沿用逐轴读而不是 `viewport`（后者把两轴一起归零），否则 FR-014 的逐位等价不成立。

---

## 12 T029 · 变异实验（宪法 Principle IV 强制）

备份：`$TEMP/m17-mutation/GameRenderer.ts.bak`，`sha256 = 6d2e1154f1c5d3ba1eb309695d840f6ea79680d0f1e8415e7d5157f63ea6cd29`。

### 变异 #1 · 令 `z` 恒为 `8.64`

```
× 33 failed | 177 passed (210)   ← 6 个文件失败
```
覆盖 `camera_zoom_fit`（E2/E3/E4）、`camera_zoom_room_mode`、`camera_zoom_resize`、
`camera_zoom_degradation`（D1–D4 + 边界 + reset）、`camera_zoom_scene_graph`、`camera_zoom_lossless`。
⇒ 新增断言**全部非空真**。

> 该变异**没有**打翻既有渲染套件 —— 因为 `cameraTarget` 的退化分支在**调用 `computeZoom` 之前**就短路了。
> 这本身是好的设计（纵深防御），但也说明「只变异 `z`」不足以检验既有断言的守卫。

### 变异 #2 · 令退化**谓词**不可达（`if (false && …)`）

```
× 16 failed | 33 passed (49)     ← 4 个文件失败
```
打翻的**既有**断言：
- `camera_follow` G2（×2）、G3
- `camera_adversarial` C1（×2）、C2、C4（×2）、C5
- `juice_m14` S（×2）

打翻的**新增**断言：`camera_zoom_degradation` D2（×3）、D3、D4。

⇒ **双证**：退化谓词是既有 803 例零回归的**唯一机制枢纽**（去掉它既有断言立刻失败），
且新增退化断言**确实在检验该机制**。

### 还原

```console
$ cp "$TEMP/m17-mutation/GameRenderer.ts.bak" client/GameRenderer.ts
$ sha256sum client/GameRenderer.ts
6d2e1154f1c5d3ba1eb309695d840f6ea79680d0f1e8415e7d5157f63ea6cd29   ← 与备份逐位相同 ✅
```
**MUST NOT 使用 `git checkout --`** —— 全程用文件备份还原，已核对校验和。

---

## 13 T032 · 治理登记

- `.workbuddy-ai/memory/INVARIANTS.md` 新增 **M17-T01** 条目：I11 授权扩展（平移 → 平移 + 等比缩放）、
  双取景模式、退化谓词、四原语的暴露方式、场景图零新增节点。
- `specs/025-camera-zoom-viewport/plan.md` 的 Complexity Tracking 与实际实现一致（无需修订：实现严格按
  plan 的 Structure Decision 收敛到 `GameRenderer.ts` + `main.ts` + `AssetCatalog.ts` 三处）。

---

## 14 已知风险与缓解

| # | 风险 | 现状 / 缓解 |
|---|---|---|
| R1 | **`stress.test.ts` G2 对邻居负载敏感**（M16 已登记） | ✅ **已解决**：削减新套件足迹 + `vitest.config.ts` 限制 worker 池并发（`maxThreads = 可用并行度 / 2`）。全量连跑 **6 次全绿**（ratio 6.20–8.90，典型 ~7.5）。代价：墙钟 ~20.5 s → ~26–30 s。详见 §1.1。 |
| R1b | **上述限制是全局配置改动** | 超出 `client/` 范围，故显式登记：`vitest.config.ts` 新增 `poolOptions.threads.maxThreads`。**未改动任何断言**（FR-017 不受影响），也未触碰任何 `src/` 规则。若认为该取舍不当，回退方式 = 删除该 `poolOptions` 块（届时 G2 会恢复为对负载敏感）。 |
| R2 | **SC-002 / SC-009 主观观感未判定** | 需 ≥1 名人类观察者按 §4/§10 的协议做二值判定。客观部分已机器判定。 |
| R3 | **高 DPI 观感未在真机验证** | 真浏览器会话 `dpr = 1`（headless）。`resolution`/`autoDensity` 的设置与 FR-009 的映射已静态验证；真机 2×/3× 观感属观察者协议。 |
| R4 | **跳字在 `z ≈ 8.6` 下字号偏大**（research.md D8 T1） | 截图 `v1` 中 `-12` 跳字可见且随世界缩放，符合 FR-001（跳字属世界空间）。若观感偏大，正确处置是**调小 `FONT_SIZE` 等表现常量**，而非给跳字反缩放。**待观察者确认**。 |
| R5 | **`ZOOM_MAX = 16` 的真实取值** | 现有三房（10×10 / 12×10 / 30×30）都不触及；只在假想极小房生效（已由 3×3 用例覆盖）。 |
| R6 | **跟随模式是防御性分支** | 现有房间在任何目标视口下都走房间模式；跟随模式由 200×200 人造房 + 700×700 小视口覆盖（3 例）。 |
| R7 | **未提交** | 按 tasks.md §Notes，`specs/025-*`、`.specify/` 与本次改动保持未跟踪/未提交，**提交须经人工审批**。 |

---

## 15 复现指南

```bash
# 五道闸门
NO_COLOR=1 npm test && NO_COLOR=1 npm run typecheck && NO_COLOR=1 npm run typecheck:client \
  && NO_COLOR=1 npm run lint && NO_COLOR=1 npm run build

# 合规检查
git diff --stat src/                                 # 期望空
grep -rl "'TransformSnapshotSystem'" tests/ | wc -l  # 期望 13

# 真浏览器验收（先起 dev server）
NO_COLOR=1 npx vite --port 5199 --strictPort &
node production/m17-probe.mjs                        # 需 M17_CHROME 指向缓存的 Chromium
```
