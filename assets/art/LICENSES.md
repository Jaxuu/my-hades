# 美术资产许可登记（Art Asset Licenses）

本文件是 **SC-013 的载体**：`client/assets/manifest.ts` 中每一个 `id` 都必须能在此
反查到「来源素材包 / 作者 / 来源 URL / 许可 / 本项目做过的修改」。测试
`tests/assets/licenses.test.ts` 会逐条核对，`tests/assets/manifest.test.ts` 会核对许可白名单。

**许可白名单**（`research.md` D17，以显式字面量声明）：
`CC0-1.0` · `Public Domain` · `CC-BY-4.0`。GPL 与 CC-BY-SA 默认排除（传染性 / 义务）。

**底线（MUST 保持）**：本仓库**不含**任何商业游戏的专有资产，也**不含**无再分发授权的
同人素材（FR-023）。

---

## 1. 来源素材包

| packName | author | sourceUrl | license | 用途 |
|---|---|---|---|---|
| （本仓库原创 · 程序化生成） | 本仓库 | — | CC0-1.0 | M18 世界 HD 图集全部内容 |
| Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | **M18 已退役**（像素管线） |
| Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 界面贴图（FR-030 保留） |
| Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 | 界面贴图（FR-030 保留） |

---

## 2. 世界 HD 图集（M18 · 本仓库原创 · 程序化生成）

**生成方式**：`production/m18-placeholder-atlases.mjs`（Node，零依赖，`node:zlib` 手工编码 PNG）。
**修改说明**：全部内容为**本仓库原创的程序化绘制**，**未**从任何上游素材包派生像素；
因此不涉及第三方素材的再分发（`research.md` D18 的「本仓库原创 / 程序化生成」分支）。
**处置**：真实 HD 美术就位后，该生成器与下列占位图集一并退役（`tasks.md` T049）。

| assetId | packName | author | sourceUrl | license | modifications |
|---|---|---|---|---|---|
| `player.base` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 四向六动作（idle/move/dash/attack/hit/death）160 帧 |
| `enemy.grunt` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 96² 矮胖史莱姆剪影 |
| `enemy.elite` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 160² 宽肩骷髅剪影（T 形） |
| `enemy.raider` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 倾斜身形 + 长斜刃剪影 |
| `enemy.bomber` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 96² 圆身尖刺剪影 |
| `enemy.gunner` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 细高身形 + 长横炮管剪影 |
| `enemy.unknown` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 96² 无定形带孔剪影（兜底形象） |
| `tile.floor` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 石地砖 8 个变体（确定性铺装） |
| `tile.wall` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 墙体部件（格内三带：顶面 / 立面 / 墙脚阴影）+ 47 个 8 邻 autotile 部件 |
| `fx.spark` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 四芒星火花贴花（运行时仍为 `Graphics` 纹理填充） |
| `fx.dash-trail` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 冲刺拖尾条 |
| `fx.hazard-ring` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 空心环（形状语言与「应拾取」的实心圆刻意不同） |
| `fx.pickup.gold` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 实心圆形金币（**应拾取**语义） |
| `fx.pickup.heal` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 细颈药瓶（**应拾取**语义） |
| `fx.pickup.darkness` | 本仓库原创 | 本仓库 | — | CC0-1.0 | 程序化绘制 128² 棱形宝石（**应躲避**语义） |

> 掉落物 id 由 `ui.icon.*` 迁到 `fx.pickup.*`（`research.md` D4，用户裁定 P3）：
> 掉落物渲染在**世界空间**，`ui.` 命名空间留给 HUD。

---

## 3. 界面贴图（FR-030 保留，本特性不改动）

`assets/art/ui/*.png` 与 `assets/art/ui/icons.{png,json}` 是 **CSS / HUD 消费**的独立图片，
经 `index.html` 的皮肤 CSS 变量引用。**本特性不修改其内容。**

| assetId | packName | author | sourceUrl | license | modifications |
|---|---|---|---|---|---|
| `ui.icon.gold` | Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 | 本仓库原创 16×16 实心金币（供 HUD 使用） |
| `ui.icon.heal` | Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 | 本仓库原创 16×16 药瓶 |
| `ui.icon.darkness` | Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 | 本仓库原创 16×16 棱形宝石 |
| `ui.panel.hud` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Panel/panel-002.png`，原样复制 |
| `ui.panel.reward` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Panel/panel-000.png`，原样复制 |
| `ui.panel.camp` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Panel/panel-004.png`，原样复制 |
| `ui.frame.reward-card` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Border/panel-border-000.png`，原样复制 |
| `ui.frame.talent-card` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Border/panel-border-004.png`，原样复制 |
| `ui.button.primary` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Border/panel-border-018.png`，原样复制 |
| `ui.overlay.death` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Panel/panel-003.png`，原样复制 |
| `ui.overlay.win` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Panel/panel-001.png`，原样复制 |
| `ui.frame.slot` | Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 | 取 `9-Slice/space.png`，原样复制 |
| `ui.frame.slot-inlay` | Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 | 取 `9-Slice/space_inlay.png`，原样复制 |
| `ui.bar.hud` | Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 | 取 `Divider/divider-000.png`，原样复制 |

---

## 4. 音频（FR-030 保留，本特性不改动）

音频资产的逐项登记见 `assets/audio/LICENSES.md`（`sfx.*` 全部条目）。

---

## 5. 已退役的像素管线（M18 · FR-016…FR-018 · **已实际移除**）

以下内容在 M18 被**彻底移除**，其登记保留在此以说明历史来源与「已不再分发」的事实。
`tests/assets/licenses.test.ts` 会断言这些路径**不存在**（SC-008）。

| 退役内容 | 原来源 | 许可 | 处置 |
|---|---|---|---|
| `assets/art/atlas/{player,enemies,tiles,fx}.{png,json}` | Tiny Dungeon（Kenney） | CC0-1.0 | **已删除**（T044） |
| `assets/art/tools/build-atlas.py` | 本仓库 | — | **已删除**（T045） |
| `assets/art/raw/tiny-dungeon` | Tiny Dungeon（Kenney） | CC0-1.0 | **已删除**（T046） |
| `assets/art/raw/fantasy-ui-borders` | Fantasy UI Borders（Kenney） | CC0-1.0 | **已删除**（T046；界面贴图已复制到 `assets/art/ui/`） |
| `assets/art/raw/kenney_pixel-ui-pack` | Pixel UI pack（Kenney） | CC0-1.0 | **已删除**（T046；界面贴图已复制到 `assets/art/ui/`） |
| `assets/art/atlas/ui.{png,json}` | 本仓库原创 | CC0-1.0 | **已迁移**至 `assets/art/ui/icons.{png,json}`（**字节未变**，仅路径变更；`ui.icon.*` 条目随之改指） |

---

## 6. 体积（SC-014 · 构建产物实测）

| 范围 | 实测 |
|---|---|
| `assets/art/hd/**`（9 张世界 HD 图集） | **≈ 612 KB** |
| `assets/art/ui/**`（界面贴图，FR-030 保留） | **≈ 22 KB** |
| `assets/art/**` 合计 | **≈ 634 KB** |
| `assets/audio/**`（FR-030 保留） | ≈ 283 KB |
| 单文件最大 | `hd/enemy-elite.png` **≈ 51 KB** |

**预算**：单文件 **≤ 3 MB** · 资产总量 **≤ 12 MB** · 单图集 **≤ 4096²**（目标 ≤ 2048²）· 图集数 **≤ 12**。
实测最大图集 = `enemy-grunt.png` 2000 × 700，全部 10 张图集均 ≤ 2048²。

