/**
 * dsh-agent-as-tool —— 把「智能体」封装成具名工具。
 *
 * 模型只调 tools.<工具名>({ query })。插件后台用官方 API 建/复用独立会话
 * （指定工作区 + 预设），拿回回答。
 *
 * 审批安全模型（v1.1 起）：
 * 子会话的 approval/request **不再**回传给调用方模型自答，而是由拥有该子会话的
 * 父 agent 以自己的身份重新发起官方审批 ctx.approval.request()，落到父会话的
 * answerer —— 也就是 GUI 前的人类。审计对（approval/asked + approval/decided）
 * 记在父会话日志里，父策略为 never 时直接在服务内拒绝。
 * 任何一环拿不到人类决定（无父 agent、异常、超时）一律 fail closed 成 rejected。
 * 因此本插件的工具 parameters 里**没有** approvalId/decision：模型无从自批。
 * 结构化提问（user-questions）仍保留透传，见 relayQuestion。
 *
 * 铁律：只 import node builtins，其余全从 ctx 拿（link 安装才不崩）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const name = 'agent-as-tool'
export const inject = ['tools', 'sessionController', 'workspaceRegistry', 'sessions', 'permissionPresets', 'approval']

const DEFAULTS = { registryDir: '.dsh-agent-as-tool', agents: [], approvalTimeoutMs: 120000 }
const REASONING_EFFORTS = ['low', 'high', 'max', 'off']
const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_POLICIES = ['ask', 'never']
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

function normalizeConfig(raw) {
  const input = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
  const issues = []
  const value = { ...DEFAULTS }
  if (typeof input.registryDir === 'string' && input.registryDir.trim() !== '') {
    const cleaned = input.registryDir.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    if (cleaned === '' || cleaned.includes('..')) issues.push({ message: 'registryDir 必须是工作区内的相对目录', path: ['registryDir'] })
    else value.registryDir = cleaned
  }
  if (input.approvalTimeoutMs !== undefined && input.approvalTimeoutMs !== null) {
    const n = Number(input.approvalTimeoutMs)
    if (!Number.isFinite(n) || n <= 0) issues.push({ message: 'approvalTimeoutMs 必须是正数', path: ['approvalTimeoutMs'] })
    else value.approvalTimeoutMs = Math.floor(n)
  }
  const rawAgents = Array.isArray(input.agents) ? input.agents : []
  const agents = []
  for (let i = 0; i < rawAgents.length; i++) {
    const a = rawAgents[i]
    const at = ['agents', i]
    if (a === null || typeof a !== 'object' || Array.isArray(a)) { issues.push({ message: 'agents[' + i + '] 必须是对象', path: at }); continue }
    if (typeof a.name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(a.name)) issues.push({ message: 'agents[' + i + '].name 必须是合法工具名', path: at })
    if (typeof a.description !== 'string' || a.description.trim() === '') issues.push({ message: 'agents[' + i + '].description 必填', path: at })
    if (typeof a.cwd !== 'string' || a.cwd.trim() === '') issues.push({ message: 'agents[' + i + '].cwd 必填', path: at })
    if (typeof a.agentPreset !== 'string' || a.agentPreset.trim() === '') issues.push({ message: 'agents[' + i + '].agentPreset 必填', path: at })
    if (a.reasoningEffort !== undefined && !REASONING_EFFORTS.includes(a.reasoningEffort)) issues.push({ message: 'agents[' + i + '].reasoningEffort 非法', path: at })
    if (a.provider !== undefined && (typeof a.provider !== 'string' || a.provider.trim() === '')) issues.push({ message: 'agents[' + i + '].provider 必须是非空字符串', path: at })
    if (a.model !== undefined && (typeof a.model !== 'string' || a.model.trim() === '')) issues.push({ message: 'agents[' + i + '].model 必须是非空字符串', path: at })
    if (a.permissionPreset !== undefined && !PERMISSION_PRESETS.includes(a.permissionPreset)) issues.push({ message: 'agents[' + i + '].permissionPreset 非法', path: at })
    if (a.approvalPolicy !== undefined && !APPROVAL_POLICIES.includes(a.approvalPolicy)) issues.push({ message: 'agents[' + i + '].approvalPolicy 非法', path: at })
    if (a.timeoutMs !== undefined && a.timeoutMs !== null) { const n = Number(a.timeoutMs); if (!Number.isFinite(n) || n <= 0) issues.push({ message: 'agents[' + i + '].timeoutMs 必须是正数', path: at }) }
    if (a.maxTurns !== undefined && a.maxTurns !== null) { const n = Number(a.maxTurns); if (!Number.isFinite(n) || n < 0) issues.push({ message: 'agents[' + i + '].maxTurns 必须是非负整数', path: at }) }
    agents.push({
      name: a.name, description: a.description.trim(), cwd: a.cwd.trim(), agentPreset: a.agentPreset.trim(),
      ...(a.provider === undefined ? {} : { provider: a.provider.trim() }),
      ...(a.model === undefined ? {} : { model: a.model.trim() }),
      ...(a.reasoningEffort === undefined ? {} : { reasoningEffort: a.reasoningEffort }),
      permissionPreset: a.permissionPreset ?? 'workspace-write',
      approvalPolicy: a.approvalPolicy ?? 'ask',
      timeoutMs: (a.timeoutMs === undefined || a.timeoutMs === null) ? 600000 : Math.floor(Number(a.timeoutMs)),
      maxTurns: (a.maxTurns === undefined || a.maxTurns === null) ? 0 : Math.floor(Number(a.maxTurns)),
    })
  }
  value.agents = agents
  return issues.length > 0 ? { issues } : { value }
}

export const Config = { '~standard': { version: 1, vendor: 'dsh-agent-as-tool', validate: normalizeConfig } }

function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, raw] of Object.entries(spec ?? {})) {
    const node = { ...raw }
    if (node.required === true) { required.push(key); delete node.required }
    properties[key] = node
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
}

function createHumanMessage(text) {
  const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const c of Object.values(v)) deepFreeze(c) } return v }
  return deepFreeze(message)
}

function joinAssistantText(parts) { return parts.filter(p => p.trim() !== '').join('\n\n') }

function validateQuestionAnswers(answers, questions) {
  if (!Array.isArray(answers)) return { error: 'answers must be an array.' }
  const byId = new Map(questions.map(q => [q.id, q]))
  const accepted = []
  const seen = new Set()
  for (const item of answers) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { error: 'each answer must be an object carrying an id.' }
    if (typeof item.id !== 'string' || !byId.has(item.id)) return { error: 'answer id ' + JSON.stringify(item.id) + ' is not one of the asked questions.' }
    if (seen.has(item.id)) return { error: 'question "' + item.id + '" was answered twice.' }
    seen.add(item.id)
    const q = byId.get(item.id)
    const selected = item.selected ?? []
    if (!Array.isArray(selected) || selected.some(l => typeof l !== 'string')) return { error: 'selected for question "' + item.id + '" must be an array of option labels.' }
    const offered = q.options ?? []
    for (const label of selected) { if (!offered.some(o => o.label === label)) return { error: 'question "' + item.id + '" was not offered the option ' + JSON.stringify(label) + '.' } }
    if (q.multiSelect !== true && selected.length > 1) return { error: 'question "' + item.id + '" is single-select.' }
    if (item.custom !== undefined && typeof item.custom !== 'string') return { error: 'custom for question "' + item.id + '" must be a string.' }
    accepted.push({ id: item.id, selected: [...selected], ...(item.custom === undefined ? {} : { custom: item.custom }) })
  }
  return { answers: accepted }
}

export function apply(ctx, config) {
  const resolved = config
  const log = ctx.logger
  const driving = new Set()
  const pendingInteractions = new Map()
  const parkedTurns = new Map()
  const interactionWaiters = new Map()
  // 子会话 → 拥有它的父 agent。审批中继用它把决定权交回人类通道。
  const parents = new Map()
  let interactionSeq = 0

  const announceInteraction = (sessionId) => {
    const waiters = interactionWaiters.get(sessionId)
    if (waiters === undefined) return
    interactionWaiters.delete(sessionId)
    for (const wake of [...waiters]) wake()
  }

  const raceInteraction = (sessionId, turnSettled) => new Promise((resolve) => {
    let done = false
    let wake
    const settle = (value) => { if (done) return; done = true; interactionWaiters.get(sessionId)?.delete(wake); resolve(value) }
    const firstPending = () => [...pendingInteractions.values()].find(e => e.sessionId === sessionId)
    const existing = firstPending()
    if (existing !== undefined) return settle({ kind: 'interaction', entry: existing })
    wake = () => { const e = firstPending(); if (e !== undefined) settle({ kind: 'interaction', entry: e }) }
    if (!interactionWaiters.has(sessionId)) interactionWaiters.set(sessionId, new Set())
    interactionWaiters.get(sessionId).add(wake)
    turnSettled.then(outcome => settle({ kind: 'turn', outcome }))
  })

  /**
   * 子会话要求审批时，用父 agent 的身份重新发起一次官方审批：策略按父会话算，
   * 分发到父会话的 answerer（人类 GUI），审计落在父会话日志。模型全程不参与决定。
   * 无父 agent / 父侧抛错 / 超时 → 'rejected'（fail closed，绝不默认放行）。
   */
  const relayApproval = async (request, sessionId) => {
    const parent = parents.get(sessionId)
    if (parent === undefined) {
      log?.warn?.('agent-as-tool: no parent agent recorded for session ' + sessionId + '; approval rejected')
      return 'rejected'
    }
    let timer
    try {
      const outcome = await Promise.race([
        ctx.approval.request({
          agent: parent,
          toolName: request.toolName,
          ...(request.callId === undefined ? {} : { callId: request.callId }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('rejected'), resolved.approvalTimeoutMs)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
      if (!APPROVAL_OUTCOMES.includes(outcome)) return 'rejected'
      if (outcome !== 'allowed-once') log?.warn?.('agent-as-tool: approval for ' + request.toolName + ' came back ' + outcome)
      return outcome
    } catch (error) {
      log?.warn?.('agent-as-tool: relayed approval failed: ' + String(error))
      return 'rejected'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const relayQuestion = (request, sessionId) => new Promise((resolve, reject) => {
    interactionSeq += 1
    const questionId = 'question-' + interactionSeq
    let timer
    let settled = false
    const entry = { kind: 'question', questionId, sessionId, questions: request.questions, requestedAt: Date.now(), expiresAt: Date.now() + resolved.approvalTimeoutMs }
    const onAbort = () => finish(() => reject(new Error('the question was cancelled')))
    const finish = (settle) => { if (settled) return; settled = true; clearTimeout(timer); request.signal?.removeEventListener?.('abort', onAbort); pendingInteractions.delete(questionId); settle() }
    entry.answer = (answers) => { const answered = !settled; finish(() => resolve({ answers })); return answered }
    timer = setTimeout(() => finish(() => reject(new Error('no answer within ' + resolved.approvalTimeoutMs + ' ms'))), resolved.approvalTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    request.signal?.addEventListener?.('abort', onAbort, { once: true })
    pendingInteractions.set(questionId, entry)
    announceInteraction(sessionId)
  })

  const waitForTurn = (sessionId, messageId, timeoutMs) => new Promise((resolve) => {
    let turn
    let settled = false
    const parts = []
    const disposers = []
    let timer
    const finish = (outcome) => { if (settled) return; settled = true; clearTimeout(timer); for (const d of disposers) { try { d() } catch {} } resolve(outcome) }
    const listen = (event, listener) => { const d = ctx.root.on(event, listener); if (typeof d === 'function') disposers.push(d) }
    timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    listen('agent/inbox/claimed', (payload) => { if (payload?.agent?.id !== sessionId) return; if (payload?.message?.id !== messageId) return; turn = payload.turn })
    listen('agent/inbox/discarded', (payload) => { if (payload?.message?.id !== messageId) return; finish({ kind: 'discarded' }) })
    listen('session/event', (session, event) => {
      if (session?.id !== sessionId) return
      if (event?.type === 'assistant/message') { if (turn === undefined || event.data.turn !== turn) return; for (const b of event.data.message?.content ?? []) { if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text) } return }
      if (event?.type !== 'turn/end') return
      if (turn === undefined || event.data.turn !== turn) return
      finish({ kind: 'ended', turn, reason: event.data.reason, text: joinAssistantText(parts) })
    })
  })

  const describeTurnEnd = (reason) => {
    const kind = reason?.kind ?? 'unknown'
    if (kind === 'completed') return { code: 'completed', message: 'Turn completed.' }
    if (kind === 'aborted') return { code: 'aborted', message: 'Turn was aborted.' }
    if (kind === 'error') return { code: 'error', message: reason?.error?.message ?? 'Turn failed.' }
    if (kind === 'max-tokens') return { code: 'max-tokens', message: 'Turn stopped at the output-token cap.' }
    if (kind === 'blocked') return { code: 'blocked', message: 'Turn was blocked.' }
    if (kind === 'interrupted') return { code: 'interrupted', message: 'Turn was interrupted.' }
    return { code: String(kind), message: 'Turn ended with reason "' + String(kind) + '".' }
  }

  const interactionBody = (sessionId, entry) => ({ sessionId, status: 'question-required', questionId: entry.questionId, questions: entry.questions, expiresAt: entry.expiresAt })

  const turnResult = (outcome) => {
    if (outcome.kind === 'timeout') return { status: 'timeout', completed: false, text: '' }
    if (outcome.kind === 'discarded') return { status: 'discarded', completed: false, text: '' }
    const described = describeTurnEnd(outcome.reason)
    return { turn: outcome.turn, completed: described.code === 'completed', code: described.code, text: outcome.text }
  }

  const advanceTurn = async (sessionId, messageId, turnSettled) => {
    driving.add(sessionId)
    try {
      const raced = await raceInteraction(sessionId, turnSettled)
      if (raced.kind === 'interaction') {
        const parked = { turnSettled, messageId }
        parkedTurns.set(sessionId, parked)
        void turnSettled.then(() => { if (parkedTurns.get(sessionId) === parked) parkedTurns.delete(sessionId) })
        return interactionBody(sessionId, raced.entry)
      }
      return turnResult(raced.outcome)
    } finally { driving.delete(sessionId) }
  }

  const answerInteraction = async (sessionId, interactionId, reply) => {
    const entry = pendingInteractions.get(interactionId)
    if (entry === undefined || entry.sessionId !== sessionId) return { error: 'interaction "' + interactionId + '" is not pending for session "' + sessionId + '".' }
    const parked = parkedTurns.get(sessionId)
    const validated = validateQuestionAnswers(reply, entry.questions)
    if (validated.error !== undefined) return { error: validated.error }
    entry.answer(validated.answers)
    if (parked === undefined) return { status: 'answered', interactionId }
    return advanceTurn(sessionId, parked.messageId, parked.turnSettled)
  }

  const isOwned = (sessionId) => driving.has(sessionId) || parkedTurns.has(sessionId)

  ctx.effect(() => ctx.root.on('approval/request', (request, next) => { const sid = request?.agent?.session?.id; if (sid === undefined || !isOwned(sid)) return next(); return relayApproval(request, sid) }, { prepend: true }), 'agent-as-tool: human-routed approval answerer')
  ctx.effect(() => ctx.root.on('user-questions/request', (request, next) => { const sid = request?.agent?.session?.id; if (sid === undefined || !isOwned(sid)) return next(); return relayQuestion(request, sid) }, { prepend: true }), 'agent-as-tool: relayed user-question answerer')
  ctx.effect(() => () => { for (const entry of [...pendingInteractions.values()]) entry.answer([]) }, 'agent-as-tool: drain relayed interactions')

  const readRegistry = (cwd, userSessionId, toolName) => { try { const raw = JSON.parse(readFileSync(join(cwd, resolved.registryDir, userSessionId, toolName + '.json'), 'utf8')); return (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {} } catch { return {} } }
  const writeRegistry = (cwd, userSessionId, toolName, value) => { try { const dir = join(cwd, resolved.registryDir, userSessionId); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, toolName + '.json'), JSON.stringify(value, null, 2), 'utf8') } catch (error) { log?.warn?.('agent-as-tool: write registry failed: ' + String(error)) } }

  const applyPermissionPosture = async (sessionId, agent) => {
    const result = await ctx.sessionController.resolveAgent(sessionId)
    if (result?.error !== undefined || result?.agent === undefined) return
    const a = result.agent
    if (agent.permissionPreset !== undefined) ctx.permissionPresets.set(a.session, agent.permissionPreset)
    ctx.approval.setPolicy(a, agent.approvalPolicy)
  }

  /**
   * 只写了 model 时反查它属于哪个 provider：遍历已注册 provider，逐个列模型找 id 命中。
   * 唯一命中就用它；多家都有或都没命中则返回 undefined，交给调用方报错（不猜）。
   */
  const providerForModel = async (llm, model) => {
    let providers = []
    try { providers = llm.listProviders() ?? [] } catch (e) {
      log?.warn?.('agent-as-tool: listProviders failed: ' + String(e))
      return undefined
    }
    const matches = []
    for (const info of providers) {
      const provider = info?.id
      if (typeof provider !== 'string' || provider === '') continue
      try {
        const models = await llm.listModels(provider)
        if (Array.isArray(models) && models.some((m) => m?.id === model)) matches.push(provider)
      } catch (e) { /* 这家列不出模型就跳过 */ }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      log?.warn?.('agent-as-tool: 模型 ' + model + ' 在多家 provider 下都存在（' + matches.join(', ') + '），请显式写 provider')
    }
    return undefined
  }

  /**
   * 解析该工具要用的模型。模型现在是**必填**：
   *   1. 没写 model → 直接报错（不建会话、也不再跟随全局默认）；
   *   2. 写了 model 但反查不到 provider / 模型不存在 → 同样报错不建。
   * provider 仍可省：默认 provider 有这个模型就用默认，没有就遍历所有 provider 反查归属。
   */
  const resolveSelection = async (agent) => {
    if (agent.model === undefined || String(agent.model).trim() === '') {
      return { wants: true, problem: '未指定 model：每个 agent 必须显式配置 model（不再跟随全局默认模型）' }
    }
    if (agent.provider !== undefined && (typeof agent.provider !== 'string' || agent.provider.trim() === '')) {
      return { wants: true, problem: 'provider 必须是非空字符串' }
    }
    let base
    try { base = ctx.get('agentDefaultModel')?.currentSelection?.() } catch (e) { base = undefined }
    const model = String(agent.model).trim()
    let provider = agent.provider === undefined ? undefined : agent.provider.trim()
    if (provider === undefined) {
      const llm = ctx.get('llm')
      // 默认 provider 就有这个模型 → 直接用（常见情形，不扫全表）
      if (llm !== undefined && typeof base?.provider === 'string') {
        try {
          const models = await llm.listModels(base.provider)
          if (Array.isArray(models) && models.some((m) => m?.id === model)) provider = base.provider
        } catch (e) { /* 落到全表反查 */ }
      }
      // 默认 provider 没有它（例如 doubao 系）→ 遍历所有 provider 反查
      if (provider === undefined && llm !== undefined) {
        provider = await providerForModel(llm, model)
      }
    }
    if (provider === undefined || provider === '') {
      return { wants: true, problem: '找不到模型「' + model + '」所属的 provider：请确认 model id 正确，或显式写 provider' }
    }
    return {
      wants: true,
      base,
      selection: { provider, model, ...(agent.reasoningEffort === undefined ? {} : { reasoningEffort: agent.reasoningEffort }) },
    }
  }

  /**
   * 把合成后的选择装到子会话上。
   *
   * 只能走公开的 selectModel()：它会把选择存成**全局默认**，所以设完立刻用
   * currentSelection() 读到的旧值还原，免得给 mom 指定模型后把别的会话默认也改掉。
   */
  const applyModelSelection = async (sessionId, agent) => {
    const resolved = await resolveSelection(agent)
    if (!resolved.wants) return
    if (resolved.problem !== undefined) {
      log?.warn?.('agent-as-tool: ' + agent.name + ' 跳过模型设置：' + resolved.problem)
      return
    }
    const defaults = ctx.get('agentDefaultModel')
    try {
      await ctx.sessionController.selectModel({ sessionId, ...resolved.selection })
    } catch (e) {
      log?.warn?.('agent-as-tool: selectModel failed for ' + agent.name + ': ' + String(e))
      return
    }
    if (resolved.base !== undefined && typeof defaults?.saveSelection === 'function') {
      try { await defaults.saveSelection(resolved.base) } catch (e) { log?.warn?.('agent-as-tool: restore default model failed: ' + String(e)) }
    }
  }

  const attachWorkspace = async (agent, sessionId) => {
    let workspace = await ctx.workspaceRegistry.resolveByPath(agent.cwd)
    workspace ??= await ctx.workspaceRegistry.create(agent.cwd)
    await workspace.attachSession(sessionId)
    return workspace
  }

  const setTitle = async (sessionId, title) => {
    try {
      const titles = ctx.get('sessionTitle')
      if (titles === undefined) return
      const r = await ctx.sessionController.resolveAgent(sessionId)
      if (r?.agent === undefined) return
      titles.rename(r.agent.session, title)
    } catch (e) { log?.warn?.('agent-as-tool: set title failed: ' + String(e)) }
  }

  /**
   * 建会话之前先预检三件事，任何一件不过就返回错误，不留半成品会话：
   *   1. 工作区 cwd —— 必须绝对路径，且目录可建/可进入；
   *   2. agentPreset —— 必须能被预设名册解析到；
   *   3. provider / model / effort（写了才检）—— 合成后的选择必须能被 llm 解析（provider 已注册、模型存在、effort 支持）。
   * @returns 人类可读的问题描述；全部通过时返回 undefined。
   */
  const preflight = async (agent) => {
    const cwd = String(agent.cwd ?? '').trim()
    if (cwd === '' || !isAbsolute(cwd)) return '工作区必须是绝对路径，当前为「' + cwd + '」'
    try { mkdirSync(cwd, { recursive: true }) } catch (e) {
      return '工作区不可用（' + cwd + '）：' + (e instanceof Error ? e.message : String(e))
    }
    const presets = ctx.get('agentPresets')
    if (presets === undefined) return '预设服务不可用，无法确认 agentPreset'
    try { await presets.resolve(agent.agentPreset) } catch (e) {
      return '预设不存在或不可用（' + agent.agentPreset + '）：' + (e instanceof Error ? e.message : String(e))
    }
    const resolvedModel = await resolveSelection(agent)
    if (resolvedModel.wants) {
      if (resolvedModel.problem !== undefined) return resolvedModel.problem
      const llm = ctx.get('llm')
      if (llm === undefined) return '模型服务不可用，无法确认 provider / model'
      try {
        await llm.resolveCallConfig(resolvedModel.selection)
      } catch (e) {
        return '模型不可用（' + resolvedModel.selection.provider + '/' + resolvedModel.selection.model + '）：' + (e instanceof Error ? e.message : String(e))
      }
    }
    return undefined
  }

  const ensureSession = async (agent, cwd, userSessionId) => {
    const reg = readRegistry(cwd, userSessionId, agent.name)
    const stored = typeof reg.sessionId === 'string' ? reg.sessionId : undefined
    const turns = typeof reg.turns === 'number' ? reg.turns : 0
    if (stored !== undefined) {
      const rotate = agent.maxTurns > 0 && turns >= agent.maxTurns
      // 归档只把会话从列表里隐藏，resolveAgent 照样能解析到它 —— 所以归档必须单独判，
      // 否则用户归档了子会话，插件仍会继续往那个会话里发消息，永远走不到新建。
      let archived = false
      try {
        const archivedSet = ctx.workspaceRegistry.archivedSessionIds
        archived = Array.isArray(archivedSet) && archivedSet.includes(stored)
      } catch (e) { log?.warn?.('agent-as-tool: read archived session set failed: ' + String(e)) }
      if (archived) log?.info?.('agent-as-tool: stored session ' + stored + ' is archived; starting a fresh session')
      if (rotate || archived) {
        // 已在归档集里的无需再归档；只有轮数到顶才需要归档旧的。
        if (rotate && !archived) { try { ctx.workspaceRegistry.archiveSession(stored) } catch (e) { log?.warn?.('agent-as-tool: archive failed: ' + String(e)) } }
      } else {
        const r = await ctx.sessionController.resolveAgent(stored)
        if (r?.agent !== undefined) return { sessionId: stored, turns }
      }
    }
    // 复用分支走完才到这里：真要新建会话了，先预检，任何一项不过都不建。
    const problem = await preflight(agent)
    if (problem !== undefined) return { error: problem }
    const created = await ctx.sessionController.create({ cwd: agent.cwd, agentPreset: agent.agentPreset })
    await attachWorkspace(agent, created.sessionId)
    await applyPermissionPosture(created.sessionId, agent)
    await applyModelSelection(created.sessionId, agent)
    await setTitle(created.sessionId, 'aat-' + agent.name + '-' + userSessionId)
    writeRegistry(cwd, userSessionId, agent.name, { sessionId: created.sessionId, turns: 0 })
    return { sessionId: created.sessionId, turns: 0 }
  }

  const startTurn = async (agent, sessionId, text) => {
    const result = await ctx.sessionController.resolveAgent(sessionId)
    if (result?.error !== undefined || result?.agent === undefined) return { error: 'session "' + sessionId + '" could not be resolved.' }
    const message = createHumanMessage(text)
    const pending = waitForTurn(sessionId, message.id, agent.timeoutMs)
    result.agent.followup(message)
    return advanceTurn(sessionId, message.id, pending)
  }

  const answerById = async (interactionId, reply) => { const entry = pendingInteractions.get(interactionId); if (entry === undefined) return { error: 'interaction "' + interactionId + '" 不存在或已过期' }; return answerInteraction(entry.sessionId, interactionId, reply) }

  for (const agent of resolved.agents) {
    ctx.tools.register({
      name: agent.name,
      description: agent.description,
      // 注意：这里刻意不提供 approvalId/decision。审批只走人类通道，
      // 调用方模型没有任何表达 allow/deny 的入口。
      parameters: compileParameters({
        query: { type: 'string', description: '要处理的内容（自然语言描述）' },
        questionId: { type: 'string', description: '回答选项时用' },
        answers: { type: 'array', items: { type: 'object' }, description: '选项答案' },
      }),
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => { const text = (value && typeof value.text === 'string' && value.text.trim() !== '') ? value.text : JSON.stringify(value, null, 2); return [{ type: 'text', text }] },
      },
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error('agent-as-tool requires a calling agent (exec.agent was undefined)')
        const userSessionId = parent.session.header.id
        const cwd = parent.session.header.cwd ?? ''
        if (args.questionId !== undefined) return answerById(args.questionId, args.answers)
        if (args.query === undefined || String(args.query).trim() === '') return { error: 'query 不能为空' }
        const ensured = await ensureSession(agent, cwd, userSessionId)
        if (ensured?.error !== undefined) return { error: ensured.error }
        parents.set(ensured.sessionId, parent)
        const result = await startTurn(agent, ensured.sessionId, String(args.query))
        if (result !== null && typeof result === 'object' && typeof result.turn === 'number') writeRegistry(cwd, userSessionId, agent.name, { sessionId: ensured.sessionId, turns: result.turn })
        return result
      },
    })
  }
}
