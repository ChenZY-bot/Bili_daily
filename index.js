/**
 * bili-daily —— 每天抓取 B 站昨日全站日榜前 N 视频，归档到 MySQL，生成词云与分析报告，
 * 并在 DSH Web 端的独立页面中展示。
 *
 * 架构：
 *   - 本文件（Host 半）：调度 Python 采集脚本、调用大模型生成分析、暴露 HTTP 数据接口、注册 Agent 工具。
 *   - client.js（Client 半）：侧边栏入口 + 全屏数据看板页面。
 *   - python/bili_daily.py：抓取、入库、15 天滚动清理、生成词云与报告 JSON。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'bili-daily'
export const inject = ['tools', 'webServer']

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(ROOT, 'python', 'bili_daily.py')

/** 默认配置；插件行 config 中的同名字段覆盖。 */
const DEFAULTS = {
  pythonPath: '',
  mysqlHost: '127.0.0.1',
  mysqlPort: 3306,
  mysqlUser: 'root',
  mysqlPassword: '',
  database: 'BiliBili',
  topN: 5,
  retentionDays: 15,
  dataDir: '',
  provider: '',
  model: '',
  autoRun: true,
}


const SYSTEM_PROMPT = [
  '你是 B 站内容数据分析师。依据给定的当日热榜数据与历史统计，写一份中文数据简报。',
  '要求：',
  '1. 使用 Markdown，二级标题分节：## 今日热点概览 / ## 分区与标签趋势 / ## 评论关注点 / ## 运营建议。',
  '2. 只依据输入数据推断，不要编造不存在的数据、播放量或评论；数据不足时直接说明。',
  '3. 每节 2-5 句，总长度 400-700 字，具体到 BV 号、分区、标签与 UP 主。',
  '4. 不要输出代码块，不要复述原始 JSON。',
].join('\n')

function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 大模型可见的紧凑输入，避免把整个报告塞进提示词。 */
function buildPrompt(report) {
  const videos = (report.videos || []).map(v => ({
    rank: v.rank,
    bv: v.bv,
    title: v.title,
    category: v.category,
    tags: v.tags,
    up: v.up,
    duration: v.durationText,
    play: v.play,
    like: v.like,
    reply: v.reply,
    comments: (v.comments || []).slice(0, 3).map(c => ({ like: c.like, text: c.content })),
  }))
  const payload = {
    crawlDate: report.crawlDate,
    topN: report.topN,
    videos,
    history: report.history,
    tagKeywords: (report.wordStats?.tagToday || []).slice(0, 15).map(w => w[0]),
    commentKeywords: (report.wordStats?.commentToday || []).slice(0, 15).map(w => w[0]),
    historyTagKeywords: (report.wordStats?.tagHistory || []).slice(0, 15).map(w => w[0]),
  }
  return `以下是 ${report.crawlDate} 的 B 站全站日榜数据（JSON）：\n${JSON.stringify(payload)}`
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 有副作用的接口只接受同源 POST：浏览器发起的 fetch 会带上 Origin / Sec-Fetch-Site，
 * 其他网页的 <img>/<a> 或跨站 POST 会被拒绝。
 */
function guardMutation(req, res) {
  if ((req.method || 'GET').toUpperCase() !== 'POST') {
    res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
    res.end('method not allowed')
    return false
  }
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('forbidden')
    return false
  }
  const origin = req.headers.origin
  if (origin) {
    const host = req.headers.host
    if (!host || origin !== `http://${host}`) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return false
    }
  }
  return true
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(config || {}) }
  const dataDir = settings.dataDir && settings.dataDir.trim()
    ? path.resolve(settings.dataDir.trim())
    : path.join(ROOT, 'data')
  const reportPath = path.join(dataDir, 'report.json')
  fs.mkdirSync(dataDir, { recursive: true })

  const state = {
    running: false,
    step: 'idle',
    startedAt: null,
    finishedAt: null,
    lastError: null,
    lastRunDate: null,
    steps: [],
  }
  let pending = null

  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    BILI_DB_HOST: String(settings.mysqlHost || '127.0.0.1'),
    BILI_DB_PORT: String(settings.mysqlPort || 3306),
    BILI_DB_USER: String(settings.mysqlUser || 'root'),
    BILI_DB_PASSWORD: String(settings.mysqlPassword ?? ''),
    BILI_DB_NAME: String(settings.database || 'BiliBili'),
    BILI_TOP_N: String(settings.topN || 5),
    BILI_RETENTION_DAYS: String(settings.retentionDays || 15),
    BILI_DATA_DIR: dataDir,
  }

  function step(label) {
    state.step = label
    state.steps.push({ at: new Date().toISOString(), label })
    if (state.steps.length > 40) state.steps.shift()
  }

  /** 运行一次 Python 脚本，返回 { code, stdout, stderr }。 */
  function runPython(command, timeoutMs = 300000) {
    return new Promise((resolve, reject) => {
      const python = settings.pythonPath && settings.pythonPath.trim() ? settings.pythonPath.trim() : 'python'
      const args = [SCRIPT, command, '--data-dir', dataDir]
      let stdout = ''
      let stderr = ''
      let child
      try {
        child = spawn(python, args, { env, windowsHide: true, cwd: ROOT })
      } catch (error) {
        reject(error)
        return
      }
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        reject(new Error(`Python 脚本超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      child.stdout?.on('data', chunk => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', chunk => { stderr += chunk.toString('utf8') })
      child.on('error', error => {
        clearTimeout(timer)
        reject(new Error(`无法启动 Python（${python}）：${error.message}`))
      })
      child.on('close', code => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
    })
  }

  /** 解析脚本最后一行 JSON 输出。 */
  function parseResult(result) {
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i])
      } catch {}
    }
    return undefined
  }

  async function readReport() {
    try {
      const text = await fsp.readFile(reportPath, 'utf8')
      const report = JSON.parse(text)
      if (!report || typeof report !== 'object') return null
      return report
    } catch {
      return null
    }
  }

  function analysisPath(date) {
    return path.join(dataDir, `analysis-${date}.json`)
  }

  async function readAnalysis(date) {
    try {
      return JSON.parse(await fsp.readFile(analysisPath(date), 'utf8'))
    } catch {
      return null
    }
  }

  async function analyze(report) {
    const llm = ctx.get('llm')
    if (!llm) return { ok: false, error: '当前部署没有可用的 llm 服务' }
    let provider = settings.provider && settings.provider.trim()
    let model = settings.model && settings.model.trim()
    if (!provider || !model) {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      provider = provider || selection?.provider
      model = model || selection?.model
    }
    if (!provider || !model) return { ok: false, error: '未配置 provider/model，且无法读取默认模型' }

    // 推理型模型可能把 token 预算全部花在 reasoning 上，这里取支持的最低推理档位。
    let reasoningEffort
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info?.reasoning?.efforts || []
      if (efforts.length > 0) reasoningEffort = efforts[0].id
    } catch {}

    const prompt = buildPrompt(report)
    let last = null
    for (const budget of [4096, 8192]) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 110000)
      try {
        const call = await llm.prepareCall({
          provider,
          model,
          maxTokens: budget,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        }, controller.signal)
        const parts = []
        const blocks = []
        const chunkTypes = {}
        let finish
        for await (const chunk of call.stream({
          ...call.config,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          system: SYSTEM_PROMPT,
          signal: controller.signal,
        })) {
          chunkTypes[chunk.type] = (chunkTypes[chunk.type] || 0) + 1
          if (chunk.type === 'text-delta') parts.push(chunk.text)
          if (chunk.type === 'block-end' && chunk.block?.type === 'text') blocks.push(chunk.block.text)
          if (chunk.type === 'finish') finish = chunk.reason
          if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
            throw new Error(chunk.reason.failure?.message || '模型调用失败')
          }
        }
        const text = (parts.join('') || blocks.join('')).trim()
        last = { chunkTypes, finish: finish?.kind ?? null }
        if (text) {
          const payload = { date: report.crawlDate, text, provider, model, createdAt: new Date().toISOString() }
          await fsp.writeFile(analysisPath(report.crawlDate), JSON.stringify(payload, null, 2), 'utf8')
          return { ok: true, ...payload, debug: last }
        }
        if (finish?.kind !== 'max-tokens') break
      } finally {
        clearTimeout(timer)
      }
    }
    return {
      ok: false,
      provider,
      model,
      error: `模型未返回文本（finish=${last?.finish ?? 'none'}）`,
      debug: last,
    }
  }

  async function pipeline(reason = 'manual') {
    if (pending) return pending
    state.running = true
    state.lastError = null
    state.startedAt = new Date().toISOString()
    state.finishedAt = null
    state.steps = []
    step('crawl')
    pending = (async () => {
      try {
        const result = await runPython('run')
        const parsed = parseResult(result)
        if (!parsed || parsed.ok !== true) {
          const detail = parsed?.error || result.stderr.trim().split(/\r?\n/).slice(-4).join(' | ') || `退出码 ${result.code}`
          throw new Error(detail)
        }
        const report = await readReport()
        if (!report) throw new Error('报告文件未生成')
        state.lastRunDate = report.crawlDate
        step('analyze')
        try {
          const analysis = await analyze(report)
          if (!analysis.ok) state.lastError = `分析文本生成失败：${analysis.error}`
          else await fsp.writeFile(reportPath, JSON.stringify({ ...report, analysis: analysis.text }, null, 2), 'utf8')
        } catch (error) {
          state.lastError = `分析文本生成失败：${error.message}`
        }
        step('done')
        return report
      } catch (error) {
        state.lastError = error.message
        step('failed')
        throw error
      } finally {
        state.running = false
        state.finishedAt = new Date().toISOString()
        pending = null
      }
    })()
    return pending
  }

  async function composePayload() {
    const report = await readReport()
    if (!report) return { ok: false, reason: 'no-data', run: { ...state }, dataDir }
    let analysis = report.analysis || ''
    if (!analysis) {
      const cached = await readAnalysis(report.crawlDate)
      if (cached?.text) analysis = cached.text
    }
    return {
      ok: true,
      report: { ...report, analysis },
      run: { ...state },
      config: { topN: settings.topN, retentionDays: settings.retentionDays, database: settings.database },
    }
  }

  // ------------------------------------------------------------------ HTTP 接口

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-daily/api/report',
    handler: async (req, res) => {
      try {
        sendJson(res, 200, await composePayload())
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-daily/api/run',
    handler: async (req, res) => {
      if (!guardMutation(req, res)) return
      const url = new URL(req.url || '/', 'http://localhost')
      const force = url.searchParams.get('force') === '1'
      const today = yesterday()
      const current = await readReport()
      if (state.running) {
        sendJson(res, 202, { ok: true, started: false, running: true, run: { ...state } })
        return
      }
      if (!force && current?.crawlDate === today) {
        sendJson(res, 200, { ok: true, started: false, running: false, upToDate: true, crawlDate: current.crawlDate })
        return
      }
      pipeline(force ? 'force' : 'api').catch(() => {})
      sendJson(res, 202, { ok: true, started: true, running: true, run: { ...state } })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-daily/api/health',
    handler: async (req, res) => {
      let clientInGraph = null
      try {
        const modules = ctx.get('clientModules')
        clientInGraph = modules ? JSON.stringify(modules.graph()).includes('@local/bili-daily') : null
      } catch {}
      sendJson(res, 200, {
        ok: true,
        plugin: '@local/bili-daily',
        clientInGraph,
        running: state.running,
        step: state.step,
        lastError: state.lastError,
        dataDir,
        pythonPath: settings.pythonPath,
        database: settings.database,
      })
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/bili-daily/api/analyze',
    handler: async (req, res) => {
      if (!guardMutation(req, res)) return
      try {
        const report = await readReport()
        if (!report) {
          sendJson(res, 200, { ok: false, error: '尚无报告数据，请先采集' })
          return
        }
        const analysis = await analyze(report)
        if (analysis.ok) {
          await fsp.writeFile(reportPath, JSON.stringify({ ...report, analysis: analysis.text }, null, 2), 'utf8')
        }
        sendJson(res, 200, analysis)
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message })
      }
    },
  }))

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/bili-daily/assets',
    handler: async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname)
        const fileName = pathname.slice('/bili-daily/assets/'.length)
        if (!/^[A-Za-z0-9_.-]+\.png$/.test(fileName)) {
          res.writeHead(400)
          res.end('bad asset name')
          return
        }
        const file = path.join(dataDir, fileName)
        if (!file.startsWith(dataDir)) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const bytes = await fsp.readFile(file)
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': String(bytes.length),
          'cache-control': 'public, max-age=300',
        })
        res.end(bytes)
      } catch {
        res.writeHead(404)
        res.end('not found')
      }
    },
  }))

  // ------------------------------------------------------------------ 自动调度

  async function ensureFresh() {
    if (settings.autoRun === false) return
    if (state.running) return
    try {
      const report = await readReport()
      if (report?.crawlDate === yesterday()) return
      await pipeline('auto')
    } catch (error) {
      state.lastError = error.message
    }
  }

  ctx.effect(() => {
    const boot = setTimeout(() => { ensureFresh() }, 8000)
    const tick = setInterval(() => { ensureFresh() }, 30 * 60 * 1000)
    return () => {
      clearTimeout(boot)
      clearInterval(tick)
    }
  })

  // ------------------------------------------------------------------ Agent 工具

  const STEP_LABELS = {
    idle: '空闲',
    crawl: '抓取榜单与热评',
    analyze: '生成模型分析',
    done: '完成',
    failed: '失败',
  }
  const stepLabel = step => STEP_LABELS[step] || step || '处理中'

  ctx.effect(() => ctx.tools.register({
    name: 'bili_daily',
    description:
      'BiliBili 每日热榜：抓取昨日全站日榜前 N 视频（BV 号、分区、标签、时长、UP 主）与每条视频的前三热评，'
      + '写入 MySQL，并生成词云与数据报告。action=status 查看采集状态与最新数据概况；'
      + 'action=run 立即重新采集；action=report 返回最新分析报告摘要。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'run', 'report'],
        description: 'status 查看状态；run 立即采集（同一时间只会有一个任务）；report 返回最新报告摘要。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'text'],
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const action = args?.action || 'status'
      if (action === 'run') {
        if (state.running) {
          return { ok: true, text: `已有采集任务在运行：${stepLabel(state.step)}。` }
        }
        pipeline('tool').catch(() => {})
        return {
          ok: true,
          text: '已开始在后台采集昨日榜单（抓取→入库→清理→词云→模型分析）。稍后用 action=status 查看进度，完成后 action=report 获取摘要。',
        }
      }
      const payload = await composePayload()
      if (!payload.ok) {
        return {
          ok: false,
          text: `尚无采集数据（${state.running ? `正在采集：${stepLabel(state.step)}` : state.lastError || '未运行'}）。可执行 action=run 立即采集。`,
        }
      }
      const report = payload.report
      if (action === 'report') {
        const lines = report.videos
          .map(v => `${v.rank}. ${v.bv}｜${v.category}｜${v.up}｜${v.durationText}｜${v.play} 播放｜${v.tags.slice(0, 4).join('、')}`)
        const parts = [
          `B 站 ${report.crawlDate} 全站日榜 Top${report.videos.length}`,
          ...lines,
          `历史：${report.history.videos} 条视频 / ${report.history.days} 天 / ${report.history.comments} 条评论`,
        ]
        if (report.analysis) parts.push('', '## 模型分析', report.analysis)
        return { ok: true, text: parts.join('\n') }
      }
      return {
        ok: true,
        text: [
          `数据归属日：${report.crawlDate}`,
          `当日视频：${report.videos.length} 条；历史视频：${report.history.videos} 条（${report.history.days} 天）；历史评论：${report.history.comments} 条`,
          `分区分布：${report.history.categories.map(c => `${c.category} ${c.count}`).join('、')}`,
          `运行状态：${state.running ? `进行中（${stepLabel(state.step)}）` : '空闲'}${state.lastError ? `；最近错误：${state.lastError}` : ''}`,
          `数据目录：${dataDir}`,
          '可视化看板：左侧边栏底部的「B站日报」按钮。',
        ].join('\n'),
      }
    },
  }))
}
