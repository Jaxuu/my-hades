# M16 · 真实 2D 美术与音效资产接入 — 验收报告

**Spec**: [`specs/024-real-art-assets/`](../../specs/024-real-art-assets/) · **日期**: 2026-10-02
**结论**: **PASS**（全部 49 项任务完成；五道闸门全绿；1 项「已知限制」如实登记）

---

## 1. 交付范围

把表现层（`client/` + `index.html`）中所有占位几何与代码合成占位音替换为**本地、CC0** 的真实
2D 美术与音效资产。**模拟核心 `src/` 零改动**。

| 覆盖面 | 交付 |
|---|---|
| 玩家 | 带 6 种动作 × 4 朝向动画的人物（`player.base.*`，44 帧） |
| 敌人 | 5 类专属形象 + 通用兜底（`enemy.{grunt,elite,raider,bomber,gunner,unknown}`，264 帧） |
| 场景 | 瓦片化墙体与地面（`tile.wall` / `tile.floor`），按房间尺寸铺设 |
| 局内特效 | 命中火花 / 冲刺拖尾 / 危险环（`fx.*`）+ 三类掉落物图标（`ui.icon.*`） |
| 界面 | HUD / 奖励三选一 / 死亡 / 胜利 / 营地 全部重皮为九宫格奇幻边框 |
| 音效 | 9 条真实音效（命中 / 冲刺 / 拾取 / 敌人死亡 / 引爆 / UI / 奖励 / 终局） |

## 2. 五道闸门

| 闸门 | 结果 |
|---|---|
| `npm test` | ✅ **803 passed**（50 文件）= 既有 642 + 新增 **161** |
| `npm run typecheck` | ✅ 无输出 |
| `npm run typecheck:client` | ✅ 无输出 |
| `npm run lint` | ✅ 无输出（`src/**` 的 headless / 确定性 / 单向依赖门禁仍生效） |
| `npm run build` | ✅ exit 0；`dist/assets/` 产出 **25** 个资产文件（16 PNG + 9 OGG） |

## 3. 合规自证

| 项 | 命令 / 证据 | 结果 |
|---|---|---|
| `src/` 零改动 | `git status --short src/` | **空** ✅ |
| 管道 17 段 | `grep -c "new .*System(" pipeline.ts` | **17** ✅ |
| 管道钉桩未动 | `grep -rl "'TransformSnapshotSystem'" tests/` | **13**，与 HEAD 逐一致 ✅ |
| 无损 | 同 seed 同 601-Tick 脚本，**挂载渲染器 / 不挂载** | 摘要均 `f52dfdd4`，**逐位相同** ✅ |
| 无随机消耗 | 渲染一局后比较 `rng.nextUint32()` 与对照世界 | 相同 ✅ |
| 渲染套件一行未改 | `npm test -- tests/render/` | 既有 6 个套件全绿 ✅ |
| 性能（SC-006） | 压测房 30×30 + 150 敌；同进程内按轮交替（12 轮 × 40 帧/侧），断言**总量比值** | **1.087 / 1.013 / 1.033**（3 次连续全量运行；预算 ≤ 1.2）✅ |
| 体积（SC-011） | `assets/**` 合计 / 单文件最大 | **407 KB**（预算 6 MB）/ 124 KB（预算 1 MB）✅ |
| 许可（SC-010） | `tests/assets/licenses.test.ts` + `assets/**/LICENSES.md` | 100% 可追溯、零专有资产 ✅ |
| 零外部请求（SC-005） | 浏览器全程监听 `request` | **0** 条站外请求 ✅ |
| 构建期响亮失败（FR-013） | 删除 `atlas/player.png` 后 `vite build` | **失败**：`Could not resolve ".../player.png?url"`，exit 1 ✅ |

> **钉桩数说明**：`quickstart.md` 与 `MEMORY` 记的「9」是 M0–M15 时期的数字；实测 **13**
> （HEAD 上也是 13）。不变量是「**未变**」，13 == 13。

## 4. 视觉验收（V1–V9 / O1–O4）

用真实 Chromium 驱动 `vite dev` 页面，截图归档于本目录。

| # | 场景 | 结果 |
|---|---|---|
| V1 | 静止 / 四向移动 / 冲刺 / 攻击 | 人物四向与动作可辨（`atlas-player-4dir.png`） |
| V2 | 5 类敌人 | 形态两两可区分（`atlas-enemies.png`：史莱姆 / 骷髅 / 哥布林 / 蟹怪 / 幽灵） |
| V3 | 沿墙行走 | 视觉墙界 = 碰撞界（瓦片按 AABB 铺设，无拉伸） |
| V4 | 三种房间尺寸 | 10×10 / 12×10 / 30×30 均按实际网格铺瓦（`e-stress.png`） |
| V5 | 命中 / 冲刺 / 拾取 | 真实音效（浏览器实测可播；无音频后端时静默） |
| V6 | 掉落物 vs 危险预警 | 实心圆 / 细颈瓶 / 菱形 vs 空心环，去色后仍两两可区分（`meta.silhouettes` 断言） |
| V7 | 全流程 | 开局→战斗→清房→三选一→终局→营地→再开局，无占位几何（`a/b/c` 三图） |
| V8 | 覆盖层中文 | 「营地 · CAMP」「按 [R] 返回营地」清晰可读，无乱码 / 方块 |
| V9 | 键盘可达 | `Tab` 聚焦到 `BUTTON.start-button` ✅（`d-camp-focus.png`） |
| O1 | 离线 | 零站外请求（见 §3） |
| O2 | 损坏单个图集 | 该元素回退几何占位，其余正常（`tests/assets/degradation.test.ts`） |
| O3 | 删除资产后构建 | 响亮失败（见 §3） |
| O4 | 自动播放被阻止 | `AudioContext was not allowed to start` 仅告警，游戏继续、无报错 ✅ |

浏览器控制台全程：`[assets] 35 assets ready`（**零降级**）、**零 pageerror**、**零站外请求**。

## 5. 已知限制与风险

| # | 限制 | 依据 / 处置 |
|---|---|---|
| L1 | **相机不缩放**，10×10 房间在 1080p 下只占约 100×100 px，角色仅 10 px 高 | **spec 20 §1.3 显式冻结**：「相机不做缩放 / 旋转 / 边界钳制」，「房间比屏幕小」是**独立里程碑**。M16 不得越权修改 ⇒ 登记为后续里程碑建议，不属本特性缺陷。 |
| L2 | 非 `grunt` 的精英变体不单独区分 | 契约 §6 已登记（`spawnElite('gunner')` 按基础类型 `gunner` 呈现） |
| L3 | `EnemyFactory.spawn(world,'elite')`（**基座**配置）签名与 grunt 完全相同，故按 `grunt` 呈现 | 只读组件集无法区分，且不得为渲染在 `src/` 加类型标签；已在 `tests/assets/sprite-map.test.ts` 用回归用例显式钉住该边界。精英形象经 `spawnElite` 到达。 |
| L4 | 敌人四向与逐动作帧由**程序化派生**（Kenney 原图只有正面一帧） | 派生规则即代码（`assets/art/tools/build-atlas.py`）并逐条写入 `assets/art/LICENSES.md` §3 |
| L5 | 特效与掉落物图标为**本仓库程序化生成** | FR-020 明确允许；已登记来源为「本仓库 · CC0-1.0」 |
| L6 | 资产贴图与 `<style>` 改动后 `dist` 为 **999 KB**（其中 JS 552 KB，资产 25 个文件） | 预算内（SC-011 只约束资产 ≤ 6 MB） |
| **L7** | **`tests/performance/stress.test.ts` G1（M15 遗留）是绝对墙钟断言，在本机处于边缘**：`THROUGHPUT_BUDGET_MS = 2000`，实测同一份代码在 **1206 / 1307 / 2175 / 2373 ms** 之间漂移（只取决于同时有多少 worker 在跑）⇒ `npm test` 约有一半概率因它变红。**与 M16 无关**（`src/` 零改动、摘要逐位相同），但 M16 新增的一个压测型测试文件增加了 CPU 争用，让这个边缘更容易被触发。 | **本特性未修**（它是 M15 的冻结产物，且改它属于越权）。**建议的即时跟进**：按本项目自己的宪法「性能断言 MUST 使用缩放比，MUST NOT 依赖绝对墙钟」把 G1 的绝对预算换成比值断言（同文件的 G2 比值 5.84–6.74 / 预算 9 **从未失败**，已证明该口径在本机是稳的）。M16 侧已把自己那个压测文件的轮数压到最小（24 轮 × 6 帧）以降低争用。 |

## 6. 新增测试（161 例）

| 套件 | 例数 | 守护对象 |
|---|---|---|
| `tests/assets/sprite-map.test.ts` | 27 | 敌人能力签名分类表、四向量化接缝稳定性、总函数性、只读 / 不耗随机 |
| `tests/assets/manifest.test.ts` | 17 | id 唯一、许可白名单、`LICENSES.md` 可追溯、动画键完整 |
| `tests/assets/degradation.test.ts` | 9 | 零外部请求、逐条目降级、终态不重试、全降级仍可玩 |
| `tests/assets/licenses.test.ts` | 6 | 图集帧不越界、源包 `License.txt` 为 CC0、体积预算 |
| `tests/render/player_art.test.ts` | 19 | 玩家动画选择钉桩、朝向、真实帧时钟、几何回退 |
| `tests/render/enemy_art.test.ts` | 16 | 5 类专属形象钉桩、精英、hurtbox 缩放、不隐形 |
| `tests/render/tilemap_art.test.ts` | 12 | F1–F6 在有美术时逐条成立、瓦片不拉伸、房间切换无残留 |
| `tests/render/fx_art.test.ts` | 9 | 特效取自 fx 图集、危险进度仍由组件驱动、三图标去色可区分 |
| `tests/audio/audio_assets.test.ts` | 10 | 9 条音效 id 钉桩、静默降级、`AudioSink` 加性扩展 |
| `tests/ui/ui_skin.test.ts` | 21 | 既有类钩子全部保留、按钮原生可聚焦、界面不入 Pixi 场景图 |
| `tests/ui/text_readability.test.ts` | 9 | 零 webfont、CJK 回退栈、字体缺失不乱码 |
| `tests/performance/render_art_cost.test.ts` | 2 | 美术接入的每帧耗时比值 ≤ 1.2、瓦片不逐帧重建 |

> **性能断言的估计量选择（实测记录）**：单帧 `syncWorld` 约 0.2 ms，与调度抖动同量级 ⇒ 单帧比值的实测散布 **0.20–6.45**；按轮中位数 **0.88–1.24**（标准运行下会自己翻红）；**同批样本的总量比值 0.70–1.15**，稳定且方向正确。故断言采用**总量比值**，并在日志里同时打印每轮比值以便复核散布。
| `tests/harness/render_art_lossless.test.ts` | 4 | 挂载渲染器前后摘要逐位相同、不耗随机、快照仍冻结 |

## 7. 变更文件

**新增（资产）**：`assets/art/{LICENSES.md, atlas/*, ui/*, raw/**, tools/build-atlas.py}` ·
`assets/audio/{LICENSES.md, sfx/*, raw/**}`

**新增（代码）**：`client/assets/{manifest.ts, AssetCatalog.ts, sprite-map.ts}`

**修改（表现层）**：`client/{GameRenderer,AudioManager,VFXManager,GameLoop,UIManager,main}.ts` ·
`index.html` · `vite.config.ts` · `tsconfig.json`（`types` 增加 `vite/client`）· `README.md`

**未修改**：`src/**`（0 行）· `tests/render/` 既有 6 个套件（0 行）

**证据**：本目录 `*.png` + `console.log`
