const { app, BrowserWindow, BrowserView, ipcMain, screen, globalShortcut } = require('electron')
const fs = require('fs')
const path = require('path')

app.commandLine.appendSwitch('disable-features', 'CrossOriginOpenerPolicy')

let widgetWin = null
let scraperView = null
let loginWin = null
let refreshInterval = null
let codexRefreshInterval = null
let codexSessionsWatcher = null
let codexRefreshTimeout = null
let activeRefreshSource = 'initial'
let activeRefreshRequestId = 0

const gotSingleInstanceLock = app.requestSingleInstanceLock()
const APP_NAME = 'AI Usage Widget'
const APP_USER_MODEL_ID = 'com.coron.aiusagewidget'
const IS_WINDOWS = process.platform === 'win32'

if (!gotSingleInstanceLock) {
  app.quit()
}

app.setName(APP_NAME)
if (IS_WINDOWS) {
  app.setAppUserModelId(APP_USER_MODEL_ID)
}

const BASE_W = 692
const BASE_H = 388
const MIN_SCALE = 1
const MAX_SCALE = 2
const CLAUDE_REFRESH_INTERVAL_MS = 30000
const CODEX_REFRESH_INTERVAL_MS = 5000
const CODEX_WATCH_DEBOUNCE_MS = 800
let currentScale = 1

function clampScale(scale) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(scale * 100) / 100))
}

function getWindowIconPath() {
  const extension = IS_WINDOWS ? 'ico' : 'png'
  return path.join(__dirname, '..', 'assets', `icon.${extension}`)
}

function applyScale(nextScale) {
  if (!widgetWin || widgetWin.isDestroyed()) return currentScale

  currentScale = clampScale(nextScale)
  const bounds = widgetWin.getBounds()
  const width = Math.round(BASE_W * currentScale)
  const height = Math.round(BASE_H * currentScale)

  widgetWin.setBounds({ x: bounds.x, y: bounds.y, width, height })
  widgetWin.webContents.setZoomFactor(currentScale)
  return currentScale
}

function settleInitialLayout() {
  if (!widgetWin || widgetWin.isDestroyed()) return

  const bounds = widgetWin.getBounds()
  widgetWin.setBounds({ ...bounds, width: bounds.width + 1, height: bounds.height + 1 })

  setTimeout(() => {
    if (!widgetWin || widgetWin.isDestroyed()) return
    applyScale(currentScale)
  }, 16)
}

function sendRefreshState(refreshing, source = activeRefreshSource) {
  if (!widgetWin || widgetWin.isDestroyed()) return
  widgetWin.webContents.send('refresh-state', { refreshing, source })
}

function sendCodexUsageUpdate(data) {
  if (!widgetWin || widgetWin.isDestroyed()) return
  widgetWin.webContents.send('codex-usage-update', data)
}

function sendClaudeUsageUpdate(data) {
  if (!widgetWin || widgetWin.isDestroyed()) return
  widgetWin.webContents.send('usage-update', data)
}

function formatAbsoluteResetTime(timestampMs) {
  if (!timestampMs) return ''

  return new Intl.DateTimeFormat('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(timestampMs))
}

function formatRemainingResetTime(timestampMs) {
  if (!timestampMs) return ''

  const remainingMs = Math.max(0, timestampMs - Date.now())
  const totalMinutes = Math.ceil(remainingMs / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60

  if (hours <= 0) return `${minutes}m`
  if (minutes <= 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

function buildCodexRateWindow(limit = {}) {
  const usedPercent = Math.round(Number(limit.used_percent) || 0)
  const windowMinutes = Number(limit.window_minutes) || 0
  const resetAt = (Number(limit.resets_at) || 0) * 1000

  return {
    usedPercent,
    windowMinutes,
    resetText: formatRemainingResetTime(resetAt),
    resetAtText: formatAbsoluteResetTime(resetAt)
  }
}

function resolveCodexRateWindows(rateLimits = {}) {
  const windows = [rateLimits.primary, rateLimits.secondary]
    .map((limit) => buildCodexRateWindow(limit))
    .filter((window) => window.windowMinutes > 0 || window.usedPercent > 0 || window.resetAtText)
    .sort((a, b) => a.windowMinutes - b.windowMinutes)

  const emptyWindow = buildCodexRateWindow()
  const currentWindow =
    windows.find((window) => window.windowMinutes > 0 && window.windowMinutes < 24 * 60) ||
    windows[0] ||
    emptyWindow
  const weeklyWindow =
    windows.find((window) => window.windowMinutes >= 24 * 60) ||
    windows[1] ||
    windows[0] ||
    emptyWindow

  return { currentWindow, weeklyWindow }
}

function parseCodexUsageEvent(entry, fallbackTimestamp = 0) {
  const payload = entry?.type === 'event_msg' ? entry.payload : entry
  if (payload?.type !== 'token_count' || !payload.rate_limits) return null
  if (payload.rate_limits.limit_id && payload.rate_limits.limit_id !== 'codex') return null

  const totalUsage = payload.info?.total_token_usage || {}
  const timestamp = entry?.timestamp ? new Date(entry.timestamp).getTime() : 0
  const { currentWindow, weeklyWindow } = resolveCodexRateWindows(payload.rate_limits)

  return {
    primary: currentWindow,
    secondary: weeklyWindow,
    planType: payload.rate_limits.plan_type || '',
    timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : fallbackTimestamp,
    current: {
      inputTokens: totalUsage.input_tokens || 0,
      outputTokens: totalUsage.output_tokens || 0,
      totalTokens: totalUsage.total_tokens || 0
    }
  }
}

function extractLatestCodexUsage(rawText, fallbackTimestamp = 0) {
  const lines = rawText.split(/\r?\n/).filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const usage = parseCodexUsageEvent(JSON.parse(lines[i]), fallbackTimestamp)
      if (usage) return usage
    } catch (error) {
      continue
    }
  }

  return null
}

function findJsonlFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return []

  const files = []
  const stack = [rootDir]

  while (stack.length) {
    const currentDir = stack.pop()
    let entries = []

    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true })
    } catch (error) {
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }

      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      files.push(fullPath)
    }
  }

  return files
}

async function loadCodexUsage() {
  try {
    const sessionsRoot = path.join(app.getPath('home'), '.codex', 'sessions')
    const sessionFiles = findJsonlFiles(sessionsRoot)

    if (!sessionFiles.length) {
      sendCodexUsageUpdate({ error: 'missing', message: 'session log not found' })
      return
    }

    let latestUsage = null

    for (const sessionFile of sessionFiles) {
      let rawText = ''
      let stat = null

      try {
        ;[rawText, stat] = await Promise.all([
          fs.promises.readFile(sessionFile, 'utf8'),
          fs.promises.stat(sessionFile)
        ])
      } catch (error) {
        continue
      }

      const usage = extractLatestCodexUsage(rawText, stat?.mtimeMs || 0)
      if (!usage) continue

      if (!latestUsage || usage.timestamp > latestUsage.timestamp) {
        latestUsage = usage
      }
    }

    if (!latestUsage) {
      sendCodexUsageUpdate({ error: 'missing', message: 'token_count event not found' })
      return
    }

    sendCodexUsageUpdate(latestUsage)
  } catch (error) {
    sendCodexUsageUpdate({ error: 'read_failed', message: error.message })
  }
}

function stopCodexUsageMonitor() {
  if (codexRefreshTimeout) {
    clearTimeout(codexRefreshTimeout)
    codexRefreshTimeout = null
  }

  if (codexRefreshInterval) {
    clearInterval(codexRefreshInterval)
    codexRefreshInterval = null
  }

  if (codexSessionsWatcher) {
    codexSessionsWatcher.close()
    codexSessionsWatcher = null
  }
}

function scheduleCodexUsageRefresh(delayMs = CODEX_WATCH_DEBOUNCE_MS) {
  if (codexRefreshTimeout) clearTimeout(codexRefreshTimeout)

  codexRefreshTimeout = setTimeout(() => {
    codexRefreshTimeout = null
    loadCodexUsage()
  }, delayMs)
}

function startCodexUsageMonitor() {
  stopCodexUsageMonitor()
  loadCodexUsage()

  codexRefreshInterval = setInterval(() => {
    loadCodexUsage()
  }, CODEX_REFRESH_INTERVAL_MS)

  const sessionsRoot = path.join(app.getPath('home'), '.codex', 'sessions')
  if (!fs.existsSync(sessionsRoot)) return

  try {
    codexSessionsWatcher = fs.watch(sessionsRoot, { recursive: true }, () => {
      scheduleCodexUsageRefresh()
    })
  } catch (error) {
    codexSessionsWatcher = null
  }
}

function refreshUsage(source = 'manual') {
  activeRefreshSource = source
  activeRefreshRequestId += 1
  sendRefreshState(true, source)
  loadCodexUsage()
  if (!scraperView) return
  scraperView.webContents.reload()
}

function createWidget() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  const rightMargin = 18
  const bottomMargin = 18

  widgetWin = new BrowserWindow({
    width: BASE_W,
    height: BASE_H,
    x: width - BASE_W - rightMargin,
    y: height - BASE_H - bottomMargin,
    icon: getWindowIconPath(),
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    minWidth: BASE_W,
    minHeight: BASE_H,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  widgetWin.loadFile(path.join(__dirname, 'widget.html'))
  widgetWin.once('ready-to-show', () => {
    if (!widgetWin || widgetWin.isDestroyed()) return
    widgetWin.show()
    setTimeout(settleInitialLayout, 30)
  })

  widgetWin.on('closed', () => {
    widgetWin = null
    clearInterval(refreshInterval)
    stopCodexUsageMonitor()
    app.quit()
  })
}

function toggleWidgetVisibility() {
  if (!widgetWin || widgetWin.isDestroyed()) return

  if (widgetWin.isVisible()) {
    widgetWin.hide()
    return
  }

  widgetWin.show()
}

function focusWidget() {
  if (!widgetWin || widgetWin.isDestroyed()) return

  if (widgetWin.isMinimized()) widgetWin.restore()
  if (!widgetWin.isVisible()) widgetWin.show()
  widgetWin.focus()
}

function registerGlobalShortcuts() {
  const shortcuts = ['F9']

  shortcuts.forEach((accelerator) => {
    const registered = globalShortcut.register(accelerator, () => {
      toggleWidgetVisibility()
    })

    if (!registered) {
      console.warn(`Failed to register shortcut: ${accelerator}`)
    }
  })
}

function isClaudeAuthenticatedUrl(url) {
  return (
    url.includes('claude.ai') &&
    !url.includes('/login') &&
    !url.includes('/auth') &&
    !url.includes('/oauth') &&
    !url.includes('google') &&
    !url.includes('accounts.')
  )
}

function scheduleClaudeUsageRefresh(delayMs = 1200) {
  if (!scraperView || scraperView.webContents.isDestroyed()) return

  setTimeout(() => {
    if (!scraperView || scraperView.webContents.isDestroyed()) return
    refreshUsage('manual')
  }, delayMs)
}

function openLoginWindow() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    return
  }

  loginWin = new BrowserWindow({
    width: 500,
    height: 700,
    title: 'AI Widget Login',
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:claude'
    }
  })

  loginWin.setMenuBarVisibility(false)
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    loginWin.loadURL(url)
    return { action: 'deny' }
  })
  loginWin.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      event.preventDefault()
    }
  })
  loginWin.loadURL('https://claude.ai/login')

  function checkAndCloseLogin(url) {
    if (isClaudeAuthenticatedUrl(url)) {
      scheduleClaudeUsageRefresh()
      setTimeout(() => {
        if (loginWin && !loginWin.isDestroyed()) loginWin.close()
      }, 3000)
    }
  }

  loginWin.webContents.on('did-finish-load', () => {
    if (!loginWin || loginWin.isDestroyed()) return
    checkAndCloseLogin(loginWin.webContents.getURL())
  })
  loginWin.webContents.on('did-navigate-in-page', (event, url) => {
    checkAndCloseLogin(url)
  })
  loginWin.webContents.on('did-navigate', (event, url) => {
    checkAndCloseLogin(url)
  })
  loginWin.on('closed', () => {
    loginWin = null
    scheduleClaudeUsageRefresh(600)
  })
}

function createScraper() {
  scraperView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: 'persist:claude'
    }
  })

  widgetWin.setBrowserView(scraperView)
  scraperView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  activeRefreshSource = 'initial'
  activeRefreshRequestId += 1
  sendRefreshState(true, 'initial')
  loadCodexUsage()
  scraperView.webContents.loadURL('https://claude.ai/settings/usage')
  scraperView.webContents.on('did-finish-load', () => {
    const requestId = activeRefreshRequestId
    setTimeout(() => extractUsageData(0, requestId), 800)
  })
  scraperView.webContents.on('did-navigate', (event, url) => {
    if (url.includes('/login') || url.includes('/auth')) {
      sendRefreshState(false, activeRefreshSource)
      sendClaudeUsageUpdate({ error: 'login_required' })
      openLoginWindow()
    }
  })
}

async function extractUsageData(attempt = 0, requestId = activeRefreshRequestId) {
  if (!scraperView) return
  if (requestId !== activeRefreshRequestId) return

  try {
    const data = await scraperView.webContents.executeJavaScript(`
      (function() {
        const bars = document.querySelectorAll('[role="progressbar"]')
        const pageText = document.body ? document.body.innerText : ''
        if (!bars.length) return null

        const getContextText = (el) => {
          let node = el
          for (let i = 0; i < 5 && node; i += 1) {
            if (node.innerText && node.innerText.trim()) return node.innerText
            node = node.parentElement
          }
          return ''
        }
        const getExpandedContextText = (el) => {
          let node = el
          let best = ''
          for (let i = 0; i < 8 && node; i += 1) {
            const text = normalize(node.innerText)
            if (text.length > best.length) best = text
            node = node.parentElement
          }
          return best
        }

        const normalize = (text) => String(text || '').replace(/\\s+/g, ' ').trim()
        const matchIn = (text, regex) => {
          const source = String(text || '')
          const m = source.match(regex)
          return m ? normalize(m[0]) : ''
        }
        const matchGroupIn = (text, regex, groupIndex = 1) => {
          const source = String(text || '')
          const m = source.match(regex)
          return m && m[groupIndex] ? normalize(m[groupIndex]) : ''
        }
        const findFirstMatch = (text, regexes) => {
          const source = String(text || '')
          for (const regex of regexes) {
            const matched = matchIn(source, regex)
            if (matched) return matched
          }
          return ''
        }
        const extractSectionText = (text, labels) => {
          const lines = String(text || '')
            .split(/\\n+/)
            .map((line) => normalize(line))
            .filter(Boolean)

          const labelIndex = lines.findIndex((line) => {
            const lower = line.toLowerCase()
            return labels.some((label) => lower.includes(label))
          })

          if (labelIndex === -1) return ''
          return lines.slice(labelIndex, labelIndex + 8).join('\\n')
        }
        const extractResetLine = (text) => {
          const lines = String(text || '')
            .split(/\\n+/)
            .map((line) => normalize(line))
            .filter(Boolean)

          return (
            lines.find((line) => /(reset|\uc7ac\uc124\uc815)/i.test(line)) ||
            lines.find((line) => /\\d+\\s*(?:m|min|mins|minute|minutes|\ubd84)/i.test(line)) ||
            ''
          )
        }
        const uniq = (values) => values.filter((value, index) => value && values.indexOf(value) === index)
        const moneyMatches = (text) => {
          const matches = String(text || '').match(/US\\$\\s*[\\d,.]+/g) || []
          return matches.map((item) => normalize(item))
        }
        const parseMoney = (value) => {
          const number = parseFloat(String(value || '').replace(/[^\\d.]/g, ''))
          return Number.isFinite(number) ? number : 0
        }
        const formatDuration = (text) => {
          const source = normalize(text)
          if (!source) return ''

          const hourMatch = source.match(/(\\d+)\\s*(?:h|hour|hours|시간)/i)
          const minuteMatch = source.match(/(\\d+)\\s*(?:m|min|mins|minute|minutes|분)/i)
          const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0
          const minutes = minuteMatch ? parseInt(minuteMatch[1], 10) : 0

          if (!hours && !minutes) return source
          if (!hours) return minutes + 'm'
          if (!minutes) return hours + 'h'
          return hours + 'h ' + minutes + 'm'
        }
        const compactDurationText = (text) => {
          const source = normalize(text)
          if (!source) return ''

          const hourMatch = source.match(/(\\d+)\\s*(?:h|hr|hrs|hour|hours|\\uC2DC\\uAC04)/i)
          const minuteMatch = source.match(/(\\d+)\\s*(?:m|min|mins|minute|minutes|\\uBD84)/i)
          const hours = hourMatch ? parseInt(hourMatch[1], 10) : 0
          const minutes = minuteMatch ? parseInt(minuteMatch[1], 10) : 0

          if (!hours && !minutes) return ''
          if (!hours) return minutes + 'm'
          if (!minutes) return hours + 'h'
          return hours + 'h ' + minutes + 'm'
        }

        const sessionText = bars[0] ? getContextText(bars[0]) : ''
        const sessionExpandedText = bars[0] ? getExpandedContextText(bars[0]) : ''
        const weeklyText = bars[1] ? getContextText(bars[1]) : ''
        const weeklyExpandedText = bars[1] ? getExpandedContextText(bars[1]) : ''
        const monthlyText = bars[2] ? getContextText(bars[2]) : ''
        const sessionSectionText = extractSectionText(pageText, ['current limit', '\\uD604\\uC7AC \\uC138\\uC158'])
        const weeklySectionText = extractSectionText(pageText, ['weekly limit', '\uc8fc\uac04 \ud55c\ub3c4'])
        const sessionResetLine =
          extractResetLine(sessionText) ||
          extractResetLine(sessionExpandedText) ||
          extractResetLine(sessionSectionText)
        const weeklyResetLine =
          extractResetLine(weeklyText) ||
          extractResetLine(weeklyExpandedText) ||
          extractResetLine(weeklySectionText)
        const weeklyResetFromPage =
          matchGroupIn(
            pageText,
            /(?:Weekly limit|\uc8fc\uac04 \ud55c\ub3c4)[\\s\\S]{0,240}?((?:\\d+\\s*(?:m|min|mins|minute|minutes|\ubd84)(?:\\s*(?:until\\s*)?(?:reset|\uc7ac\uc124\uc815)|\\s*\ud6c4\\s*\uc7ac\uc124\uc815)?)|(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\s*\\d{1,2}:\\d{2})|(?:(?:\uc624\uc804|\uc624\ud6c4)\\s*\\d{1,2}:\\d{2})|(?:\\d{1,2}[\\/-]\\d{1,2}\\s*\\d{1,2}:\\d{2}))/i
          ) ||
          matchGroupIn(
            pageText,
            /(?:All models|\ubaa8\ub4e0 \ubaa8\ub378)[\\s\\S]{0,120}?((?:\\d+\\s*(?:m|min|mins|minute|minutes|\ubd84)(?:\\s*(?:until\\s*)?(?:reset|\uc7ac\uc124\uc815)|\\s*\ud6c4\\s*\uc7ac\uc124\uc815)?)|(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\s*\\d{1,2}:\\d{2})|(?:(?:\uc624\uc804|\uc624\ud6c4)\\s*\\d{1,2}:\\d{2})|(?:\\d{1,2}[\\/-]\\d{1,2}\\s*\\d{1,2}:\\d{2}))/i
          )

        const sessionResetPatterns = [
          /\\d+\\s*(?:h|hr|hrs|hour|hours)(?:\\s*\\d+\\s*(?:m|min|mins|minute|minutes))?/i,
          /\\d+\\s*(?:m|min|mins|minute|minutes)(?:\\s*(?:until\\s*)?reset)?/i,
          /\\d+\\s*(?:\\uC2DC\\uAC04)(?:\\s*\\d+\\s*(?:\\uBD84))?/i,
          /\\d+\\s*(?:\\uBD84)(?:\\s*\\uD6C4\\s*\\uC7AC\\uC124\\uC815)?/i
        ]

        const weeklyResetPatterns = [
          /\\d+\\s*(?:m|min|mins|minute|minutes|\ubd84)/i,
          /\\d+\\s*(?:m|min|mins|minute|minutes|\ubd84)\\s*(?:until\\s*)?(?:reset|\uc7ac\uc124\uc815)/i,
          /\\d+\\s*(?:m|min|mins|minute|minutes|\ubd84)\\s*\ud6c4\\s*\uc7ac\uc124\uc815/i,
          /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\s*\\d{1,2}:\\d{2}(?:\\s*(?:reset|\uc7ac\uc124\uc815))?/i,
          /(?:\uc624\uc804|\uc624\ud6c4)\\s*\\d{1,2}:\\d{2}(?:\\s*(?:reset|\uc7ac\uc124\uc815))?/i,
          /\\d{1,2}[\\/-]\\d{1,2}\\s*\\d{1,2}:\\d{2}(?:\\s*(?:reset|\uc7ac\uc124\uc815))?/i
        ]

        const sessionResetRaw =
          matchIn(sessionText, /\\d+\\s*(?:h|hour|hours|시간)\\s*\\d*\\s*(?:m|min|mins|minute|minutes|분)?/i) ||
          matchIn(pageText, /\\d+\\s*(?:h|hour|hours|시간)\\s*\\d*\\s*(?:m|min|mins|minute|minutes|분)?/i)

        const weeklyResetRaw =
          weeklyResetFromPage ||
          findFirstMatch(weeklyResetLine, weeklyResetPatterns) ||
          findFirstMatch(weeklyText, weeklyResetPatterns) ||
          findFirstMatch(weeklyExpandedText, weeklyResetPatterns) ||
          findFirstMatch(weeklySectionText, weeklyResetPatterns)

        const sessionResetResolved =
          sessionResetRaw ||
          compactDurationText(findFirstMatch(sessionResetLine, sessionResetPatterns)) ||
          compactDurationText(findFirstMatch(sessionText, sessionResetPatterns)) ||
          compactDurationText(findFirstMatch(sessionExpandedText, sessionResetPatterns)) ||
          compactDurationText(findFirstMatch(sessionSectionText, sessionResetPatterns))

        const monthlyResetRaw =
          matchIn(monthlyText, /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2}|\\d{1,2}[\\/-]\\d{1,2}/i) ||
          matchIn(pageText, /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\s+\\d{1,2}|\\d{1,2}[\\/-]\\d{1,2}/i)

        const monthlyMoney = uniq(moneyMatches(monthlyText).concat(moneyMatches(pageText)))
        const spent = monthlyMoney[0] || ''
        const limit = monthlyMoney
          .filter((value) => value !== spent)
          .sort((a, b) => parseMoney(b) - parseMoney(a))[0] || ''

        return {
          session: {
            pct: parseInt(bars[0] ? bars[0].getAttribute('aria-valuenow') : 0, 10) || 0,
            reset: formatDuration(sessionResetResolved)
          },
          weekly: {
            pct: parseInt(bars[1] ? bars[1].getAttribute('aria-valuenow') : 0, 10) || 0,
            reset: normalize(weeklyResetRaw)
          },
          monthly: {
            pct: parseInt(bars[2] ? bars[2].getAttribute('aria-valuenow') : 0, 10) || 0,
            reset: normalize(monthlyResetRaw),
            spent,
            limit
          },
          timestamp: Date.now()
        }
      })()
    `)

    if (data) {
      if (requestId !== activeRefreshRequestId) return
      sendClaudeUsageUpdate(data)
      sendRefreshState(false, activeRefreshSource)
      return
    }

    if (attempt < 20) {
      setTimeout(() => {
        extractUsageData(attempt + 1, requestId)
      }, 500)
      return
    }

    if (requestId !== activeRefreshRequestId) return
    sendClaudeUsageUpdate({ error: 'usage_unavailable' })
    sendRefreshState(false, activeRefreshSource)
  } catch (error) {
    if (requestId !== activeRefreshRequestId) return
    sendClaudeUsageUpdate({ error: 'usage_unavailable' })
    sendRefreshState(false, activeRefreshSource)
    console.error('extract error:', error.message)
  }
}

ipcMain.on('refresh-usage', () => {
  refreshUsage('manual')
})

ipcMain.on('open-login', () => {
  openLoginWindow()
})

ipcMain.on('quit-app', () => {
  app.quit()
})

ipcMain.handle('resize-widget-by-delta', (event, deltaX) => {
  return applyScale(currentScale + (deltaX / BASE_W))
})

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    focusWidget()
  })

  app.whenReady().then(() => {
    createWidget()
    registerGlobalShortcuts()
    startCodexUsageMonitor()
    widgetWin.webContents.on('did-finish-load', () => {
      loadCodexUsage()
      setTimeout(createScraper, 300)
    })
    refreshInterval = setInterval(() => {
      refreshUsage('auto')
    }, CLAUDE_REFRESH_INTERVAL_MS)
  })
}

app.on('window-all-closed', () => app.quit())
app.on('activate', () => {
  if (!widgetWin) {
    createWidget()
    startCodexUsageMonitor()
    widgetWin.webContents.on('did-finish-load', () => {
      loadCodexUsage()
      setTimeout(createScraper, 300)
    })
    return
  }
  focusWidget()
})
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
