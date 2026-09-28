# my-hades · 项目长期约定（跨会话）

> 项目：Headless 确定性动作肉鸽模拟内核（《Hades》核心玩法复刻），**逻辑与渲染完全解耦**。
> 运行时：Node ≥ 22 · TypeScript `strict` 全开 · Vitest（node 环境，`pool: 'threads'`）· **零运行时依赖**。

## 1. 架构铁律（改代码前必读）
1. **纯逻辑**：`src/` 禁止 DOM / 墙钟 / 随机（CI 有静态门拦截）。时间**只由 `step()` 推进**。
2. **固定步长**：`fixedDeltaSeconds = 1/fps`（默认 1/60），`tickDurationMs = 1000/fps`（**不截断**）；
   `elapsedSeconds = totalTicks * fixedDeltaSeconds`（乘法，**禁止浮点累加**）。**禁止硬编码 1/60 或 16.67**。
3. **确定性**：同输入序列 ⇒ 逐 Tick 同状态。遍历一律走 `World.query`（id 升序）。
4. **Snapshot 不可变**：深拷贝 + 递归 `Object.freeze`，与实时 world 零引用共享。

## 2. 代码约定
- **组件 = POD**：`ComponentBase` 子类的**纯数据**，**禁止**在组件类上加任何方法（连便捷方法都不加）。
  需要操作数据时用**自由函数**（如 `addTag/removeTag/hasTag`）。
- **系统**：`class X implements System { readonly name = 'X'; update(world, ctx) }`；
  **禁止跨 Tick 隐藏状态**，计时一律落在组件字段上。注册顺序 == 执行顺序。
- 新增文件必须在 `src/ecs/{components,systems,prefabs}/index.ts` 与 `src/ecs/index.ts` barrel 导出。
- **类型安全**：禁止 `any`、非空断言 `!`、`@ts-ignore`；类型导入用 `import type`。
- `PlayerFactory.spawn(world, options)` 返回 **`EntityId`**（不是 Entity 对象）。

## 3. 测试约定
- 浮点位移断言**统一容差 `1e-9`**，**禁止严格相等**（逐 Tick 积分漂移实测 ~1e-15）。
- 测试用**真实** `GameSimulator` + 系统，**不许 mock**；`step(1)` 逐 Tick 推进以钉住时序契约。
- QA 独立套件 `tests/harness/independent-verify.test.ts` 自带独立 fixture，**不共享**工程测试的断言与夹具。

## 4. 工程风险（已踩过的坑）
- **npm 锁文件是平台相关的**：需在**无 `node_modules` 的隔离目录**生成后再采纳。
- **`npm ci` 严格锁文件驱动**：缺 optional 平台包时**不报错（exit 0）但静默跳过** → vitest `MODULE_NOT_FOUND`。
- **vitest 必须 `pool: 'threads'`**：默认 forks 池在本环境写系统 Temp 被拒（EPERM）。
- **CI 纯逻辑门正则过宽**：`\b(document|window|...)\b` 会误伤注释里的普通单词 `window`。
  → `src/` 内注释/字符串**避免出现** `window` / `document` 词面量；根治需收窄正则（待批）。

## 5. 编排约定（工作室流程）
- **先冻结、再评审、后修复**：禁止在 QA 评审窗口内并发改写受审产物（M0 的 C1 教训）。
- 派单必须带：Task ID / 角色 / 优先级 / 上下文 / Deliverables / **Output Path** / Handoff 指令。
- 成员产出经**主理人中转汇编**，成员之间不直连。
- 高影响动作（git commit / 发布 / 删除）须**人工审批**。
- 默认**不 git commit**：里程碑产物落地后由用户决定是否提交。

## 6. 当前进度
| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0-T01 | Headless 确定性 Harness + 工程基座 | ✅ PASS |
| M1-T01 | 基础移动控制（`MovementSystem` + 3 组件 + `PlayerFactory`） | ✅ |
| M1-T02 | 冲刺 / 动作状态机 / 无敌帧（`DashSystem` + `StateSystem` + 管道） | ✅ PASS（8 文件 / 72 用例全绿） |

- 规范管道（**硬契约，不得重排**）：`MovementSystem → DashSystem → StateSystem`（`createDefaultSystems()`）。
- 权威规格：`specs/00_harness_spec.md`、`specs/01_character_controller_spec.md`、`specs/02_dash_and_state_spec.md`。
- 远端仓库：https://github.com/Jaxuu/my-hades（PUBLIC，默认分支 `main`）——**切勿提交密钥**。
