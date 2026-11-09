/**
 * dsh-commandcode-go — floating usage window (Client half).
 *
 * Registered through the `dsh.client` bundle format: the Host serves this file
 * from the package's `./client` export and the shell materialises the factory
 * lazily.  The window lives in the layout's `shell.overlay` slot, so it floats
 * above the three-column frame, drags anywhere, and survives page navigation.
 *
 * Data comes from the plugin's own read-only `/dsh-commandcode-go/usage` route;
 * the API key never reaches the browser.
 */

window.__ModuleLoader__.load({
  id: 'dsh-commandcode-go',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useRef = React.useRef
    const useCallback = React.useCallback

    const API_URL = '/dsh-commandcode-go/usage'
    const STORAGE_KEY = 'dsh-commandcode-go:usage-window:v1'
    const CARD_WIDTH = 268
    const BUBBLE = 46
    const MARGIN = 12

    const CSS = [
      '.ccu-root{position:fixed;z-index:30;pointer-events:auto;touch-action:none;font-family:inherit;color:var(--dsw-alias-label-primary);-webkit-user-select:none;user-select:none}',
      '.ccu-card{width:' + CARD_WIDTH + 'px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.08);overflow:hidden}',
      '.ccu-head{display:flex;align-items:center;gap:7px;padding:8px 7px 8px 10px;cursor:grab;touch-action:none;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.ccu-head:active{cursor:grabbing}',
      '.ccu-card{cursor:default}',
      '.ccu-card a{cursor:pointer}',
      '.ccu-mark{width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;letter-spacing:-.02em;color:#fff;background:linear-gradient(135deg,#7c5cff,#4f8cff);flex:none}',
      '.ccu-title{font-size:12px;font-weight:600;white-space:nowrap;letter-spacing:-.01em}',
      '.ccu-pill{font-size:10px;font-weight:600;line-height:1;padding:3px 6px;border-radius:999px;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);flex:none}',
      '.ccu-grow{flex:1}',
      '.ccu-btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;flex:none;transition:background .12s ease,color .12s ease}',
      '.ccu-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.ccu-btn svg{width:13px;height:13px;display:block}',
      '.ccu-btn.spin svg{animation:ccu-spin .9s linear infinite}',
      '@keyframes ccu-spin{to{transform:rotate(360deg)}}',
      '.ccu-body{padding:11px 12px 12px}',
      '.ccu-hero{display:flex;align-items:baseline;gap:6px}',
      '.ccu-amount{font-size:24px;font-weight:650;letter-spacing:-.025em;line-height:1;font-variant-numeric:tabular-nums}',
      '.ccu-of{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.ccu-meta{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:6px;font-variant-numeric:tabular-nums}',
      '.ccu-track{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent);overflow:hidden;margin-top:7px}',
      '.ccu-track.sm{height:4px;margin-top:0}',
      '.ccu-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .45s cubic-bezier(.2,.8,.2,1)}',
      '.ccu-fill.warn{background:#e5484d}',
      '.ccu-wins{display:flex;flex-direction:column;gap:10px;margin-top:12px;padding-top:11px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.ccu-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;margin-bottom:5px}',
      '.ccu-row .k{color:var(--dsw-alias-label-secondary)}',
      '.ccu-row .v{font-weight:600;font-variant-numeric:tabular-nums}',
      '.ccu-hint{font-size:10px;color:var(--dsw-alias-label-secondary);margin-top:4px;font-variant-numeric:tabular-nums}',
      '.ccu-foot{margin-top:11px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.ccu-foot .line{display:flex;justify-content:space-between;gap:8px}',
      '.ccu-link{display:inline-flex;align-items:center;gap:3px;margin-top:9px;font-size:11px;font-weight:500;color:var(--dsw-alias-brand-primary);text-decoration:none;cursor:pointer}',
      '.ccu-link:hover{text-decoration:underline}',
      '.ccu-state{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary);padding:2px 0 1px}',
      '.ccu-state.error{color:var(--dsw-alias-label-primary)}',
      '.ccu-retry{margin-top:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer}',
      '.ccu-retry:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.ccu-skel{height:8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent);animation:ccu-pulse 1.2s ease-in-out infinite}',
      '@keyframes ccu-pulse{0%,100%{opacity:.45}50%{opacity:.9}}',
      '.ccu-bubble{width:' + BUBBLE + 'px;height:' + BUBBLE + 'px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.2),0 1px 3px rgba(0,0,0,.1);position:relative;display:flex;align-items:center;justify-content:center;cursor:grab;touch-action:none}',
      '.ccu-bubble:active{cursor:grabbing}',
      '.ccu-ring{position:absolute;inset:0;border-radius:50%}',
      '.ccu-bubble-core{position:relative;width:36px;height:36px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);display:flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}',
    ].join('\n')

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max)
    }

    function clampPosition(x, y, width, height) {
      const vw = window.innerWidth || 0
      const vh = window.innerHeight || 0
      return {
        x: clamp(x, MARGIN, Math.max(MARGIN, vw - width - MARGIN)),
        y: clamp(y, MARGIN, Math.max(MARGIN, vh - height - MARGIN)),
      }
    }

    function loadPrefs() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
        if (!raw || typeof raw !== 'object') return {}
        return {
          x: Number.isFinite(Number(raw.x)) ? Number(raw.x) : null,
          y: Number.isFinite(Number(raw.y)) ? Number(raw.y) : null,
          collapsed: raw.collapsed === true,
        }
      } catch (error) {
        return {}
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      } catch (error) {
        // Private mode or a quota error: the window still drags, it just forgets.
      }
    }

    function money(value) {
      const n = Number(value) || 0
      if (n > 0 && n < 0.005) return '<$0.01'
      return '$' + n.toFixed(2)
    }

    function tokens(value) {
      const n = Number(value) || 0
      if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B'
      if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K'
      return String(Math.round(n))
    }

    function percent(value) {
      const n = Number(value) || 0
      if (n > 0 && n < 0.1) return '<0.1%'
      return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + '%'
    }

    function shortDate(iso) {
      if (typeof iso !== 'string' || !iso) return null
      const at = new Date(iso)
      if (Number.isNaN(at.getTime())) return null
      return at.getMonth() + 1 + '月' + at.getDate() + '日'
    }

    function countdown(resetAt, now, exceeded) {
      if (!Number.isFinite(resetAt)) return null
      const ms = resetAt - now
      const prefix = exceeded ? '已用尽，' : ''
      if (ms <= 0) return prefix + '即将重置'
      const totalMinutes = Math.floor(ms / 60000)
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      let left
      if (days > 0) left = days + ' 天 ' + hours + ' 小时'
      else if (hours > 0) left = hours + ' 小时 ' + minutes + ' 分'
      else if (minutes > 0) left = minutes + ' 分钟'
      else left = Math.max(1, Math.ceil(ms / 1000)) + ' 秒'
      return prefix + left + '后重置'
    }

    const RefreshIcon = () =>
      h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )

    const CollapseIcon = () =>
      h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M5 12h14',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
        }),
      )

    function WindowRow({ label, info, now }) {
      if (!info) return null
      const hint = countdown(info.resetAt, now, info.exceeded)
      const warn = info.exceeded || info.percent >= 90
      return h('div', null,
        h('div', { className: 'ccu-row' },
          h('span', { className: 'k' }, label),
          h('span', { className: 'v' }, money(info.used) + ' / ' + money(info.cap)),
        ),
        h('div', { className: 'ccu-track sm', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(info.percent) },
          h('div', { className: 'ccu-fill' + (warn ? ' warn' : ''), style: { width: Math.max(info.percent > 0 ? 2 : 0, info.percent) + '%' } }),
        ),
        hint ? h('div', { className: 'ccu-hint' }, hint) : null,
      )
    }

    function UsageCard({ data, now, loading, error, refreshing, onRefresh, onCollapse, onStartDrag }) {
      const plan = data && data.plan
      const credits = data && data.credits
      const windows = (data && data.windows) || {}
      const usage = (data && data.usage) || {}
      const links = (data && data.links) || {}
      const periodEnd = plan && shortDate(plan.currentPeriodEnd)
      const renewal = plan
        ? plan.cancelAtPeriodEnd
          ? '到期后不再续费'
          : periodEnd
            ? periodEnd + '续费'
            : null
        : null
      const usagePercent = credits ? credits.usagePercent : 0
      const warn = usagePercent >= 90

      let body
      if (loading) {
        body = h('div', { className: 'ccu-body' },
          h('div', { className: 'ccu-skel', style: { width: '56%', height: 22, marginBottom: 12 } }),
          h('div', { className: 'ccu-skel', style: { width: '100%' } }),
          h('div', { className: 'ccu-skel', style: { width: '82%', marginTop: 14 } }),
          h('div', { className: 'ccu-skel', style: { width: '64%', marginTop: 8 } }),
        )
      } else if (error) {
        body = h('div', { className: 'ccu-body' },
          h('div', { className: 'ccu-state error' }, error),
          h('button', { className: 'ccu-retry', type: 'button', onClick: onRefresh }, '重新获取'),
        )
      } else {
        body = h('div', { className: 'ccu-body' },
          h('div', { className: 'ccu-hero' },
            h('span', { className: 'ccu-amount' }, money(credits ? credits.totalRemaining : 0)),
            h('span', { className: 'ccu-of' }, '剩余 / ' + money(credits ? credits.totalPool : 0)),
          ),
          h('div', { className: 'ccu-track', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(usagePercent) },
            h('div', { className: 'ccu-fill' + (warn ? ' warn' : ''), style: { width: Math.max(usagePercent > 0 ? 2 : 0, usagePercent) + '%' } }),
          ),
          h('div', { className: 'ccu-meta' },
            h('span', null, '本期已用 ' + money(credits ? credits.used : 0)),
            h('span', null, percent(usagePercent)),
          ),
          h('div', { className: 'ccu-wins' },
            h(WindowRow, { label: '5 小时窗口', info: windows.fiveHour, now }),
            h(WindowRow, { label: '每周窗口', info: windows.weekly, now }),
          ),
          h('div', { className: 'ccu-foot' },
            h('div', { className: 'line' },
              h('span', null, (usage.requests || 0) + ' 次请求'),
              h('span', null, tokens(usage.totalTokens) + ' tokens'),
            ),
            renewal ? h('div', { className: 'line' },
              h('span', null, periodEnd ? periodEnd + '周期结束' : '订阅'),
              h('span', null, renewal),
            ) : null,
            data && data.generatedAt
              ? h('div', { className: 'line' },
                  h('span', null, '更新于 ' + new Date(data.generatedAt).toLocaleTimeString()),
                  data.account && data.account.userName ? h('span', null, '@' + data.account.userName) : null,
                )
              : null,
          ),
          links.billing
            ? h('a', { className: 'ccu-link', href: links.billing, target: '_blank', rel: 'noreferrer noopener' },
                '查看账单与用量',
                h('span', { 'aria-hidden': true }, '↗'),
              )
            : null,
        )
      }

      return h('div', { className: 'ccu-card', 'data-ccu-drag': 'true', onPointerDown: onStartDrag },
        h('div', { className: 'ccu-head' },
          h('span', { className: 'ccu-mark' }, 'CC'),
          h('span', { className: 'ccu-title' }, 'Command Code'),
          plan ? h('span', { className: 'ccu-pill' }, plan.name) : null,
          h('span', { className: 'ccu-grow' }),
          h('button', {
            className: 'ccu-btn' + (refreshing ? ' spin' : ''),
            type: 'button',
            title: '刷新用量',
            'aria-label': '刷新用量',
            'data-ccu-no-drag': 'true',
            onPointerDown: (event) => event.stopPropagation(),
            onClick: onRefresh,
          }, h(RefreshIcon)),
          h('button', {
            className: 'ccu-btn',
            type: 'button',
            title: '收起为悬浮球',
            'aria-label': '收起为悬浮球',
            'data-ccu-no-drag': 'true',
            onPointerDown: (event) => event.stopPropagation(),
            onClick: onCollapse,
          }, h(CollapseIcon)),
        ),
        body,
      )
    }

    function UsageWindow() {
      const [prefs] = useState(loadPrefs)
      const [position, setPosition] = useState(() => {
        const width = prefs.collapsed ? BUBBLE : CARD_WIDTH
        const height = prefs.collapsed ? BUBBLE : 300
        const x = prefs.x === null ? (window.innerWidth || 1200) - width - 28 : prefs.x
        const y = prefs.y === null ? 96 : prefs.y
        return clampPosition(x, y, width, height)
      })
      const [collapsed, setCollapsed] = useState(prefs.collapsed === true)
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [refreshing, setRefreshing] = useState(false)
      const [now, setNow] = useState(() => Date.now())
      const rootRef = useRef(null)
      const dragRef = useRef(null)

      const currentSize = useCallback(() => {
        const el = rootRef.current
        return {
          width: el ? el.offsetWidth : collapsed ? BUBBLE : CARD_WIDTH,
          height: el ? el.offsetHeight : collapsed ? BUBBLE : 300,
        }
      }, [collapsed])

      const refresh = useCallback(async (silent) => {
        if (!silent) setRefreshing(true)
        try {
          const response = await fetch(API_URL, {
            method: 'GET',
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error('用量接口返回 HTTP ' + response.status)
          const body = await response.json()
          if (!body || body.ok !== true) {
            setData(null)
            setError((body && body.error && body.error.message) || '暂时读不到用量。')
          } else {
            setData(body)
            setError(null)
          }
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          setLoading(false)
          setRefreshing(false)
        }
      }, [])

      useEffect(() => {
        refresh(false)
      }, [refresh])

      const intervalSeconds = (data && Number(data.refreshSeconds)) || 60
      useEffect(() => {
        const timer = window.setInterval(() => refresh(true), Math.max(15, intervalSeconds) * 1000)
        return () => window.clearInterval(timer)
      }, [refresh, intervalSeconds])

      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 30000)
        return () => window.clearInterval(timer)
      }, [])

      useEffect(() => {
        const onResize = () => {
          const size = currentSize()
          setPosition((current) => clampPosition(current.x, current.y, size.width, size.height))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [currentSize])

      useEffect(() => {
        savePrefs({ x: position.x, y: position.y, collapsed })
      }, [position.x, position.y, collapsed])

      useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
          const size = currentSize()
          setPosition((current) => clampPosition(current.x, current.y, size.width, size.height))
        })
        return () => window.cancelAnimationFrame(frame)
      }, [collapsed, currentSize])

      // Drag from anywhere on the card (controls opt out with
      // [data-ccu-no-drag]); window-level listeners survive pointer capture
      // loss and the overlay layer's own pointer-events rules.
      const startDrag = useCallback((event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        const target = event.target
        if (target && typeof target.closest === 'function'
          && target.closest('button, a, input, select, textarea, [data-ccu-no-drag]')) return
        const drag = {
          id: event.pointerId,
          sx: event.clientX,
          sy: event.clientY,
          ox: position.x,
          oy: position.y,
          moved: false,
          toggleOnClick: collapsed,
        }
        dragRef.current = drag
        const handle = event.currentTarget
        try { if (handle && handle.setPointerCapture) handle.setPointerCapture(event.pointerId) } catch (failure) { /* older engine */ }
        event.preventDefault()
        event.stopPropagation()

        const previousSelect = document.body ? document.body.style.userSelect : ''
        if (document.body) document.body.style.userSelect = 'none'

        const onMove = (moveEvent) => {
          if (moveEvent.pointerId !== drag.id) return
          const dx = moveEvent.clientX - drag.sx
          const dy = moveEvent.clientY - drag.sy
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
          if (!drag.moved) return
          const size = currentSize()
          setPosition(clampPosition(drag.ox + dx, drag.oy + dy, size.width, size.height))
        }

        const finish = (upEvent) => {
          if (upEvent && upEvent.pointerId !== undefined && upEvent.pointerId !== drag.id) return
          window.removeEventListener('pointermove', onMove, true)
          window.removeEventListener('pointerup', finish, true)
          window.removeEventListener('pointercancel', finish, true)
          if (document.body) document.body.style.userSelect = previousSelect
          try { if (handle && handle.releasePointerCapture) handle.releasePointerCapture(drag.id) } catch (failure) { /* already released */ }
          if (dragRef.current !== drag) return
          dragRef.current = null
          const size = currentSize()
          setPosition((current) => clampPosition(current.x, current.y, size.width, size.height))
          if (!drag.moved && drag.toggleOnClick) setCollapsed(false)
        }

        window.addEventListener('pointermove', onMove, true)
        window.addEventListener('pointerup', finish, true)
        window.addEventListener('pointercancel', finish, true)
      }, [position.x, position.y, collapsed, currentSize])

      const widgetEnabled = data ? data.widgetEnabled !== false : true
      if (!widgetEnabled) return null

      const usagePercent = data && data.credits ? data.credits.usagePercent : 0
      const ring = usagePercent >= 100
        ? '#e5484d'
        : 'var(--dsw-alias-brand-primary)'

      return h(React.Fragment, null,
        h('style', { 'data-ccu-style': 'true' }, CSS),
        h('div', {
          ref: rootRef,
          className: 'ccu-root',
          style: { left: position.x + 'px', top: position.y + 'px' },
        },
          collapsed
            ? h('div', {
                className: 'ccu-bubble',
                role: 'button',
                tabIndex: 0,
                title: 'Command Code 用量',
                'aria-label': '展开 Command Code 用量',
                onPointerDown: startDrag,
                onClick: (event) => {
                  if (dragRef.current) return
                  if (event.detail === 0) setCollapsed(false)
                },
                onKeyDown: (event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setCollapsed(false)
                  }
                },
              },
                h('div', {
                  className: 'ccu-ring',
                  style: {
                    background: 'conic-gradient(' + ring + ' ' + Math.round(usagePercent * 3.6) + 'deg, color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent) 0deg)',
                  },
                }),
                h('div', { className: 'ccu-bubble-core' }, percent(usagePercent)),
              )
            : h(UsageCard, {
                data,
                now,
                loading,
                error,
                refreshing,
                onRefresh: () => refresh(false),
                onCollapse: () => setCollapsed(true),
                onStartDrag: startDrag,
              }),
        ),
      )
    }

    function apply(ctx) {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'commandcode-usage',
        order: 30,
      }, UsageWindow))
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
