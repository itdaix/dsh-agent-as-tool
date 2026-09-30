# dsh-agent-as-tool

## 一句话简介

把「智能体」封装成具名工具：模型只调 `tools.<工具名>({ query })`，插件后台用官方 API 在指定工作区 + 预设下建/复用独立会话，拿回回答；审批与结构化提问一律透传回人类通道，模型无从自批。

## 技术选型

| 项 | 选型 |
|---|---|
| 语言 | 纯 JS（index.js，约 500 行） |
| 依赖 | 只 import Node 内置模块（crypto / fs / path），其余服务全从 ctx 注入 |
| 注入依赖 | tools、sessionController、workspaceRegistry、sessions、permissionPresets、approval |
| 会话复用 | 落盘注册表（JSON 文件，按「工作区 + 用户会话 + 工具名」分目录） |

## 核心流程（动作清单）

### 阶段一：注册工具（启动）

1. 拿到归一化配置，套默认值（registryDir=`.dsh-agent-as-tool`、approvalTimeoutMs=`120000`）
2. 逐个 agent 校验字段：name 需是合法工具名、description / cwd / agentPreset 必填、reasoningEffort / permissionPreset / approvalPolicy 需在枚举内
3. 给每个 agent 注册一个具名工具，参数只暴露 query / questionId / answers（刻意不放 approvalId / decision，模型没有自批入口）

### 阶段二：处理一次调用（execute）

4. 拿到调用方父 agent（exec.agent，缺了就抛错）
5. 取出父会话 id（`parent.session.header.id`）和工作区 cwd（`header.cwd`）
6. 若带 questionId → 跳去「回答提问」分支（阶段七）
7. 若 query 为空 → 直接返回错误
8. 进入 ensureSession 建/复用会话

### 阶段三：建/复用会话（ensureSession）

9. 读注册表文件 `{cwd}/.dsh-agent-as-tool/{userSessionId}/{toolName}.json`，取出已存 sessionId 和 turns 计数
10. 若已有会话：算出 rotate =（maxTurns>0 且 turns≥maxTurns），再查 archivedSessionIds 判断是否已被归档
11. 轮数到顶且未归档 → 归档旧会话
12. 已归档 → 跳过复用，直接走新建
13. 未到顶且未归档 → resolveAgent 解析旧会话，解析到就复用（返回旧 sessionId + turns）
14. 真要新建：先预检三件事——cwd 是绝对路径且目录可建、agentPreset 能被预设名册解析、provider/model/effort 的合成选择能被 llm 解析
15. 任一预检不过 → 返回人类可读错误，不留半成品会话
16. 建新会话（create，带 cwd + agentPreset）
17. 挂工作区：resolveByPath 按 cwd 解析，解析不到就 create，再 attachSession 绑到新会话
18. 设权限姿态：把 permissionPreset 写入会话，把 approvalPolicy 用 setPolicy 落到该 agent
19. 设模型：selectModel 写入合成选择，再把被它改动过的全局默认用 saveSelection 还原
20. 设标题为 `aat-{name}-{userSessionId}`
21. 写注册表（sessionId + turns=0）

### 阶段四：发起一轮（startTurn）

22. resolveAgent 解析子会话，失败返回错误
23. 拼一条用户消息（role=user、text 内容、随机 id）
24. 同步挂起一个 turn 等待器（监听收件箱认领 / 丢弃 / session 事件，带 agent.timeoutMs 超时）
25. 把消息 followup 发给子会话
26. 进入 advanceTurn 推进

### 阶段五：推进与交互（advanceTurn）

27. 竞速：pendingInteractions 里已有该会话的交互 → 立即返回交互；否则等 turnSettled 结束
28. 有交互 → 把本轮 turn 停进 parkedTurns，返回 question-required 交互体（问题列表 + 过期时间）
29. 无交互 → 把 turn 结束原因转成结果（completed / aborted / error / max-tokens / blocked / interrupted / timeout / discarded）

### 阶段六：审批与提问中继

审批：

30. 监听 approval/request，判断请求会话是否本插件拥有（driving / parked 之一）
31. 拥有 → 用父 agent 身份重新发起 ctx.approval.request（策略按父会话算，审计落父会话）
32. 与 approvalTimeoutMs 超时竞速；结果不在合法集（allowed-once / rejected / cancelled / unavailable）→ 判 rejected
33. 无父 agent / 抛错 / 超时 → 一律 rejected（fail closed，绝不默认放行）

提问：

34. 监听 user-questions/request，判断请求会话是否本插件拥有
35. 拥有 → 登记交互（question-{seq}、问题列表、过期时间=approvalTimeoutMs），挂超时
36. 校验答案：id 是否属于所问、是否重复答、selected 是否在选项内、单选是否只选一个
37. 答案回填 → 若该会话 turn 被停靠，则继续 advanceTurn

### 阶段七：回答提问（answerById）

38. 按 interactionId 取出 pending 交互，拿到它的 sessionId
39. 走 answerInteraction：校验答案、回填、续跑被停靠的 turn

## 配置项 / 入参

### 全局配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| registryDir | .dsh-agent-as-tool | 会话注册表目录（工作区内相对目录） |
| approvalTimeoutMs | 120000 | 审批/提问等待超时（毫秒） |
| agents | [] | 工具清单 |

### agents[] 每项

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| name | 是 | - | 工具名，需匹配 `[a-zA-Z0-9][a-zA-Z0-9_-]*` |
| description | 是 | - | 工具描述 |
| cwd | 是 | - | 子会话工作区（绝对路径） |
| agentPreset | 是 | - | 预设名 |
| model | 运行时必填 | - | 模型 id（不再跟随全局默认模型） |
| provider | 否 | 自动反查 | 模型所属 provider |
| reasoningEffort | 否 | 无 | low / high / max / off |
| permissionPreset | 否 | workspace-write | read-only / workspace-write / danger-full-access |
| approvalPolicy | 否 | ask | ask / never |
| timeoutMs | 否 | 600000 | 单轮超时（毫秒） |
| maxTurns | 否 | 0 | 会话复用轮数上限，0=不限 |

### 工具入参

| 参数 | 说明 |
|---|---|
| query | 要处理的内容（自然语言） |
| questionId | 回答结构化提问时用 |
| answers | 选项答案数组 |

## 关键设计点

| 设计点 | 说明 |
|---|---|
| 审批 fail closed | 工具参数无 approvalId / decision，模型无从自批；审批由父 agent 以自己身份重新发起，落到父会话的人类 answerer；无父 / 异常 / 超时一律 rejected |
| 会话复用与轮换 | 注册表按 (cwd, userSessionId, toolName) 存 sessionId + turns；maxTurns 到顶就归档换新，未到顶复用 |
| 归档单独判 | 归档只把会话从列表隐藏、resolveAgent 仍能解析到，不单独判会永远往已归档会话发消息 |
| 模型选择 | model 必填；provider 可省（默认 provider 有就用，没有遍历全表反查归属，唯一命中才用，多命中报错）；selectModel 会改全局默认，设完立刻还原 |
| 预检三件事 | 建会话前先验 cwd、agentPreset、provider/model/effort，任何一项不过都不建半成品会话 |
| 只 import 内置模块 | 除 node builtins 外全部从 ctx 拿，保证 link 安装不崩 |
