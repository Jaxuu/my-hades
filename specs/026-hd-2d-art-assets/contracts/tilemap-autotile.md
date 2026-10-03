# 契约：HD 地牢 Tilemap 与墙体 autotile（tilemap-autotile）

> 权威来源：`spec.md` FR-007…FR-010、FR-025；决策见 `research.md` D2 / D8 / D9 / D10 / D14。
> 实现落点：`assets/art/hd/tiles.{png,json}` · `client/GameRenderer.ts`（`buildWallNode` / `syncFloor` / `tileTexture` / `ensureStaticLayer`）。
> 守护测试：`tests/render/tilemap_art.test.ts`（`*_art`，允许更新**结构**断言，**F1–F6 冻结契约 MUST NOT 放宽**）。

## 1. 基准与换算

| 量 | 值 | 说明 |
|---|---|---|
| `PX_PER_UNIT` | **10** | 1 世界单位 = 10 屏幕像素（**不变**） |
| `TILE_NATURAL_PX` | **128**（原 16） | HD 基准 tile 自然像素（决策 D2） |
| 渲染缩放 | `PX_PER_UNIT / TILE_NATURAL_PX = 10 / 128` | 1 格恒 = 1 世界单位 ⇒ 按房间尺寸铺展、**不拉伸**（FR-009） |
| 1 格 = | 1 世界单位 = 128 自然像素 = 10 屏幕像素 × `z` | `z` 由 M17 相机缩放决定（`z ∈ [1,16]`） |

**一致性约束（决策 D14）**：`TILE_NATURAL_PX` MUST 与 `tiles.json` 的 `meta.tilePx` 一致，并由**新增断言**守护，防止常量与图集漂移。

## 2. 墙体拆解：「格内三带」（决策 D9）

墙体 tile **MUST 完全落在墙格内部**，纵向拆为三带：

```text
┌──────────────────────┐  ← 墙格上边界
│   顶面 cap  ~55%     │     受光面：读出「墙有多高、朝向哪侧」
├──────────────────────┤
│   立面 face ~43%     │     背光面：深度与透视的主要来源
├──────────────────────┤
│  墙脚阴影  ~2%       │     与地面接触的接地感
└──────────────────────┘  ← 墙格下边界
```

**硬约束**

| # | 约束 | 理由 |
|---|---|---|
| W1 | 墙体的**全部像素 MUST NOT 越出所属墙格** | 这是「视觉边界 == 碰撞边界」（FR-008 / SC-004，一致率 100%）的**构造性**保证：视觉与碰撞在几何上同一，偏差恒为 0 |
| W2 | 立面 MUST NOT 向相邻**可通行格**延伸 | 否则「看起来能站」的位置实际被阻挡 ⇒ 直接违反 FR-008 |
| W3 | 立面 MAY 向相邻**墙格**延伸 | 相邻墙格本就不可通行，延伸不产生误导，可增强整面墙的连贯感 |
| W4 | 墙脚阴影 MUST 落在墙格内 | 阴影若外溢到可通行格，会被误读为可踩区域 |

> **被明确否决的方案**：立面外溢到相邻可通行格以营造更强的立体感。它使视觉边界与碰撞边界分离，与 FR-008 不可调和，且会让玩家反复「撞到看不见的墙」。

## 3. 部件集与 autotile 位掩码

### 3.1 位掩码定义

对每个墙格，取其 **8 邻域**中同样是墙的邻居，组成 8 位掩码：

```text
bit 0: 上   bit 1: 右上  bit 2: 右   bit 3: 右下
bit 4: 下   bit 5: 左下  bit 6: 左   bit 7: 左上
```

- 掩码 MUST 由**只读**的房间网格推导（MUST NOT 写世界、MUST NOT 消费随机）。
- 掩码计算 MUST 是**确定性**的：同一房间 ⇒ 同一部件选择（与遍历顺序无关）。

### 3.2 部件集

| 类别 | 数量 | 说明 |
|---|---|---|
| 8 邻全组合 | **47**（去重后） | 决策记录见 `design/art-direction.md` §B.3.3 |
| 4 邻简化组合 | **16** | 若作画量受限的回落方案 |

**完备性（data-model VR-13）**：任一可能邻接组合 MUST 解析到一个部件。**缺失组合 MUST 有显式兜底部件**（例如「孤墙」部件），MUST NOT 出现空洞或空白 tile。

### 3.3 部件角色（4 邻简化版的角色语义）

| 角色 | 何时使用 |
|---|---|
| 孤墙 | 四邻皆空 |
| 端点 | 仅一个方向有邻墙 |
| 直墙 | 对向两邻有墙 |
| 转角（外角） | 相邻两邻有墙 |
| T 形 | 三邻有墙 |
| 十字 | 四邻皆有墙 |
| 内侧角 | 需要填补「L 形凹口」的墙格 |

## 4. 地面（FR-009）

- 地面 MUST 提供**多张变体**以避免大面积重复感。
- 变体选择 MUST 是**确定性**的（例如按格坐标的确定性哈希），MUST NOT 使用随机 —— 渲染层 MUST NOT 消费 `World.rng`，MUST NOT 引入墙钟。
- 地面 MUST 按房间足迹的**包围盒**铺设（沿用既有 `syncFloor` 语义：墙的包围盒即房间足迹），每格 1 张 tile。
- 重建 MUST 由**签名守卫**（`floorSignature`）触发，MUST NOT 逐帧重建（30×30 房 ≈ 900 sprite，仅在房间切换时付出）。

## 5. 渲染落地（决策 D10）

| 约束 | 要求 |
|---|---|
| 层级 | 静态层 MUST 挂在 **camera 的 index 0**（既有 `ensureStaticLayer` 语义），位于渲染根之下 ⇒ 地板与墙永不遮挡实体与特效 |
| 层内顺序 | `floorNode` MUST 恒在 index 0（地板在墙之下） |
| **子节点数** | `staticLayer.children.length` MUST 恒为 **`1 + wallCount`**（1 个 floor 节点 + 每面墙 1 个节点） |
| **深度实现** | 墙体深度 MUST **内嵌于既有 wall node**（wall node = `Container`，内部含顶面/立面子精灵）。**MUST NOT 新增常驻层或常驻节点** |
| 回收 | 房间切换后 MUST 无残留（`recycleWallViews` + `teardownStaticLayer`） |

**为什么深度必须内嵌**：渲染场景图 6 条冻结契约（F1–F6）中「无墙时 `camera.children` 长**恰 1**」会被任何常驻节点撞坏（FR-027）。深度内嵌使 `staticLayer` 的**子节点数不变**，只需让每个 wall node 内部多几个子精灵。

**代价（已登记）**：`tests/render/tilemap_art.test.ts` 中「wall node 的子节点数 == cols×rows」这条断言随实现更新（该套件属 `*_art`，已授权）。

## 6. 纹理过滤与 gutter

- HD tile 纹理 MUST 为 `scaleMode = 'linear'` + `autoGenerateMipmaps = true`（决策 D7）。
- 图集内相邻 tile MUST 留 ≥ 4px 透明 gutter（决策 D8）。tile 图集尤其重要：mipmap 低层级跨 tile 取样会产生**接缝渗色**（可见的网格状污渍）。

**摩尔纹（SC-009）**：30×30 房 `z = 2.88`、DPR1 时 128px → 29px（缩小 4.4×）。**无 mipmap 必现摩尔纹** ⇒ mipmap 为必需项，非优化项。

## 7. 与模拟层的隔离（**MUST NOT 违反**）

| 约束 | 说明 |
|---|---|
| 碰撞几何 MUST NOT 改变 | 墙体/可通行格的判定完全由 `src/` 决定；渲染只**读取**网格 |
| MUST NOT 写世界 | 掩码推导、变体选择、节点构建 MUST 全是只读操作 |
| MUST NOT 消费随机 | 不得调用 `World.rng`；确定性哈希 MUST 用格坐标 |
| MUST NOT 改 17 段管道 | 渲染完全在 `step()` 之外 |

## 8. 契约的可测试性对照

| 条款 | 守护测试 | 强度 |
|---|---|---|
| §1 `TILE_NATURAL_PX` ↔ `meta.tilePx` 一致性 | 新增用例 | **新增** |
| §1 按房间尺寸铺展、不拉伸 | `tests/render/tilemap_art.test.ts`（scale 断言重钉为 128 基准） | 保持（数值更新） |
| §2 W1/W2 像素不外溢 | 新增用例（可对部件图集做像素级越界检查） | **新增（构造性保证的关键守护）** |
| §3 掩码完备性（无空洞） | 新增用例（穷举掩码 → 全部有部件） | **新增** |
| §4 地面每格 1 张 | `tests/render/tilemap_art.test.ts`（`floorNode.children.length === 100`） | 保持 |
| §4 变体选择确定性 | 新增用例（同房间两次构建结果相同） | **新增** |
| §5 `staticLayer.children.length === 1 + wallCount` | `tests/render/tilemap_art.test.ts` | 保持 |
| §5 F1–F6 场景图冻结契约 | `tests/render/tilemap_art.test.ts`（F1–F6 用例） | **MUST NOT 放宽** |
| §5 房间切换无残留 | `tests/render/tilemap_art.test.ts`（重建用例） | 保持 |
| §7 只读 / 不消费随机 / 不改管道 | `tests/harness/*lossless*` + `git diff src/` | **MUST NOT 放宽** |
