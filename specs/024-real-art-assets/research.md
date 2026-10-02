# Phase 0 · Research：真实 2D 美术与音效资产接入

**Feature**: `024-real-art-assets` · **Date**: 2026-10-01

本文件消解规划期的全部技术未知项。规格中已无 `[NEEDS CLARIFICATION]`；下列 D1–D10 是**实现前必须冻结的决策**。

---

## D1 · 资产来源与许可（对应 FR-020 / FR-021 / SC-010）

**Decision**: 全部美术与音效资产取自 **Kenney.nl 的 CC0 素材包**（经 OpenGameArt 同源镜像核对），并在仓库内做裁剪、图集化与必要的重着色。

选定素材包（均为 CC0，可商用、可再分发、无需署名）：

| 用途 | 素材包 |
|---|---|
| 场景瓦片（墙/地面/道具） | **Roguelike/RPG pack（1,700+ tiles）** · Roguelike Indoor pack |
| 角色与怪物 | **Roguelike Character pack** · Topdown Shooter |
| 界面 | **Pixel UI pack（750 assets）** · UI Pack · UI pack: RPG extension · Game icons |
| 特效 | **Particle Pack（80+ sprites）** · Smoke particle assets |
| 音效 | **50 RPG sound effects** · 63 Digital sound effects · 51 UI sound effects |
| 字体（可选） | Kenney fonts |

**Rationale**:
- CC0 是本项目**唯一安全**的许可档位：`github.com/Jaxuu/my-hades` 是 **PUBLIC** 仓库，任何「保留所有权利」或「需署名/禁再分发」的资产都会带来 DMCA 风险。
- Kenney 各包风格统一（扁平矢量风），跨包混用不会产生风格断层；单一来源也简化了许可登记。
- 覆盖度完整：角色、怪物、瓦片、UI、粒子、音效**一次性**满足 Q2 = C（全量覆盖）的全部需求，无需拼接多个来源。

**Alternatives considered**:
- **直接抓取《哈迪斯》原版/同人素材**（用户原始要求）——**否决**：Supergiant Games 专有版权；同人素材通常无再分发授权；公开仓库再分发属侵权。用户已被告知；若能提供授权证明可推翻。
- **OpenGameArt 的 CC-BY 包**——可行但需逐项署名与保留许可声明，登记成本更高；作为 Kenney 缺项时的备选。
- **itch.io 免费包**——许可五花八门（部分仅限非商用），逐包审查成本高；备选。
- **纯程序化生成原创资产**——零许可风险，但「产品级观感」难以达到；仅作为**回退表现**保留（见 D10）。

---

## D2 · 资产落盘位置与打包方式（对应 FR-012）

**Decision**: 资产落盘到仓库根的 `assets/art/**` 与 `assets/audio/**`，通过 **Vite 静态资产导入**接入（音频用 `?url`，图集用直接 import）。`client/assets/manifest.ts` 是**唯一的资产引用点**，逐项 import 后导出为 id → 句柄的表。

**Rationale**:
- 走 Vite 导入 ⇒ **构建期即校验**：文件被误删/路径写错会让 `npm run build` **直接失败**（响亮失败），而不是留到运行期才发现 404。
- Vite 会为导入资产生成带 hash 的产物名并纳入 bundle ⇒ 与既有 `client/bundled.ts`（JSON 表）同一套构建语义，**无需引入 `public/` 目录**（项目当前没有 `public/`）。
- 单一引用点让「资产清单」可被纯函数单测枚举与断言（见 data-model / contracts）。

**Alternatives considered**:
- **`public/` 目录 + 绝对 URL**——更简单，但绕过构建校验（删文件不报错），且与既有 JSON 表的两条接入路径不一致。
- **运行期 `fetch` 清单 JSON**——多一次网络往返，且清单本身可能 404；与「离线可用、零外部请求」目标相悖。

---

## D3 · 敌人类型识别（只读）——本特性最关键的约束（对应 FR-005）

**问题**：要为 5 类敌人渲染**专属**形象，渲染器必须知道「这个实体是哪一类敌人」。

**调研结论（已核对源码）**：`src/` 中**不存在**敌人类型组件。
- `src/ecs/components/` 无 `EnemyTypeComponent` / `enemyId` 字段；
- `EnemyFactory.spawn` 只把 `enemyId` 用于**查表**，不写入实体；
- `spawnCombatant` 挂载的 `TagComponent` 是 **`new TagComponent()`——空数组**（`spawn-helpers.ts:487`），敌人不带任何标识标签。

**Decision**: 采用**表现层能力签名分类器**（`client/assets/sprite-map.ts` 中的纯函数），只读地按组件组合推断敌人类型：

| 签名（只读组件） | 类型 |
|---|---|
| `PlayerInputComponent` 存在 | 玩家 |
| `ArmorComponent` + `HazardCasterComponent` | `gunner`（armor 40 + hazard，远程） |
| `ArmorComponent`（无 hazard） | `elite`（armor 60，hp 300） |
| `HazardCasterComponent`（无 armor） | `bomber` |
| `AIControllerComponent`（无 armor/hazard） | `raider` |
| 以上皆无（无 ai 的敌方战斗单位） | `grunt` |
| 兜底 | 通用敌人形象 |

**Rationale**: `spawnCombatant` 是**按配置字段条件挂载**组件的（`armor`/`hazard`/`ai`/`loot` 都是 opt-in 能力开关），因此**组件集合本身就是敌人类型的一个忠实、只读的编码**。据 `assets/data/enemies.json` 核对，当前 5 类敌人的签名两两互异，分类**完备且无歧义**。这不是 hack，而是对既有装配契约的合法读取。

**Alternatives considered**:
- **在 `src/` 给敌人加类型标签**（`addTag(world, id, config.id)`）——**否决**：标签是 `listComponents` 的一部分，会改变**快照摘要**，破坏「无损」不变量与 17 段/冻结核心契约（宪法 VI），并可能击穿既有 642 例中按标签集合断言的用例。
- **按 `HealthComponent.maxHp` 硬映射**——否决：`raider` 与 `bomber` 同为 40，且不表达「能力」语义，比签名分类更脆。
- **在 `client/` 侧维护「实体 id → 类型」旁路表**——否决：id 跨 `restartRun` 不复用/不稳定，且需要 `main.ts` 在每个 spawn 点插桩，属于把逻辑耦合进表现层。

**已登记的取舍（T1）**：新增敌人类别若产生**新的签名组合**，需要在 `sprite-map.ts` 增加一条映射；未覆盖时回退通用形象（不崩溃、不可见性为零）。这是**表现层**改动，符合宪法 V。

---

## D4 · 精灵与动画的加载/播放（对应 FR-001…006）

**Decision**: PixiJS v8 的 `Assets.load` 加载**图集（Spritesheet：PNG + JSON）**，用 `AnimatedSprite` 播放。按角色切分图集：`player` / `enemies` / `tiles` / `fx` / `ui` 各一张，以减少纹理切换与 draw call。

**动画状态映射（只读）**：
- **动作**取自 `StateComponent.state`（`ActionState`：`IDLE` / `MOVING` / `DASHING` / `ATTACKING` / `HITSTUN` / `DEAD`）；
- **朝向**取自 `TransformComponent.facingRadians`，量化到 4 向（左/右/上/下）；
- **敌人类型**取自 D3 的分类器；
- **动画时钟**用**真实帧 delta**（与既有浮动伤害数字、屏幕震动、死亡淡出完全同一模式），**不读逻辑 tick、不回写 `src/`**。

**Rationale**:
- 图集化是 PixiJS 性能的既定手段：同图集内的 `AnimatedSprite` 可被批处理，150 敌同屏时显著低于「每实体独立纹理」的 draw call。
- 朝向用**量化 4 向**而非连续旋转：俯视角像素/扁平美术在连续旋转下会失真；量化也消除了 `±PI` 接缝抖动（既有 `shortestArcDelta` 仍在插值层保留）。
- 用真实 delta 播放动画是**既有先例**（`advanceFloatingTexts` / `advanceShake` / `advanceDeaths` 都读 ticker delta），因此不引入新的时间语义，也不需要触碰 `src/`。

**Alternatives considered**:
- **逐帧独立 PNG**——否决：纹理切换开销大，且 150 敌场景下不可接受。
- **按逻辑 tick 驱动动画**——否决：会诱使表现层依赖 tick 速率，且在插值/掉帧下动画会随逻辑帧率跳变；既有 ADR-002 明确把「平滑」交给真实 delta。
- **连续角度旋转精灵**——否决：美术失真 + 朝向可读性下降。

---

## D5 · 界面重皮路线（对应 FR-018 / FR-019）

**现状**：界面**完全走 DOM**——`client/UIManager.ts` 用 `document.createElement` 构建，样式全部在 `index.html` 的 `<style>` 中（`#ui-layer` / `#hud` / `#gold` / `.reward-button` / `.talent-button` / `.start-button` / `is-death` / `is-win` / `is-hub`）。

**Decision**: **保留 DOM 结构与 `UIManager` 的逻辑，只做「重皮」**：在 `index.html` 用美术资产（背景图/面板九宫格/图标）+ 重写 CSS 呈现产品级观感；`UIManager` 仅新增/调整 `className` 钩子，**不加任何逻辑**。

**Rationale**:
- **零风险**：界面不在 PixiJS 场景图里，因此**完全不触碰** 6 条冻结契约（F1–F6）。若把界面迁进 PixiJS，将被迫新增常驻节点，必然撞坏其一。
- `UIManager` 的契约（只读 `World`、不掷骰、逻辑层重新校验一切）保持不变，既有 meta/roguelike 测试不受影响。
- 按钮/面板用 CSS 背景图 + `image-rendering: pixelated` 即可获得风格化外观，同时保留原生可点击/可聚焦/可键盘可达的可用性。

**Alternatives considered**:
- **界面迁入 PixiJS**——否决：高风险（撞 F1–F6）、重复实现输入/焦点/可访问性、且与「冻结契约优先」的宪法精神冲突。
- **引入 UI 框架（React 等）**——否决：为零运行时依赖原则引入重量级依赖，收益不成比例。

---

## D6 · 6 条渲染场景图冻结契约的规避策略（对应宪法 V）

**契约（F1–F6）**：`stage` 唯一子节点 = camera；`camera.children[last]` = root；`root.children[last]` = fxLayer；`root.children[0]` = 首个实体视图；无墙时 `camera.children` 长**恰 1**；空闲时 `fxLayer.children` 长**恰 0**。

**Decision**: 场景纹理**替换既有 `staticLayer` 节点的内容**（把「地板矩形 + 墙矩形」换成「瓦片精灵」），**不新增任何常驻节点**；`staticLayer` 保持**条件存在**（仅当房间含墙时挂载），因此 F5 的「无墙时恰 1」仍然成立。

**Rationale**: `staticLayer` 已经是「惰性挂载」的先例，其位置（有墙时 `camera.children[0]`）被 `camera_follow.test.ts` / `juice_m14.test.ts` / `camera_adversarial.test.ts` 断言。沿用同一节点、只换内容 ⇒ 六条契约**逐条不变**，既有渲染套件**一行不改**。

**Alternatives considered**:
- **新增常驻 `tilemapLayer`**——否决：会撞坏 F5（无墙时 `camera.children` 长度）与 F2（`camera.children[last] === root`）。
- **新增惰性 `tilemapLayer` 与 `staticLayer` 并存**——否决：两者语义重叠（都是「房间静态几何」），并存会让「无墙时长度恰 1」的断言需要重写；不如原地替换。
- **放宽/删除既有断言**——**禁止**（宪法 V 与项目铁律）。

---

## D7 · 中文字体与文字可读性（对应 FR-019）

**Decision**: **不打包全量 CJK 字体**。文字继续使用系统字体栈（`ui-monospace, …` + 中文回退），仅对**标题**可选使用 Kenney fonts 的小体积拉丁显示字体；所有**面板/边框/按钮/图标**由美术资产承担。

**Rationale**: 全量中文字体（如 Noto Sans SC）约 8–10 MB，会**单独吃满**整个资产预算（目标 < 6 MB），而界面文字量很小（`选择祝福` / `YOU DIED` / `营地 · CAMP` / `开始逃离` / `GOLD` / `DARKNESS`）。系统字体栈已保证中文清晰可读，满足 FR-019 的「不乱码、不方块」。

**Alternatives considered**:
- **打包 Noto Sans SC**——否决：体积不可接受。
- **子集化字体（仅用到的字形）**——可行且体积小，但需引入字体子集化工具链（新依赖 + 构建步骤）；登记为**后续可选优化**，非本次必需。
- **位图字体**——否决：中文位图字体覆盖成本更高。

---

## D8 · 音频接入（对应 FR-010 / FR-011）

**Decision**: `AudioManager` 的 3 个占位合成音（WAV `data:` URI）替换为**真实音效文件**（经 Vite `?url` 导入，喂给既有 `Howl`）。事件集按 Q2 = C **加性扩展**：命中、冲刺、拾取之外，补敌人死亡、危险引爆、按钮点击、奖励选择、终局（死亡/胜利）。**静默降级契约与 howler 导入图隔离保持不变**。

**Rationale**:
- 既有 `AudioManager` 已把「构造 + 播放」全包在 try/catch 里（`isAvailable === false` ⇒ 每个方法 no-op），换素材**不需要**改这个契约，只需把 `src:` 从 data URI 换成导入的文件 URL。
- 加性扩展事件集需触碰 `GameLoop` 的 `AudioSink` 接口——按项目既有纪律，**新参数尾部追加且可选**，保证 `new GameLoop(sim, renderer, input)` 行为逐位不变。
- `howler` 仍**只**被 `client/AudioManager.ts` 导入，`GameRenderer` 导入图不含 howler（否则无 DOM 的 `typecheck` 会因裸 `window` 报 TS2304——此前提已在 M14 被实测澄清，见 `AudioManager.ts` 头注）。

**Alternatives considered**:
- **保留合成音**——否决：用户明确要求真实音效资产。
- **改用 Web Audio 直连**——否决：会移除 howler 这一真实依赖与其加载/静音/音量能力，属倒退。
- **音频也做图集/精灵表**——不适用；音频按文件独立加载更简单。

---

## D9 · 性能（对应 FR-016 / SC-006）

**Decision**: 以「图集 + 视图复用 + 零每帧分配」为性能策略；性能验收**用缩放比与基线对比**，不用绝对墙钟（宪法 IV）。

**具体手段**：
- 同图集内批处理（D4）；瓦片渲染避免逐帧重建 `Graphics`（现状每帧不重建，改为**房间变化时重建一次**瓦片精灵）；
- 视图缓存沿用既有 `Map<EntityId, EntityView>` 与 `recycleDestroyed` 机制；
- 动画更新避免每帧 `new`；`AnimatedSprite` 的纹理帧数组在视图创建时一次性取好；
- 复用既有 `tests/performance/stress.test.ts` 的场景，新增表现层侧的时间/分配观测（或对既有渲染套件做扩展）。

**Rationale**: 与 M15 的结论一致——绝对墙钟随 CI 负载漂移可达 2 倍，**缩放比**才是可靠守卫；而「无损」必须用快照摘要自证。

**Alternatives considered**:
- **绝对 FPS 断言**——否决：CI 不稳定，会产生 flaky。
- **不做性能验证**——否决：违反宪法 IV 与 SC-006。

---

## D10 · 优雅降级与回退表现（对应 FR-013 / SC-007）

**Decision**: **保留全部现有 `Graphics` 占位绘制代码作为回退路径**。`AssetCatalog` 对每个资产逐个 try/catch；任一资产加载/解码失败 ⇒ 该元素退回既有几何占位（或音频静默），其余元素不受影响。

**Rationale**:
- 现状的占位绘制已是**经过 642 例测试验证**的稳定路径；保留它既是 FR-013 的直接实现，也让「资产全丢」时游戏仍然可玩（SC-007 崩溃数 = 0）。
- 逐个 try/catch（而非「任一失败即整体回退」）满足「局部降级」语义，避免一颗坏文件拖垮整屏美术。

**Alternatives considered**:
- **删除占位代码**——否决：直接违反 FR-013 与 SC-007，且失去回归基线。
- **整包原子加载**——否决：局部失败会放大为全局失败。

---

## 未决 / 需在实现期确认的事项

1. **Kenney 具体包的下载与裁剪清单**：实现期需逐包下载、核对许可文本、裁剪出本项目实际使用的精灵，并把来源与许可写入 `assets/art/LICENSES.md` 与 `assets/audio/LICENSES.md`（SC-010 的载体）。
2. **图集打包方式**：用 TexturePacker / free-tex-packer 生成 PixiJS 兼容的 Spritesheet JSON（离线工具，非运行时依赖）。若工具不可得，退化为「按目录约定 + 手写 JSON」。
3. **资产体积实测**：目标 < 6 MB；若超出需降采样或裁剪（登记为 T2）。
4. **`?mode=stress` 下的动画降级**：150 敌同屏时是否需要限制动画帧率（登记为 T3）。
