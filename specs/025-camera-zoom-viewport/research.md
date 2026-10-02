# Phase 0 · Research：相机缩放与视口自适应（M17）

**Feature**: `025-camera-zoom-viewport` · **Date**: 2026-10-02

本文件消解规划期的全部技术未知项。规格中已无 `[NEEDS CLARIFICATION]`；下列 D1–D11 是**实现前必须冻结的决策**。所有 PixiJS API 事实均已对本机 `node_modules/pixi.js`（**8.21.0**）的 `.d.ts` 实测核对，非凭记忆。

---

## D1 · 缩放因子公式与上下限（对应 FR-002 / FR-003 / FR-011 · SC-001 / SC-002 / SC-008）

**Decision**: 缩放因子是**「按房间范围 fit 到视口的受限方向，再乘留白系数，最后夹取上下限」**：

```
roomPxW = (roomMaxX − roomMinX) × PX_PER_UNIT      // 房间宽（世界像素）
roomPxH = (roomMaxY − roomMinY) × PX_PER_UNIT      // 房间高
fitZoom = min(viewportW / roomPxW, viewportH / roomPxH)   // 受限方向为准
z       = clamp(fitZoom × ZOOM_FIT_MARGIN, ZOOM_MIN, ZOOM_MAX)
```

| 常量 | 值 | 含义 |
|---|---|---|
| `ZOOM_FIT_MARGIN` | `0.8` | 房间在**受限方向**上占视口的比例（留白 20%） |
| `ZOOM_MIN` | `1.0` | 下限：**绝不把世界画得比改动前更小**（恒等即旧基线） |
| `ZOOM_MAX` | `16.0` | 上限：单个 `1×1` 格最多 `10 × 16 = 160` CSS px，极小房间不至于「一格占满整屏」 |

**为什么用 `min`（受限方向）而不是 `max` 或短边**：`min(vw/roomW, vh/roomH)` 恰好是「房间**完整**放进视口所需的最大倍率」。取 `max` 会让另一方向溢出（违反 SC-001「不出现裁剪或溢出」）；取「短边」在房间与视口宽高比不同时会溢出。`min` 是**保证完整可见**的唯一几何正确选择，同时天然满足 FR-011（极端宽高比以受限方向为准）。

**为什么留白 `0.8` 而不是 `1.0`（贴边）**：贴边会让房间四壁紧贴视口边缘，在极端宽高比或浮点边界下**视觉上像被裁**；`0.8` 给出 10% 边距，且把 1080p 下的房间短边比例钉在 **80%**（SC-001 要求 55%–85%，取中上、留足上下裕度）。

**数值核对（房间短边 / 视口短边）**：

| 房间 | 视口 | `fitZoom` | `z` | 房间短边 | 占比 | 判定 |
|---|---|---|---|---|---|---|
| 10×10 | 1920×1080 | 10.8 | **8.64** | 864 px | **80.0%** | ✅ 落在 [55%, 85%]（SC-001） |
| 10×10 | 2560×1440 | 14.4 | 11.52 | 1152 px | 80.0% | ✅（SC-002） |
| 12×10 | 1920×1080 | 10.8 | 8.64 | 864 px | 80.0% | ✅ |
| 30×30 | 1920×1080 | 3.6 | 2.88 | 864 px | 80.0% | ✅ 压测房也读得清 |
| 10×10 | 3840×2160 | 21.6 | **16.0**（上限夹取） | 1600 px | 74.1% | ✅ 仍 > 55% |
| 10×10 | 800×600 | 6.0 | 4.8 | 480 px | 80.0% | ✅ |
| 3×3（假想） | 1920×1080 | 36.0 | **16.0**（上限夹取） | 480 px | 44.4% | ✅ 不被放大到荒谬 |

**为什么 `ZOOM_MIN = 1`**：`1` 是**改动前的世界单位→像素换算**（`PX_PER_UNIT = 10`）。以它为下限保证「本特性只会把世界放大，绝不缩小」—— 直接对应 FR-003 的「极大房间不被缩小到不可辨认」（`z < 1` 会让玩家半径 5 px 更小）。只有在房间极大（1080p 下 > 约 86 格，即 `fitZoom < 1.25`）时该下限才生效；此时 `roomFits` 为假 ⇒ 进入**跟随模式**（房间大于视口，相机以玩家为中心跟随并钳制在房间边界内），房间仍可完整浏览。

**为什么 `ZOOM_MAX = 16`**：上限的存在只为**极小房间**（FR-003 的另一半、Edge Case「3×3 是否把一格放大到占满整屏」）。`16` 使单格 ≤ 160 CSS px（1080p 高的 ~15%），既不荒谬，又不至于在 4K 下过早介入（4K 的 10×10 只需 17.28，被夹到 16 后仍占 74%）。

**Alternatives considered**:
- **固定全局倍率**（如恒 4×）：否决 —— 无法同时适配 10×10 与 30×30（spec 025 §Assumptions 已否决）。
- **按短边 fit（`min(短边/短边)`）**：否决 —— 非方房间 + 非方视口会溢出，违反 FR-011。
- **留白系数 0.9 / 1.0**：否决 —— 逼近 SC-001 的 85% 上界，视口宽高比稍变即可能越界；0.8 留裕度。
- **上下限写成「一格占视口比例」的自适应式**：否决 —— 视口相关会引入非线性，且与「下限 = 旧基线」这一干净语义冲突；常数已足够且更易断言。

---

## D2 · 缩放施加在哪个节点（对应 FR-001 / FR-015 · 宪法 V）

**Decision**: 缩放**直接施加在既有的 `cameraContainer.scale`**（`cameraContainer.scale.set(z)`），**不新增任何场景节点**。

**推导（子节点屏幕位置）**：PixiJS 的容器局部变换为 `translate(position) · rotate · scale`；无旋转时，子节点 `localPos` 映射到屏幕为

```
screen(child) = camera.pos + child.localPos × z
```

（`camera.pos` 仍是**屏幕像素**平移，`z` 同时作用于 x/y ⇒ 等比缩放，满足 FR-005「横纵同倍率」）。

**为什么不是新增一层缩放容器**：任何新节点都会撞坏 6 条冻结契约中的至少一条 ——

| 方案 | 对冻结契约的影响 | 判定 |
|---|---|---|
| **`cameraContainer.scale = z`**（采用） | `stage`/`camera`/`root` 子节点集合**完全不变**；`camera.children[last] === root`、无墙时 `camera.children` 长 1、`camera.children[0]` = 静态层 **全部保持** | ✅ |
| 在 camera 与 root 之间插一层 `zoom` 容器 | `camera.children[last]` 变成 zoom（≠ root）⇒ 撞 F2；无墙时 `camera.children` 长 2（≠ 1）⇒ 撞 F5 | ❌ |
| 把 `root.scale = z` | 静态层（camera 索引 0）是 root 的**兄弟**，**不随缩放** ⇒ 地板/墙不放大而实体放大，视觉与碰撞边界脱节 | ❌ |
| 把 `staticLayer` 与 `root` 各自 `scale = z` | 两个节点分别缩放，等价于在共同父节点缩放但更脆（新增写点、易漂移）；且 vfxLayer/跳字挂在 root 之下虽随 root，但静态层与 root 的 z 必须永远同步 ⇒ 冗余真相 | ❌（更复杂，收益为零） |

**为什么缩放必须覆盖「静态层 + root」**：`cameraContainer` 是二者**唯一的公共父节点**（静态层 `addChildAt(layer, 0)`；root 由 `init()` 追加；`vfxLayer` 惰性插在 root 之前）。在 `cameraContainer.scale` 上缩放 ⇒ 地板 / 墙 / 实体 / 特效 / 跳字**一次全部**随缩放（FR-001 的 9 类世界空间内容），且相对位置与尺寸关系不变形（US1 AS2）。

**Alternatives considered**: 见上表（新增层 / 缩 root / 双写 scale）—— 全部否决，理由逐条列于表中。

---

## D3 · 双取景模式：房间模式与跟随模式（对应 FR-004 / FR-011 · SC-001 / SC-005）

**Decision**: `syncCamera` 的取景**分两种且仅两种模式**，由「房间能否被完整容纳」唯一决定（判定 MUST NOT 依赖玩家位置或其它状态）：

```
roomFits = roomPxW × z ≤ screenW  ∧  roomPxH × z ≤ screenH

// 房间模式（roomFits === true，全部现有房间的默认）
targetX = screenW/2 − roomCenterPxX × z          // 与玩家位置无关 ⇒ 房间居中且静止
targetY = screenH/2 − roomCenterPxY × z

// 跟随模式（roomFits === false，防御性分支）
desiredX = screenW/2 − playerView.x × z          // 旧公式在 z=1 时逐位相同
desiredY = screenH/2 − playerView.y × z
targetX  = clamp(desiredX, bounds.minX, bounds.maxX)
targetY  = clamp(desiredY, bounds.minY, bounds.maxY)

camera.x += (targetX − camera.x) × CAMERA_LERP_FACTOR
camera.y += (targetY − camera.y) × CAMERA_LERP_FACTOR
```

其中 `roomCenterPxX = (roomMinX + roomMaxX)/2 × PX_PER_UNIT`（`roomCenterPxY` 同理），`bounds` 由房间范围（世界单位 `[rx0,rx1]×[ry0,ry1]`）与 `z` 推出：

```
minX = min(screenW − rx1×z,  −rx0×z)      maxX = max(screenW − rx1×z,  −rx0×z)
minY = min(screenH − ry1×z,  −ry0×z)      maxY = max(screenH − ry1×z,  −ry0×z)
```

**为什么默认是房间模式（`roomFits` 恒为真）**：`z = clamp(fitZoom × 0.8, 1, 16)` 且 `fitZoom × 0.8 < fitZoom`，故只要 `z` 未被下限 `1` 夹住，必有 `roomPx × z < 视口` ⇒ `roomFits === true`。下限 `1` 只在 `fitZoom < 1.25`（约 86 世界单位以上的房间，或极端小视口）时生效。**现有三个房间（`start_room` 10×10 / `arena_room` 12×10 / `stress_room` 30×30）在全部目标视口下 `fitZoom` 都 ≥ 1.25 ⇒ `roomFits` 恒真 ⇒ 都走房间模式**；跟随模式仅在超大房间或极端小视口下才可能触发，是**防御性分支**。

**为什么房间模式必须静止（不随玩家漂移）**：房间模式的 `target` 只由房间中心与 `z` 决定，**不含玩家位置** ⇒ 相机目标恒定 ⇒ 房间钉在屏幕中央静止；玩家的位移直接体现为屏幕位移（US1 AS3）。若让房间模式的 target 掺入玩家位置，就退化为「跟随 + 钳制」，房间会在屏幕上滑动（见下）。

**为什么不是「纯玩家跟随」——数学证明（非偏好）**：起始房间 `start_room` 的玩家出生格是 `(4, 8)` ⇒ 世界中心 `(4.5, 8.5)`，**不是**房间中心 `(5, 5)`。1080p 下 `z = 8.64`：
- 纯跟随：`camera.y = 540 − 85×8.64 = −194.4` ⇒ 房间顶边在屏幕 `−194.4` px，**垂直裁掉 194 px** ⇒ 直接违反 SC-001「不出现裁剪或溢出」。
- 要「纯跟随也不裁」，须 `roomPx×z ≤ 视口/2` ⇒ `z ≤ 1080/(2×100) = 5.4`，即房间只占 **50%** < SC-001 的 55% 下限 ⇒ 矛盾。
- 故 SC-001（≥55%）与「不裁剪」**不能同时**由纯跟随满足。

**为什么也不是「纯跟随 + 钳制」（保留跟随但永不裁剪）**：钳制能让房间永不越界，但 1080p 下 10×10 房间仅占视口宽度 `864/1920`，水平富余 `1056 px` ⇒ 相机 target 可在 `[−rx0×z, screenW − rx1×z]` 内随玩家滑动最多约 **777 px**，视觉上「房间在屏幕上飘」，与用户原话「让 10×10 的房间能在屏幕**居中**且清晰可见」及 FR-004「房间 MUST 居中且静止」相悖。

**结论**：房间可被完整容纳时**以房间为中心静态取景（房间模式）**；房间大于视口时才回到既有的「以玩家为中心」跟随并钳制在房间边界内（跟随模式）。两种模式的 `target` 公式如上。

**为什么「先定模式与 target、再 lerp」**：把模式选择与 target 计算放在 lerp **之前**，相机平滑趋近目标；若在 lerp **之后**再修正，相机会在模式切换 / 触界时被硬拽、产生跳变（违反 SC-005「不出现肉眼可辨的跳变」）。

**Alternatives considered**:
- **纯玩家跟随、不钳制**：否决（出生点即裁剪 194 px，违反 SC-001；且要压低 `z` 则跌破 55% 下限）。
- **纯跟随 + 钳制（永不裁剪但相机仍随玩家滑动）**：否决（1080p 下房间随玩家滑动约 777 px，与「房间居中且静止」相悖）。
- **压小 `z` 到纯跟随不裁剪**：否决（只能到 50%，低于 SC-001 下限）。
- **跟随模式的钳制放在 lerp 之后**：否决（触界硬拽 → 跳变）。

---

## D4 · 退化策略（对应 FR-014 / FR-021 · US5 AS4）

**Decision**: 定义**「缩放激活」谓词**

```
hasViewport  = screenW > 0 ∧ screenH > 0 ∧ 二者均 Number.isFinite
hasRoomExtent = world.query(WallComponent).length > 0 ∧ ¬isInHub(world)
zoomActive   = hasViewport ∧ hasRoomExtent
```

`zoomActive === false` 时：**`z = 1`、不进入任何取景模式、目标 = 旧公式**（`screenW/2 − playerView.x`），逐位等价改动前行为，**不抛错、不阻塞渲染**。

**为什么「房间范围」取自 `WallComponent` 包围盒**：墙是房间地形的**唯一只读真相**（spec 19 I1：网格是唯一地形真相，`WallComponent` 是其世界实体化），其 AABB 并集**就是**房间足迹（墙构成房间外框），且渲染层**已经**在 `syncStaticGeometry` 里算过这个包围盒（用于地板铺贴）—— 复用它，零额外查询、零新数据结构、零 `src/` 改动。

**为什么用 `isInHub`**：FR-021 与 US5 AS4 **显式**把「营地/枢纽」列为「房间范围无法确定」的场景。而 `GameSimulator.enterHub` 刻意**不重建世界**（spec 21：营地要展示刚结束的那一局），因此营地期间世界里**仍留着上一间房的墙** —— 若只看「有无墙」，营地会被误判为「有房间」而保留缩放。`isInHub(world)` 是一次只读读取（`UIManager` 已在用同一谓词），把它纳入谓词即可忠实实现 FR-021。营地覆盖层是**全屏 DOM**（`#ui-layer.is-hub`，`inset:0`、94% 不透明），故退化到 `z=1` 在视觉上无害。

**为什么「视口不可读」也退化**：既有渲染测试的鸭子类型 `Application` 只有 `{ stage, ticker }`，`app.screen` 运行时是 `undefined`（`screenWidth()/screenHeight()` 已守卫式返回 `0`）。`hasViewport === false` ⇒ `z = 1`、不进入取景模式、旧公式 ⇒ 既有收敛断言（`toBeCloseTo(..., 6)`）**零改动**继续成立。这是「既有 803 例零回归」的机制枢纽（见 D11）。

**退化谓词的真值表**：

| `hasViewport` | `hasRoomExtent` | `z` | 取景模式 | 目标 | 用例 |
|---|---|---|---|---|---|
| 否 | 任意 | 1 | 无（退化） | `screen/2 − playerPx`（旧） | 既有渲染套件（无 `screen` 替身） |
| 是 | 否 | 1 | 无（退化） | `screen/2 − playerPx`（旧） | 无墙世界 / 营地 / 加载间隙 |
| 是 | 是 | 计算值 | `roomFits ? 房间模式 : 跟随模式` | 房间：`screen/2 − roomCenterPx×z`；跟随：`clamp(screen/2 − playerPx×z)` | 浏览器真实运行 |

**Alternatives considered**:
- **只看「有无墙」、忽略营地**：否决 —— 违反 FR-021 / US5 AS4（营地保留上一局房间）。
- **用 `Transform` 的玩家位置推房间范围**：否决 —— 玩家可在房间任意处，无法反推房间边界。
- **读 `RoomConfig` 网格（经 `DataManager` + `currentRoomId`）**：否决 —— 引入对数据表的间接依赖与「当前房间 id」的解析成本，而墙包围盒已是等价且更直接的只读真相；且会扩大表现层与 `src/data` 的耦合面。
- **视口退化时仍钳制**：否决 —— 无 `screen` 时无 `bounds` 可言，且会破坏既有断言的逐位等价。

---

## D5 · 高 DPI 与保锐采样（对应 FR-008 / FR-009）

**Decision**: 两件事分开处理，**都在 `client/` 的启动期**：

| 需求 | 机制 | 落点 |
|---|---|---|
| FR-009 高 DPI 清晰 | `app.init({ resolution: window.devicePixelRatio, autoDensity: true, … })` | `client/main.ts` |
| FR-008 像素美术保锐 | 加载纹理**之前**设 `TextureSource.defaultOptions.scaleMode = 'nearest'`（全局默认），必要时逐纹理兜底 `texture.source.scaleMode = 'nearest'` | `client/assets/AssetCatalog.ts` |

**API 实测核对（pixi.js 8.21.0 `.d.ts`）**：`ApplicationOptions` 含 `antialias` / `resolution` / `autoDensity` / `resizeTo`；`AbstractRenderer.screen` 文档为「Measurements of the screen. (0, 0, screenWidth, screenHeight)」，`ViewSystem.resize` 注释为「Resizes renderer view in **CSS pixels** to allow for resolutions other than 1」⇒ **`app.screen` 是逻辑（CSS 像素）尺寸**，`resolution` 只放大**画布后备缓冲**。`TextureSource.defaultOptions` 存在且文档为「override these to add your own defaults」；`SCALE_MODE = 'nearest' | 'linear'`。

**为什么 `resolution = devicePixelRatio` 不改相机数学**：`app.screen` 是 CSS 像素，`z` 与 `PX_PER_UNIT` 都在 CSS 像素空间计算；`resolution` 只让**同一逻辑像素**由更多物理像素绘制 ⇒ 清晰而不改变几何。⇒ FR-009 满足，且 `z` 的数值与 DPR 无关（`z` 不随 DPR 变化，故 1080p 结论对 2×/3× 屏同样成立）。

**为什么 `antialias: false`**：像素美术的锐利度由 `scaleMode: 'nearest'` 主导；MSAA 对精灵边缘无益，且会与「硬边像素风」相悖。改这一项**不触及任何测试**（渲染套件从不调用 `app.init`）。

**对既有渲染测试的影响**：**零**。既有渲染套件全部直接 `new GameRenderer(duckTypedApp)` 并传 `NULL_SPRITE_PROVIDER`，**从不走 `main.ts` 的 `app.init`、也从不走 `AssetCatalog.load`** ⇒ `resolution` / `autoDensity` / `scaleMode` 三处改动都不在测试路径上。

**Alternatives considered**:
- **用 CSS 放大画布（`transform: scale`）代替 `resolution`**：否决 —— 会把画布整体栅格化拉伸，正是 FR-009 要消除的「糊」。
- **只设 `resolution` 不设 `autoDensity`**：否决 —— 后备缓冲变大但 CSS 尺寸不同步 ⇒ 画布被拉伸，反而更糊。
- **保留 `antialias: true`**：可行但无必要；像素风取 `false` 更贴合 FR-008。
- **逐纹理设 `scaleMode` 而不设全局默认**：等价但易漏；以全局默认为主、逐纹理为辅。

---

## D6 · 视口自适应的时机（对应 FR-010 · SC-005）

**Decision**: **每帧重算 `z`**（在 `syncWorld` 内、`syncCamera` 之前），**不监听 resize 事件**。

**为什么每帧重算而不挂事件**：
- `app.init` 已有 `resizeTo: window`，PixiJS 会自动把 `app.screen` 更新为新的视口尺寸 ⇒ **每帧读 `screenWidth()/screenHeight()` 天然拿到最新视口**，`z` 随之重算 ⇒ FR-010「自动重算并生效」免费达成。
- **绝不能挂 `app.renderer.on('resize', …)`**：既有 `camera_adversarial` 的带屏替身把 `renderer` 定义成**会抛错的 getter**，用于证明渲染层绝不读 `app.renderer.*`。任何在构造 / `init` / `syncWorld` 路径上访问 `app.renderer` 的代码都会让该套件**抛错失败**。
- `z` 是 `(房间范围, 视口)` 的**纯函数**：二者不变时 `z` 逐位不变 ⇒ **无抖动**（SC-005）；视口变时**立即**生效 ⇒ 无延迟。

**为什么不 lerp `z`**：视口变化是低频事件（用户缩放窗口）；`z` 直接重算 = 即时、确定、可断言。对 `z` 做插值会引入额外状态、可能在极端变化下产生中间态，且使「`z` 是纯函数」的契约失效。相机**位置**仍按既有 lerp 平滑趋近新目标，视觉上足够柔和。

**Alternatives considered**:
- **挂 `renderer.on('resize')`**：否决（会让 `camera_adversarial` 的抛错 getter 触发）。
- **挂 `window.addEventListener('resize')`**：否决（`window` 是 DOM 全局，渲染器当前不依赖它；且 `resizeTo` 已让 `app.screen` 自动更新，事件是冗余第二真相）。
- **lerp `z`**：否决（破坏纯函数契约、引入抖动风险与额外状态）。

---

## D7 · HUD / 覆盖层为何天然免疫（对应 FR-006 / FR-007 · SC-003）

**Decision**: **保持现状** —— 静态界面**不进 Pixi 场景图**，本特性**不把 UI 迁入世界空间**。

**现状核对**：`UIManager` 全部走 DOM（`document.createElement` 构建 `#ui-layer` / `#hud` / `#gold` 等，样式在 `index.html`）。DOM 不在 `cameraContainer` 子树内 ⇒ **世界缩放（`cameraContainer.scale`）在物理上无法影响它**。⇒ FR-006（位置/尺寸与缩放前一致）与 FR-007（原生清晰度、不模糊/不拉伸）**由「什么都不做」直接满足**。

**为什么这是「必须写清的约束」而不是「碰巧」**：一旦有人把 HUD 改成 Pixi 节点并挂进世界空间，它就会随 `cameraContainer.scale` 放大 —— 既违反 FR-006/007，也会**新增常驻节点**撞坏 6 条冻结契约。故契约必须正面声明：**UI 恒为屏幕空间（DOM），MUST NOT 迁入世界空间**。

**对既有测试的影响**：零（`UIManager` 本特性不改；`tests/ui/*` 与 `tests/render/*` 均不受影响）。

**Alternatives considered**:
- **把 HUD 做成 Pixi 屏幕空间容器**：否决（需新增常驻节点 ⇒ 撞 F1–F6；重复实现可访问性/焦点；且 DOM 已免费满足需求）。
- **对 UI 施加反向缩放 `1/z`**：否决（DOM 无需；若 UI 在 Pixi 内，反缩放仍是「把 UI 放进世界空间再抵消」的脆弱方案）。

---

## D8 · 伤害跳字与 VFX 的归属（对应 FR-001）

**Decision**: **跳字与粒子都归世界空间，随 `z` 缩放**（因为它们已挂在 `cameraContainer` 子树内，缩放**自动**生效，无需改动）。

**现状核对**：
- 跳字（floating text）：`spawnFloatingText` 把它 `addChild` 到 `fxLayer`；`fxLayer` 是 `root` 的最后一个子节点，而 `root` 是 `cameraContainer` 的子节点 ⇒ **跳字在相机子树内**，其坐标是世界像素 ⇒ 随相机平移（既有 M12-T02 契约），本特性下**也随 `z` 缩放**（FR-001 明确把「伤害跳字」列入世界空间内容）。
- 粒子（VFX）：`VFXManager.particleLayer` 由 `syncVfxLayer` **惰性挂进 `cameraContainer`**（插在 root 之前）；`VFXManager` 接收**像素**坐标（`hit.position.x × PX_PER_UNIT`）⇒ 也是世界像素 ⇒ 随 `z` 缩放。

**为什么「自动生效」是**正确**的**：跳字与粒子的坐标/尺寸都以世界像素表达，与世界其它内容同处一个坐标系；在共同父节点缩放让它们与实体保持**一致的相对尺寸**（US1 AS2「彼此相对位置与尺寸关系不变形」）。

**已知取舍（T1）**：跳字字号（`FLOATING_TEXT_OFFSET_PX = 22` / `fontSize 16` 世界像素）在 `z ≈ 8.6` 下会变成屏幕上的大号文字。这是「跳字属世界空间」的**直接后果**，与 FR-001 一致；若视觉上偏大，正确的处置是**调小该表现常量**（纯 `client/` 改动），而**不是**给跳字反向缩放（那会让它脱离世界空间，与 FR-001 矛盾）。

**Alternatives considered**:
- **跳字反缩放（保持恒定屏幕字号）**：否决（与 FR-001「跳字属世界空间」矛盾；且需要每帧读取 `z` 写回子节点 scale，新增写点）。
- **把跳字/VFX 迁出相机、挂 `stage`**：否决（会破坏既有 `fxLayer.parent === root` 契约与「跳字随相机平移」的既有断言）。

---

## D9 · 屏幕震动与缩放共存（对应 FR-019 · SC-009）

**Decision**: **不改震动的施加方式**；震动仍作为**屏幕像素偏移**加在相机**平移**上（`camera.x/y += (random − 0.5) × shake`）。

**为什么不互相干扰**：
- 缩放写在 `cameraContainer.scale`，震动写在 `cameraContainer.x/y` —— **两个独立变换分量**，物理上不可能互相改写。
- 震动幅度 `SHAKE_INTENSITY = 6` 是**屏幕像素**，加在平移上 ⇒ 其屏幕位移**与 `z` 无关**（平移不受自身 scale 影响）⇒ 缩放不改变震动的衰减语义（仍是 `SHAKE_DURATION_MS` 线性衰减到**精确 0`）。
- `z` 由 `(房间范围, 视口)` 决定，**不读**震动状态 ⇒ 震动不会使 `z` 漂移（无反馈回路）。

**对既有测试的影响**：`juice_m14` 的震动断言（`random=0` 时首帧 `camera.x ≈ −6`、衰减到 0 后收敛到 `−1.5×10`）走的是**无 `screen` 替身 ⇒ `z = 1`、不进入取景模式**路径 ⇒ 逐位不变。✅

**Alternatives considered**:
- **把震动写成世界空间偏移**：否决（会随 `z` 放大，改变既有震动幅度语义与既有断言）。
- **震动参与 `z` 计算**：否决（引入反馈与不确定性，违反 FR-019/FR-020）。

---

## D10 · 性能（对应 FR-018 · SC-007）

**Decision**: `z` 的重算是 `O(1)`（几次算术 + 一次 `clamp`），且**复用** `syncStaticGeometry` 每帧已算出的墙包围盒 ⇒ **无额外 `World.query`**。验收口径为**每帧 CPU 耗时比值**（改动后 / 改动前 ≤ 1.2），同机、同场景、同脚本、3 次取中位数；**禁用绝对墙钟阈值**（宪法 Principle IV）。

**为什么比值可靠、绝对墙钟不可靠**：M15-T01 实测绝对墙钟随 CI 负载漂移可达 2 倍（单跑 ~460ms / 全量并发 ~860ms），故性能守卫只能是**缩放比**。本特性预期比值 ≈ **1.0**（新增工作仅几次浮点运算），远在 1.2 预算内。

**为什么 DPR 改动不进入这个比值**：该比值测的是 `syncWorld` 的**每帧 CPU 同步**成本（node 渲染套件 / `tests/performance/*` 的既有口径）；`resolution`/`autoDensity` 是**浏览器栅格化**关注点，不在此路径上。故 `resolution = devicePixelRatio` 不会污染 SC-007 的比值。

**Alternatives considered**:
- **绝对帧时/FPS 断言**：否决（CI 不稳定、必然 flaky）。
- **每次缩放变化才重算（缓存 `z`）**：可行但收益极小（`O(1)` 本就便宜），且需维护「房间范围/视口签名」缓存、引入漂移面；不如每帧纯函数重算。
- **不做性能验证**：否决（违反宪法 IV 与 SC-007）。

---

## D11 · 对既有渲染测试与 6 条冻结契约的影响评估（对应 FR-015 / FR-017 · SC-006）

**结论**：**既有 803 例零改动全绿**，且 6 条契约**逐条不变**。评估依据是对 `tests/render/` 6 套件逐条核对（下方「最脆弱项」即逐条证据）。

**6 条冻结契约的影响**（全部保持）：

| 契约 | 本特性是否触碰 | 依据 |
|---|---|---|
| F1 `stage.children` 长 1 且 `[0] === camera` | 否 | 不新增节点 |
| F2 `camera.children[last] === root` | 否 | 缩放写在 `camera.scale`，不改子节点顺序 |
| F3 `root.children[last] === fxLayer` | 否 | root 子树不动 |
| F4 `root.children[0]` = 首个实体视图 | 否 | `createMissingViews` 不动 |
| F5 无墙时 `camera.children` 长**恰 1** | 否 | 静态层仍「仅在有墙时惰性挂载」；缩放不新增节点 |
| F6 空闲时 `fxLayer.children` 长**恰 0** | 否 | 跳字生命周期不动 |

**最脆弱的三条断言与规避**：

1. **`camera_follow` / `camera_adversarial` / `juice_m14` 的跟随收敛断言**（`toBeCloseTo(..., 6)` 钉 `screen/2 − playerPx`）——**最脆弱**。它们钉的是**旧公式**；只有 `z === 1` 时新公式 `screen/2 − playerPx×1` 才与旧公式**逐位相同**（IEEE-754 下 `x × 1 === x`）。**规避**：这些套件用**无 `screen` 替身**（`{ stage, ticker }`），`hasViewport === false` ⇒ `z = 1`、**不进入取景模式**、旧公式 ⇒ 逐位一致。这是零回归的**机制枢纽**（也是 spec 025 §Assumptions 明写的前提）。
   - 特别注意 `camera_adversarial` C4：它用**带 `screen` 的替身**（800×600 / 640×480），断言 `camera.x ≈ 385 / 320`。但它**没有墙**（`hasRoomExtent === false`）⇒ `z = 1`、不进入取景模式 ⇒ 目标仍是 `screen/2 − playerPx` ⇒ 断言成立。**这是本设计唯一「有真实视口」的既有断言，也是退化谓词必须同时要求 `hasRoomExtent` 的直接原因**（若只看视口，C4 会因取景/缩放而失败）。

2. **`camera_follow` G3 / `tilemap_art` 的「墙块在世界像素」断言**（`wallBlock.x === wall.x × PX_PER_UNIT`）——较脆弱。它们断言的是**墙节点的局部坐标**（世界像素）。缩放写在 `cameraContainer.scale` 上，墙节点的**局部** `x/y` **不变**（仍是 `wall.x × PX_PER_UNIT`）⇒ 断言成立。**规避**：**绝不**把 `z` 写进墙/实体节点自身的 scale 或 position。

3. **`camera_follow` G3 的 `renderer.camera.x).not.toBe(0)`**——中等。它用**有墙**的世界但**无 `screen` 替身** ⇒ `z = 1`、不进入取景模式 ⇒ 相机仍被玩家平移（≠ 0）⇒ 成立。**规避**：退化路径必须保持「有玩家视图即平移」的旧行为（不因退化而冻结相机）。

**其余套件**（`renderer_bridge` / `interpolation` / `enemy_art` / `player_art` / `fx_art` / `tilemap_art` / `juice-verify`）：断言的是**实体/墙视图的局部坐标与局部 scale**（如 `playerView.x === 1.5 × PX_PER_UNIT`、`body.scale.x === 0.625`）—— 均**不受** `cameraContainer.scale` 影响 ⇒ 零改动。

**Alternatives considered**:
- **让 `z` 在无 `screen` 时也非 1（例如按房间范围取一个默认视口）**：**否决** —— 会让上述收敛断言逐位不等而失败（违反 FR-017 / SC-006）。
- **改既有断言的期望值**：**禁止**（spec FR-017 与项目铁律：MUST NOT 放宽/删除/改写任何既有断言）。

---

## 未决 / 需在实现期确认的事项

1. **`TextureSource.defaultOptions.scaleMode = 'nearest'` 的生效时点**：必须在**任何** `Assets.load` / `Texture` 创建**之前**设置。实现期需确认 `AssetCatalog.load()` 是否早于所有纹理创建；若是，设为全局默认；若个别纹理在其后创建，逐纹理补设 `texture.source.scaleMode = 'nearest'`。**契约**（FR-008）不受影响，只是落点选择。
2. **`resolution` 的取值上限**：规格 FR-009 要求「与设备像素比匹配」。在 3×/4× 屏 + 4K 下，后备缓冲会很大（如 7680×4320）。实现期在真机测一次帧率；若确有压力，再评估是否 `Math.min(devicePixelRatio, 2)`（**这会偏离 FR-009 的「匹配」**，属需与主理人确认的取舍，默认**不**加上限）。
3. **跳字字号是否需调小**（见 D8 的 T1）：`z ≈ 8.6` 下世界空间字号会被放大。建议在浏览器视觉验收时观察，必要时**调小 `FONT_SIZE` / `FLOATING_TEXT_OFFSET_PX` / `FLOATING_TEXT_RISE_PX` 三个表现常量**（纯 `client/` 改动），而非给跳字反缩放。
4. **`ZOOM_MAX = 16` 的最终取值**：真实房间（10×10 / 12×10 / 30×30）都不会触及上限；该值只在假想极小房间下生效。实现期可在浏览器用一个人造 3×3 房间验证观感后再定稿（16 为本规划的默认）。
5. **性能比值的实测**（见 D10 / SC-007）：预期「改动后 / 改动前」每帧 CPU 耗时比值 ≈ 1.0，但须在实现期用同机、同场景、同脚本、3 次取中位数**实测确认** ≤ 1.2。这是本规划中唯一必须由运行时数据（而非静态推导）闭环的项。
