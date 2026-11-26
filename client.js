/**
 * bili-daily Client 半：侧边栏入口 + 全屏数据看板。
 * 数据来自 Host 半注册的同源 HTTP 接口：
 *   GET  /bili-daily/api/report   报告 JSON
 *   POST /bili-daily/api/run      触发采集（?force=1 强制）
 *   POST /bili-daily/api/analyze  仅重新生成模型分析
 *   GET  /bili-daily/assets/*.png 词云图片
 */
window.__ModuleLoader__.load({
  id: '@local/bili-daily',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ---------------------------------------------------------------- 打开状态
    const store = { open: false, listeners: new Set() }
    function setOpen(value) {
      if (store.open === value) return
      store.open = value
      for (const listener of store.listeners) listener()
    }
    function subscribe(listener) {
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }
    function useOpen() {
      const [open, setLocal] = React.useState(store.open)
      React.useEffect(() => {
        setLocal(store.open)
        return subscribe(() => setLocal(store.open))
      }, [])
      return open
    }

    // ---------------------------------------------------------------- 样式
    const S = {
      page: {
        position: 'absolute',
        inset: 0,
        zIndex: 1000,
        pointerEvents: 'auto',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        overflowY: 'auto',
        fontFamily: 'inherit',
        fontSize: 14,
      },
      header: {
        position: 'sticky',
        top: 0,
        zIndex: 2,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 12,
        padding: '14px 24px',
        background: 'var(--dsw-alias-bg-base)',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      title: { fontSize: 17, fontWeight: 600, margin: 0 },
      sub: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      spacer: { flex: 1, minWidth: 0 },
      main: { maxWidth: 1180, margin: '0 auto', padding: '20px 24px 64px', display: 'flex', flexDirection: 'column', gap: 20 },
      card: {
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 12,
        padding: 16,
      },
      cardTitle: { fontSize: 15, fontWeight: 600, margin: '0 0 4px' },
      cardHint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 14px' },
      grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 },
      stat: {
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
        whiteSpace: 'nowrap',
      },
      statValue: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: {
        textAlign: 'left',
        padding: '8px 10px',
        fontWeight: 500,
        color: 'var(--dsw-alias-label-secondary)',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '9px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        verticalAlign: 'top',
      },
      link: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none', fontFamily: 'ui-monospace, Consolas, monospace' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 },
      tag: {
        display: 'inline-block',
        margin: '0 6px 6px 0',
        padding: '1px 8px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
      },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      primary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        borderRadius: 8,
        padding: '6px 12px',
        fontSize: 13,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      icon: { width: 20, height: 20, display: 'block' },
      cloud: { width: '100%', height: 'auto', display: 'block' },
      error: {
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 13,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      },
      empty: { padding: '40px 0', textAlign: 'center', color: 'var(--dsw-alias-label-secondary)' },
      details: { marginTop: 12 },
      summary: { cursor: 'pointer', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      comment: {
        display: 'grid',
        gridTemplateColumns: '64px 1fr',
        gap: 10,
        padding: '8px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 13,
        lineHeight: 1.65,
      },
      like: { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12 },
      md: { fontSize: 14, lineHeight: 1.75, color: 'var(--dsw-alias-label-primary)' },
    }

    const CSS = `
.bili-launch { display: inline-flex; align-items: center; gap: 6px; height: 28px; max-width: 100%; padding: 0 8px;
  border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 12px; cursor: pointer; overflow: hidden; white-space: nowrap; }
.bili-launch:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.bili-launch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.bili-btn:hover { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.bili-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.bili-row:hover td { background: var(--dsw-alias-bg-layer-2); }
`

    const STEP_LABELS = {
      idle: '空闲',
      crawl: '抓取榜单与热评',
      analyze: '生成模型分析',
      done: '完成',
      failed: '失败',
    }
    function stepLabel(step) {
      return STEP_LABELS[step] || step || '处理中'
    }

    // ---------------------------------------------------------------- 工具函数
    function assetUrl(name, version) {
      return `/bili-daily/assets/${encodeURIComponent(name)}?v=${encodeURIComponent(version || '')}`
    }

    function inline(text, prefix) {
      const parts = []
      const re = /\*\*(.+?)\*\*/g
      let last = 0
      let match
      let index = 0
      while ((match = re.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index))
        parts.push(h('strong', { key: `${prefix}-b${index++}` }, match[1]))
        last = match.index + match[0].length
      }
      if (last < text.length) parts.push(text.slice(last))
      return parts
    }

    function renderMarkdown(text) {
      if (!text) return null
      const lines = String(text).split(/\r?\n/)
      const blocks = []
      lines.forEach((line, i) => {
        const trimmed = line.trim()
        const key = `md-${i}`
        if (!trimmed) return
        if (trimmed.startsWith('### ')) {
          blocks.push(h('h4', { key, style: { fontSize: 14, margin: '14px 0 6px' } }, inline(trimmed.slice(4), key)))
        } else if (trimmed.startsWith('## ')) {
          blocks.push(h('h3', { key, style: { fontSize: 15, margin: '18px 0 8px' } }, inline(trimmed.slice(3), key)))
        } else if (trimmed.startsWith('# ')) {
          blocks.push(h('h2', { key, style: { fontSize: 16, margin: '18px 0 8px' } }, inline(trimmed.slice(2), key)))
        } else if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
          const body = trimmed.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '')
          const bullet = /^\d/.test(trimmed) ? trimmed.match(/^\d+/)[0] + '.' : '•'
          blocks.push(h('div', { key, style: { display: 'flex', gap: 8, margin: '4px 0' } },
            h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, bullet),
            h('span', null, inline(body, key))))
        } else {
          blocks.push(h('p', { key, style: { margin: '6px 0' } }, inline(trimmed, key)))
        }
      })
      return blocks
    }

    function formatNumber(value) {
      const num = Number(value) || 0
      if (num >= 100000000) return `${(num / 100000000).toFixed(1)} 亿`
      if (num >= 10000) return `${(num / 10000).toFixed(1)} 万`
      return String(num)
    }

    function formatTime(iso) {
      if (!iso) return ''
      return String(iso).replace('T', ' ').slice(0, 16)
    }

    // ---------------------------------------------------------------- 数据
    function useReport(open) {
      const [payload, setPayload] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')

      const load = React.useCallback(async () => {
        try {
          const response = await fetch('/bili-daily/api/report', { credentials: 'same-origin' })
          const data = await response.json()
          setPayload(data)
          setError(null)
          return data
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
          return null
        }
      }, [])

      React.useEffect(() => {
        if (!open) return
        load()
        setNotice('')
      }, [open, load])

      /** 只读刷新：重读磁盘上的报告，不抓取、不调用模型。 */
      const reload = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        await load()
        setBusy(false)
        setNotice('已刷新（只读，不会重新抓取）')
      }, [load])

      /** 等待后台采集结束；最长约 3 分钟。 */
      const waitRun = React.useCallback(async () => {
        for (let attempt = 0; attempt < 72; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 2500))
          const data = await load()
          const run = data && data.run
          if (!run) continue
          if (run.running) {
            setNotice(`采集进行中：${stepLabel(run.step)}…`)
            continue
          }
          return { data, run }
        }
        return { data: null, run: null }
      }, [load])

      /** 重新采集：抓取日榜 + 入库 + 重绘词云 + 重新生成分析。 */
      const collect = React.useCallback(async () => {
        const ok = typeof window.confirm === 'function'
          ? window.confirm('将重新抓取 B 站日榜、写入 MySQL 并调用模型生成分析，通常需要 1-3 分钟。确定继续？')
          : true
        if (!ok) return
        setBusy(true)
        setError(null)
        setNotice('正在启动采集任务…')
        try {
          const response = await fetch('/bili-daily/api/run?force=1', { method: 'POST', credentials: 'same-origin' })
          if (!response.ok) throw new Error(`启动失败（HTTP ${response.status}）`)
          const { run } = await waitRun()
          if (!run) {
            setNotice('采集超时，请稍后刷新查看结果')
          } else if (run.lastError) {
            setError(run.lastError)
            setNotice('采集结束，但存在错误')
          } else {
            setNotice('采集完成')
          }
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          setBusy(false)
        }
      }, [waitRun])

      /** 只重新生成大模型分析（不重抓数据）。 */
      const regenerating = React.useRef(false)
      const regenerate = React.useCallback(async () => {
        if (regenerating.current) return
        regenerating.current = true
        setBusy(true)
        setError(null)
        setNotice('正在生成模型分析…')
        try {
          const response = await fetch('/bili-daily/api/analyze', { method: 'POST', credentials: 'same-origin' })
          const result = await response.json()
          if (result.ok) {
            setNotice('分析已更新')
            await load()
          } else {
            setError(result.error || '分析生成失败')
            setNotice('')
          }
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause))
        } finally {
          regenerating.current = false
          setBusy(false)
        }
      }, [load])

      return { payload, error, busy, notice, reload, collect, regenerate }
    }

    // ---------------------------------------------------------------- 子组件
    function Stat(props) {
      return h('span', { style: S.stat },
        h('span', null, props.label),
        h('span', { style: S.statValue }, props.value))
    }

    function Card(props) {
      return h('section', { style: S.card },
        props.title ? h('h2', { style: S.cardTitle }, props.title) : null,
        props.hint ? h('p', { style: S.cardHint }, props.hint) : null,
        props.children)
    }

    function CategoryBars({ items }) {
      if (!items || items.length === 0) {
        return h('div', { style: S.empty }, '暂无历史分区数据')
      }
      const max = Math.max(1, ...items.map(item => Number(item.count) || 0))
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 9 } },
        items.map((item, index) => h('div', {
          key: `${item.category}-${index}`,
          style: { display: 'grid', gridTemplateColumns: '132px 1fr 56px', alignItems: 'center', gap: 12 },
        },
        h('span', {
          title: item.category,
          style: {
            fontSize: 13,
            color: 'var(--dsw-alias-label-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          },
        }, item.category),
        h('div', {
          style: {
            background: 'var(--dsw-alias-bg-layer-2)',
            borderRadius: 6,
            height: 12,
            overflow: 'hidden',
          },
        }, h('div', {
          style: {
            width: `${Math.max(2, (Number(item.count) / max) * 100)}%`,
            height: '100%',
            background: 'var(--dsw-alias-brand-primary)',
            borderRadius: 6,
            transition: 'width 240ms ease',
          },
        })),
        h('span', {
          style: { fontSize: 13, textAlign: 'right', color: 'var(--dsw-alias-label-primary)' },
        }, String(item.count))))
      )
    }

    function CloudCard({ title, name, version, hint }) {
      return h('figure', { style: { margin: 0 } },
        h('div', { style: { fontSize: 13, fontWeight: 500, marginBottom: 8 } }, title),
        h('div', {
          style: {
            background: 'var(--dsw-alias-bg-layer-2)',
            borderRadius: 10,
            padding: 6,
            border: '1px solid var(--dsw-alias-border-l1)',
          },
        }, name
          ? h('img', { src: assetUrl(name, version), alt: title, style: S.cloud, loading: 'lazy' })
          : h('div', { style: S.empty }, '暂无数据')),
        hint ? h('figcaption', {
          style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8, lineHeight: 1.6 },
        }, hint) : null)
    }

    function VideoTable({ videos }) {
      if (!videos || videos.length === 0) return h('div', { style: S.empty }, '当日暂无数据')
      return h('div', { style: { overflowX: 'auto' } },
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            ['#', 'BV 号', '分区', '标签', 'UP 主', '时长', '播放量'].map(label => h('th', { key: label, style: S.th }, label)))),
          h('tbody', null, videos.map(video => h('tr', { key: video.bv, className: 'bili-row' },
            h('td', { style: { ...S.td, ...S.mono } }, String(video.rank)),
            h('td', { style: S.td },
              h('a', { href: video.url, target: '_blank', rel: 'noreferrer', style: S.link }, video.bv),
              h('div', {
                style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4, maxWidth: 300, lineHeight: 1.5 },
                title: video.title,
              }, video.title)),
            h('td', { style: S.td }, video.category),
            h('td', { style: { ...S.td, maxWidth: 320 } },
              (video.tags || []).slice(0, 6).map(tag => h('span', { key: tag, style: S.tag }, tag)),
              (video.tags || []).length > 6
                ? h('span', { style: { ...S.tag, background: 'transparent' } }, `+${video.tags.length - 6}`)
                : null),
            h('td', { style: S.td }, video.up),
            h('td', { style: { ...S.td, ...S.mono } }, video.durationText),
            h('td', { style: { ...S.td, ...S.mono } }, formatNumber(video.play)))))))
    }

    function CommentList({ videos }) {
      const count = (videos || []).length
      return h('details', { style: S.details },
        h('summary', { style: S.summary }, `查看当日 ${count} 条视频的热评（每条前 3 条）`),
        h('div', { style: { marginTop: 12, display: 'flex', flexDirection: 'column', gap: 18 } },
          (videos || []).map(video => h('div', { key: video.bv },
            h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6 } },
              `${video.rank}. ${video.bv} `,
              h('span', { style: { fontWeight: 400, color: 'var(--dsw-alias-label-secondary)' } }, video.title)),
            (video.comments || []).map(comment => h('div', { key: `${video.bv}-${comment.rank}`, style: S.comment },
              h('span', { style: S.like }, `👍 ${formatNumber(comment.like)}`),
              h('div', null,
                h('div', { style: { color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap' } }, comment.content),
                h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2 } }, comment.author))))))))
    }

    // ---------------------------------------------------------------- 页面
    function Page() {
      const open = useOpen()
      const { payload, error, busy, notice, reload, collect, regenerate } = useReport(open)

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      if (!open) return null

      const report = payload && payload.ok ? payload.report : null
      const run = (payload && payload.run) || {}
      const version = report ? report.generatedAt : ''
      const images = (report && report.images) || {}
      const runError = !error && run.lastError ? run.lastError : null

      return h('div', { style: S.page, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'B站每日热报' },
        h('header', { style: S.header },
          h('div', { style: { minWidth: 0 } },
            h('h1', { style: S.title }, 'B 站每日热报'),
            h('div', { style: S.sub },
              report
                ? `数据归属日 ${report.crawlDate} · 生成于 ${formatTime(report.generatedAt)}`
                : '全站日榜 Top N · MySQL 归档 · 词云分析')),
          h('div', { style: S.spacer }),
          report ? h(Stat, { label: '当日视频', value: String(report.videos.length) }) : null,
          report ? h(Stat, { label: '历史视频', value: String(report.history.videos) }) : null,
          report ? h(Stat, { label: '覆盖天数', value: String(report.history.days) }) : null,
          h('button', {
            type: 'button',
            className: 'bili-btn',
            style: busy ? { ...S.button, opacity: 0.6 } : S.button,
            disabled: busy,
            onClick: reload,
          }, '刷新'),
          h('button', {
            type: 'button',
            className: 'bili-btn',
            style: busy || run.running ? { ...S.primary, opacity: 0.6 } : S.primary,
            disabled: busy || run.running,
            onClick: collect,
          }, busy || run.running ? '采集中…' : '重新采集'),
          h('button', {
            type: 'button',
            className: 'bili-btn',
            style: S.button,
            onClick: () => setOpen(false),
          }, '关闭')),
        h('main', { style: S.main },
          notice ? h('div', { style: { ...S.sub, fontSize: 12, paddingLeft: 2 } }, notice) : null,
          error ? h('div', { style: S.error }, error) : null,
          runError ? h('div', { style: S.error }, `采集错误：${runError}`) : null,
          !payload && !error ? h('div', { style: S.empty }, '正在加载数据…') : null,
          payload && !payload.ok
            ? h(Card, null,
              h('div', { style: S.empty },
                h('div', { style: { marginBottom: 10 } }, '数据库中还没有可展示的数据。'),
                h('button', { type: 'button', style: S.primary, onClick: collect, disabled: busy }, '立即采集昨日榜单')))
            : null,
          report
            ? h(React.Fragment, null,
              h(Card, {
                title: `一、当日 Top${report.videos.length} 汇总表`,
                hint: '数据来源：B 站全站日榜（每日 0 点更新）',
              },
              h(VideoTable, { videos: report.videos }),
              h(CommentList, { videos: report.videos })),
              h(Card, {
                title: '二、历史分区视频数量',
                hint: `数据库中全部 ${report.history.videos} 条记录（${report.history.days} 天，${report.history.firstDay || '-'} ~ ${report.history.lastDay || '-'}）`,
              },
              h(CategoryBars, { items: report.history.categories })),
              h(Card, {
                title: '三、标签词云',
                hint: '左：当日 Top N 视频的标签；右：历史全部视频的标签',
              },
              h('div', { style: S.grid2 },
                h(CloudCard, { title: '当日标签词云', name: images.tagToday, version }),
                h(CloudCard, { title: '历史标签词云', name: images.tagHistory, version }))),
              h(Card, {
                title: '四、评论词云',
                hint: '上：当日每条视频各自的前三热评；下左：当日全部热评汇总；下右：历史全部热评汇总',
              },
              h('div', { style: { ...S.grid2, marginBottom: 16 } },
                (report.videoImages || []).map(item => h(CloudCard, {
                  key: item.bv,
                  title: `${item.bv} · ${item.title}`,
                  name: item.image,
                  version,
                  hint: `前 ${(item.comments || []).length} 条热评`,
                }))),
              h('div', { style: S.grid2 },
                h(CloudCard, { title: '当日评论汇总词云', name: images.commentToday, version }),
                h(CloudCard, { title: '历史评论汇总词云', name: images.commentHistory, version }))),
              h(Card, {
                title: '五、大模型数据分析',
                hint: '由 DSH 当前默认模型根据当日榜单、历史分区分布与词频生成',
              },
              report.analysis
                ? h('div', { style: S.md }, renderMarkdown(report.analysis))
                : h('div', { style: S.empty }, '分析文本尚未生成。'),
              h('div', { style: { marginTop: 14 } },
                h('button', {
                  type: 'button',
                  style: busy ? { ...S.button, opacity: 0.6 } : S.button,
                  disabled: busy,
                  onClick: regenerate,
                }, '重新生成分析（不重抓数据）'))))
            : null,
          h('div', { style: { ...S.sub, textAlign: 'center', paddingTop: 8 } },
            'bili-daily · 数据保留 15 天 · 仅抓取公开数据')))
    }

    // ---------------------------------------------------------------- 入口
    function Launcher(props) {
      const open = useOpen()
      const wide = props && props.wide === true
      return h('button', {
        type: 'button',
        className: 'bili-launch',
        title: 'B站日报',
        'aria-label': '打开 B站每日热报',
        'aria-pressed': open,
        onClick: () => setOpen(!open),
      },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': true, style: S.icon },
        h('rect', { x: 3, y: 12, width: 4, height: 9, rx: 1, fill: 'currentColor', opacity: 0.75 }),
        h('rect', { x: 10, y: 7, width: 4, height: 14, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 17, y: 3, width: 4, height: 18, rx: 1, fill: 'currentColor', opacity: 0.55 })),
      wide ? 'B站日报' : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 样式必须常驻：入口按钮在页面关闭时也要有 DSH 外观。
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = '@local/bili-daily'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        })

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'bili-daily-launcher',
          order: 60,
          label: 'B站日报',
        }, Launcher))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'bili-daily-page',
          order: 80,
          label: 'B站每日热报',
        }, Page))
      },
    }
  },
})
