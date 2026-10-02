# 美术资产许可登记（Art Asset Licenses）

本文件是 **SC-010 的载体**：`client/assets/manifest.ts` 中每一个 `id` 都必须能在此
反查到「来源素材包 / 作者 / 来源 URL / 许可 / 本项目做过的修改」。测试
`tests/assets/licenses.test.ts` 会逐条核对，`tests/assets/manifest.test.ts` 会核对许可白名单。

**许可白名单**：`CC0-1.0`（Kenney 全部素材包均为 CC0，可商用、可再分发、无需署名）。
本仓库**不含**任何商业游戏的专有资产，也**不含**无再分发授权的同人素材（FR-020）。

---

## 1. 来源素材包

| packName | author | sourceUrl | license |
|---|---|---|---|
| Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 |
| Fantasy UI Borders | Kenney | https://kenney.nl/assets/fantasy-ui-borders | CC0-1.0 |
| Pixel UI pack | Kenney | https://kenney.nl/assets/pixel-ui-pack | CC0-1.0 |

原始素材（下载后只保留实际使用的那几张图，见 `raw/`）逐包的 `License.txt` 随包保留：
`raw/tiny-dungeon/License.txt`、`raw/fantasy-ui-borders/License.txt`、
`raw/kenney_pixel-ui-pack/License.txt`。

## 2. 逐资产登记

`atlas/*` 由 `tools/build-atlas.py` 从上面的素材包生成（**可复现**：脚本已提交）。
「modifications」一列如实记录本项目对原始像素做过的处理。

| assetId | packName | author | sourceUrl | license | modifications |
|---|---|---|---|---|---|
| `player.base` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 87（带翼盔骑士）；四向与逐动作帧为程序化派生（见 §3） |
| `enemy.grunt` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 108（绿色史莱姆）；同上 |
| `enemy.elite` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 109（骷髅）；同上 |
| `enemy.raider` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 112（哥布林）；同上 |
| `enemy.bomber` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 110（红色蟹怪）；同上 |
| `enemy.gunner` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 121（幽灵）；同上 |
| `enemy.unknown` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 122（蜘蛛，未知签名的兜底形象）；同上 |
| `tile.floor` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 49（沙色地砖）；无修改，验证过无缝平铺 |
| `tile.wall` | Tiny Dungeon | Kenney | https://kenney.nl/assets/tiny-dungeon | CC0-1.0 | 取 tile 40（灰色砖墙）；无修改，验证过无缝平铺 |
| `fx.spark` | —（程序化生成） | 本仓库 | — | CC0-1.0 | 原创 16×16 四芒星，调色板取自 Tiny Dungeon |
| `fx.dash-trail` | —（程序化生成） | 本仓库 | — | CC0-1.0 | 原创 16×16 拖尾条，调色板取自 Tiny Dungeon |
| `fx.hazard-ring` | —（程序化生成） | 本仓库 | — | CC0-1.0 | 原创 64×64 空心环（形状语言与「应拾取」的实心圆刻意不同，FR-017） |
| `ui.icon.gold` | —（程序化生成） | 本仓库 | — | CC0-1.0 | 原创 16×16 实心金币（圆形剪影） |
| `ui.icon.heal` | —（程序化生成） | 本仓库 | — | CC0-1.0 | 原创 16×16 药瓶（细颈剪影） |
| `ui.icon.darkness` | —（程序化生成） | 本仓库 | — | CC0-1.0 | 原创 16×16 棱形宝石（菱形剪影） |
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

> `assets/art/ui/*.png` 是 **CSS 消费**的独立图片（`index.html` 的皮肤经 CSS 变量引用），
> 与 `atlas/ui.png` 里的三个图标同为生成器产物。

## 3. 程序化派生规则（诚实披露）

Kenney 的 Tiny Dungeon 角色图只有**正面静态一帧**，而 FR-002/FR-003 要求四向与动画。
生成器按下面的规则派生，规则本身即代码（`tools/build-atlas.py`），可逐条复核：

| 朝向 | 派生方式 |
|---|---|
| `down` | 原始 tile，未修改 |
| `up` | `erase_face`：把脸部方框（tile 内 5,4–11,9）用头部主色涂掉，读作「背对镜头」 |
| `right` | `shift_head(+3)`：头顶 7 行整体右移 3px（转头） |
| `left` | `mirror` + `shift_head(-3)` |

| 动作 | 派生方式（作用在该朝向的基准帧 `f` 上） |
|---|---|
| `idle` | `[f, shift(f, 0, +1)]` —— 1px 呼吸 |
| `move` | `[f, shift(f, 0, -1)]` —— 1px 行走起伏 |
| `dash` | `[shift(f, 2·朝向), f]` —— 2px 冲刺前倾 |
| `attack` | `[f, shift(f, 1·朝向)]` —— 1px 出手前压 |
| `hit` | `[f]` —— 单帧，受击由渲染层 tint 承担 |
| `death` | `[f, squash(f)]` —— 2px 纵向压扁 |

**基座像素是真实的 CC0 素材；上述派生是本仓库的原创变换。**

## 4. 风格一致性（FR-021）

逐元素核对所用素材包来源：

| 元素 | 来源 | 视觉语言 |
|---|---|---|
| 玩家、5 类敌人、兜底形象 | Tiny Dungeon | 16×16 像素、深色描边、暖灰/棕/青绿调 |
| 墙体、地面 | Tiny Dungeon | 同上（灰砖 / 沙色地砖） |
| 命中火花、冲刺拖尾、危险环 | 程序化（同一调色板） | 同上 |
| 掉落物与货币图标 | 程序化（同一调色板） | 同上 |
| 面板、边框、按钮、覆盖层 | Fantasy UI Borders + Pixel UI pack | 奇幻木/石质感边框，与像素角色同属「地牢奇幻」语汇 |

**结论**：全部素材同属 Kenney 的扁平像素奇幻语汇，无跨风格拼接；主题为「地牢奇幻 · 俯视动作
肉鸽」，与规格要求的「希腊神话 · 俯视动作肉鸽」观感方向一致（Kenney 无希腊神话题材包，
已按 FR-020 的开放许可约束选取最接近的合法素材）。

## 5. 体积（SC-011）

| 范围 | 实测 |
|---|---|
| `assets/art/**` | 221 KB |
| `assets/audio/**` | 186 KB |
| **合计** | **≈ 407 KB**（预算 6 MB） |
| 单文件最大 | `enemies.json` 124 KB（预算 1 MB） |
