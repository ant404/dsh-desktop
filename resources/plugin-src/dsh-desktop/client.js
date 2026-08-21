// Browser half of the dsh-desktop plugin: a settings card showing app/runtime
// version info, one-click "检查更新" / "立即更新" and the 刷新页面 / 重启客户端
// actions, backed by the host routes (/dsh-desktop/info, /dsh-desktop/update,
// /dsh-desktop/restart). Same lazy-CJS bundle protocol as the shipped plugins
// (window.__ModuleLoader__.load), so no build step.
window.__ModuleLoader__.load({
  id: 'dsh-desktop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var TEXT = {
      zh: {
        title: 'DSH Desktop',
        subtitle: '桌面应用与 Harness 引擎版本、更新。',
        loading: '加载中…',
        appVersion: '应用版本',
        runtimeVersion: 'dsh 运行时版本',
        nodeVersion: '内置 Node',
        dataDir: '应用数据目录',
        runtimeDir: '运行时位置',
        updatedRuntime: '（已更新，优先于内置）',
        bundledRuntime: '（内置）',
        check: '检查更新',
        checking: '检查中…',
        upToDate: '已是最新版本',
        updateAvailable: '发现新版本',
        update: '立即更新',
        updating: '更新中，请稍候…（可能需数分钟）',
        phaseInstalling: '更新中：安装依赖…（可能需数分钟）',
        phaseSwapping: '更新中：替换运行时…',
        updated: '更新完成，请重启 DSH Desktop 生效',
        restartHint: '关闭窗口退出应用后重新打开即可。',
        error: '操作失败',
        networkHint: '检查更新需要网络连接。',
        openDataDir: '打开数据目录',
        refreshPage: '刷新页面',
        restartClient: '重启客户端',
        restartConfirm: '确定要重启 DSH Desktop 客户端吗？窗口会关闭并自动重新打开。',
        restarting: '正在重启客户端…',
        restartFailed: '重启失败',
      },
      en: {
        title: 'DSH Desktop',
        subtitle: 'Desktop shell and Harness engine version & updates.',
        loading: 'loading…',
        appVersion: 'App version',
        runtimeVersion: 'dsh runtime version',
        nodeVersion: 'Bundled Node',
        dataDir: 'App data directory',
        runtimeDir: 'Runtime location',
        updatedRuntime: ' (updated, preferred over bundled)',
        bundledRuntime: ' (bundled)',
        check: 'Check for updates',
        checking: 'checking…',
        upToDate: 'You are up to date',
        updateAvailable: 'Update available',
        update: 'Update now',
        updating: 'Updating, please wait… (may take a few minutes)',
        phaseInstalling: 'Updating: installing dependencies… (may take a few minutes)',
        phaseSwapping: 'Updating: replacing runtime…',
        updated: 'Update complete — restart DSH Desktop to apply',
        restartHint: 'Close the window to exit the app, then reopen it.',
        error: 'Operation failed',
        networkHint: 'Checking for updates needs a network connection.',
        openDataDir: 'Open data directory',
        refreshPage: 'Refresh page',
        restartClient: 'Restart client',
        restartConfirm: 'Restart DSH Desktop? The window will close and reopen automatically.',
        restarting: 'Restarting client…',
        restartFailed: 'Restart failed',
      },
    }

    function labels() {
      var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase()
      return lang.indexOf('zh') === 0 ? TEXT.zh : TEXT.en
    }

    function DeskCard(react) {
      var h = react.createElement
      return function DshDesktopCard() {
        var t = labels()
        var openState = react.useState(false)
        var infoState = react.useState(null)
        var checkState = react.useState(null) // { checking, updating, restarting, message, isError, updated, available }
        var open = openState[0]
        var info = infoState[0]
        var check = checkState[0]

        var loadInfo = react.useCallback(() => {
          fetch('/dsh-desktop/info')
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'load failed')
                return body
              })
            })
            .then(function (body) {
              infoState[1](body)
            })
            .catch(function (error) {
              checkState[1]({ isError: true, message: String(error.message || error) })
            })
        }, [])

        react.useEffect(function () {
          if (open && info === null) loadInfo()
        }, [open, info, loadInfo])

        // Server-side update status: the apply keeps running server-side even
        // after a page refresh, so the card polls and re-syncs on open.
        var pollTimer = null
        function clearPoll() {
          if (pollTimer) {
            clearTimeout(pollTimer)
            pollTimer = null
          }
        }
        function pollStatus() {
          clearPoll()
          fetch('/dsh-desktop/update/status')
            .then(function (r) {
              return r.json()
            })
            .then(function (s) {
              if (s.busy === true) {
                checkState[1]({ updating: true, phase: s.phase, message: '' })
                pollTimer = setTimeout(pollStatus, 3000)
              } else if (s.phase === 'done') {
                checkState[1]({ updated: true, message: t.updated + (s.version ? '（' + s.version + '）' : '') })
              } else if (s.phase === 'error') {
                checkState[1]({ isError: true, message: s.error || t.error })
              }
            })
            .catch(function () {})
        }
        react.useEffect(function () {
          if (open) pollStatus()
          return clearPoll
        }, [open])

        function doCheck(action) {
          if (action === 'apply') {
            checkState[1]({ updating: true, phase: 'installing', message: '' })
            pollStatus() // start polling; survives a refresh
          } else {
            checkState[1]({ checking: true, message: '' })
          }
          fetch('/dsh-desktop/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action }),
          })
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'update failed')
                return body
              })
            })
            .then(function (body) {
              if (action === 'apply' && body.updated === true) {
                clearPoll()
                checkState[1]({ updated: true, message: body.version ? t.updated + '（' + body.version + '）' : t.updated })
              } else if (body.updateAvailable === true) {
                checkState[1]({ message: t.updateAvailable + '：' + body.latest + '（当前 ' + body.current + '）', available: true })
              } else {
                checkState[1]({ message: t.upToDate + '（' + body.current + '）' })
              }
            })
            .catch(function (error) {
              var message = String(error && error.message ? error.message : error)
              var isNetwork = /fetch|Failed to fetch|ECONN|ENOTFOUND|network/i.test(message)
              // A 409 "another update is already running" — keep polling instead
              // of showing an error (the in-flight apply is on the server).
              if (action === 'apply' && /busy|already running/i.test(message)) {
                pollStatus()
                return
              }
              checkState[1]({ isError: true, message: message + (isNetwork ? ' ' + t.networkHint : '') })
            })
        }

        // Restart the whole DSH Desktop app: the host route spawns a detached
        // helper that kills the shell + this server, then relaunches the exe.
        function doRestart() {
          checkState[1]({ restarting: true, message: '' })
          fetch('/dsh-desktop/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'restart failed')
                return body
              })
            })
            .then(function () {
              checkState[1]({ restarting: true, message: t.restarting })
            })
            .catch(function (error) {
              var message = String(error && error.message ? error.message : error)
              checkState[1]({ isError: true, message: t.restartFailed + '：' + message })
            })
        }

        var row = function (label, value, sub) {
          return h(
            'div',
            {
              key: label,
              style: {
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: '12px',
                padding: '10px 0',
                borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              },
            },
            h(
              'div',
              { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, inherit)' } },
              label,
            ),
            h(
              'div',
              {
                style: {
                  fontSize: '13px',
                  textAlign: 'right',
                  overflowWrap: 'anywhere',
                  color: 'var(--dsw-alias-label-primary, inherit)',
                },
              },
              value,
              sub ? h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } }, sub) : null,
            ),
          )
        }

        // Secondary (outline) button — used by 刷新页面 / 重启客户端.
        var secondaryBtnStyle = function (disabled) {
          return {
            appearance: 'none',
            font: 'inherit',
            fontSize: '13px',
            lineHeight: 1.5,
            cursor: disabled ? 'default' : 'pointer',
            border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
            borderRadius: '8px',
            padding: '5px 12px',
            background: 'transparent',
            color: 'var(--dsw-alias-label-primary, inherit)',
            opacity: disabled ? 0.5 : 1,
          }
        }

        var chevron = h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 16 16',
            style: {
              color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              flex: 'none',
              transition: 'transform .16s',
              transform: open ? 'rotate(180deg)' : 'none',
            },
          },
          h('path', {
            d: 'M4 6l4 4 4-4',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          }),
        )

        var body = null
        if (open) {
          if (info === null) {
            body = h(
              'div',
              { style: { padding: '12px 0', fontSize: '13px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))' } },
              (check && check.message) || t.loading,
            )
          } else {
            var statusStyle = {
              fontSize: '12px',
              color: check && check.isError
                ? 'var(--dsw-alias-danger, #ff7a7a)'
                : check && check.updated
                  ? 'var(--dsw-alias-success, #7ed18c)'
                  : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))',
              marginBottom: '10px',
              lineHeight: 1.5,
            }
            var busy = Boolean(check && (check.checking || check.updating || check.restarting))
            var statusText = check
              ? check.checking
                ? t.checking
                : check.restarting
                  ? t.restarting
                  : check.updating
                    ? check.phase === 'swapping'
                      ? t.phaseSwapping
                      : check.phase === 'installing'
                        ? t.phaseInstalling
                        : t.updating
                    : check.message
                : ''
            body = h(
              'div',
              null,
              row(t.appVersion, info.appVersion),
              row(t.runtimeVersion, info.runtimeVersion, info.updatedRuntime ? t.updatedRuntime : t.bundledRuntime),
              row(t.nodeVersion, info.nodeVersion),
              row(t.dataDir, info.dataDirLabel || info.dataDir),
              statusText
                ? h('div', { role: 'status', style: statusStyle }, statusText)
                : null,
              check && check.updated
                ? h(
                    'div',
                    { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', marginBottom: '10px' } },
                    t.restartHint,
                  )
                : null,
              h(
                'div',
                {
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    gap: '8px',
                    padding: '12px 0 4px',
                  },
                },
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: function () {
                      location.reload()
                    },
                    style: secondaryBtnStyle(busy),
                  },
                  t.refreshPage,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: function () {
                      if (window.confirm(t.restartConfirm)) doRestart()
                    },
                    style: secondaryBtnStyle(busy),
                  },
                  t.restartClient,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: function () {
                      if (check && check.available) {
                        doCheck('apply')
                      } else {
                        doCheck('check')
                      }
                    },
                    style: {
                      appearance: 'none',
                      font: 'inherit',
                      fontSize: '13px',
                      lineHeight: 1.5,
                      cursor: busy ? 'default' : 'pointer',
                      border: '1px solid transparent',
                      borderRadius: '8px',
                      padding: '5px 14px',
                      background: 'var(--dsw-alias-label-primary, currentColor)',
                      color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
                      opacity: busy ? 0.5 : 1,
                    },
                  },
                  busy
                    ? check.checking
                      ? t.checking
                      : check.restarting
                        ? t.restarting
                        : t.updating
                    : check && check.available
                      ? t.update
                      : t.check,
                ),
              ),
            )
          }
        }

        return h(
          'div',
          {
            style: {
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))',
              background: open
                ? 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.10))'
                : 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))',
              borderRadius: '12px',
              transition: 'border-color .16s, background .16s',
            },
          },
          h(
            'button',
            {
              type: 'button',
              'aria-expanded': open,
              onClick: function () {
                openState[1](!open)
              },
              style: {
                appearance: 'none',
                width: '100%',
                font: 'inherit',
                color: 'inherit',
                textAlign: 'left',
                cursor: 'pointer',
                background: 'none',
                border: 0,
                borderRadius: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '14px 16px',
              },
            },
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontSize: '14px', fontWeight: 600 } }, t.title),
              h(
                'div',
                { style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontSize: '13px', lineHeight: 1.5 } },
                t.subtitle,
              ),
            ),
            chevron,
          ),
          open ? h('div', { style: { margin: '0 16px', paddingBottom: '8px' } }, body) : null,
        )
      }
    }

    // Compact row variant for 设置 → 通用设置: follows the section's row style
    // (label on the left, actions on the right, hairline border below) instead of
    // the folded settings card used in the Plugins page.
    function DeskRow(react) {
      var h = react.createElement
      return function DshDesktopRow() {
        var t = labels()
        var infoState = react.useState(null)
        var checkState = react.useState(null)
        var info = infoState[0]
        var check = checkState[0]

        var loadInfo = react.useCallback(function () {
          fetch('/dsh-desktop/info')
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'load failed')
                return body
              })
            })
            .then(function (body) { infoState[1](body) })
            .catch(function (error) { checkState[1]({ isError: true, message: String(error.message || error) }) })
        }, [])

        react.useEffect(function () {
          if (info === null) loadInfo()
        }, [info, loadInfo])

        var pollTimer = null
        function clearPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null } }
        function pollStatus() {
          clearPoll()
          fetch('/dsh-desktop/update/status')
            .then(function (r) { return r.json() })
            .then(function (s) {
              if (s.busy === true) {
                checkState[1]({ updating: true, phase: s.phase, message: '' })
                pollTimer = setTimeout(pollStatus, 3000)
              } else if (s.phase === 'done') {
                checkState[1]({ updated: true, message: t.updated + (s.version ? '（' + s.version + '）' : '') })
              } else if (s.phase === 'error') {
                checkState[1]({ isError: true, message: s.error || t.error })
              }
            })
            .catch(function () {})
        }
        react.useEffect(function () { pollStatus(); return clearPoll }, [])

        function doCheck(action) {
          if (action === 'apply') {
            checkState[1]({ updating: true, phase: 'installing', message: '' })
            pollStatus()
          } else {
            checkState[1]({ checking: true, message: '' })
          }
          fetch('/dsh-desktop/update', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: action }),
          })
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'update failed')
                return body
              })
            })
            .then(function (body) {
              if (action === 'apply' && body.updated === true) {
                clearPoll()
                checkState[1]({ updated: true, message: body.version ? t.updated + '（' + body.version + '）' : t.updated })
              } else if (body.updateAvailable === true) {
                checkState[1]({ message: t.updateAvailable + '：' + body.latest + '（当前 ' + body.current + '）', available: true })
              } else {
                checkState[1]({ message: t.upToDate + '（' + body.current + '）' })
              }
            })
            .catch(function (error) {
              var message = String(error && error.message ? error.message : error)
              var isNetwork = /fetch|Failed to fetch|ECONN|ENOTFOUND|network/i.test(message)
              if (action === 'apply' && /busy|already running/i.test(message)) {
                pollStatus()
                return
              }
              checkState[1]({ isError: true, message: message + (isNetwork ? ' ' + t.networkHint : '') })
            })
        }

        function doRestart() {
          checkState[1]({ restarting: true, message: '' })
          fetch('/dsh-desktop/restart', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
            .then(function (r) {
              return r.json().then(function (body) {
                if (!r.ok) throw new Error(body.error || 'restart failed')
                return body
              })
            })
            .then(function () { checkState[1]({ restarting: true, message: t.restarting }) })
            .catch(function (error) {
              var message = String(error && error.message ? error.message : error)
              checkState[1]({ isError: true, message: t.restartFailed + '：' + message })
            })
        }

        var busy = Boolean(check && (check.checking || check.updating || check.restarting))
        var statusText = check
          ? check.checking
            ? t.checking
            : check.updating
              ? check.phase === 'swapping'
                ? t.phaseSwapping
                : check.phase === 'installing'
                  ? t.phaseInstalling
                  : t.updating
              : check.restarting
                ? t.restarting
                : check.message
          : ''
        var statusColor = check && check.isError
          ? 'var(--dsw-alias-danger, #ff7a7a)'
          : check && check.updated
            ? 'var(--dsw-alias-success, #7ed18c)'
            : 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))'

        var btnBase = { appearance: 'none', font: 'inherit', fontSize: '13px', lineHeight: 1.5, cursor: busy ? 'default' : 'pointer', borderRadius: '8px', padding: '5px 12px' }
        var primary = Object.assign({}, btnBase, { border: '1px solid transparent', background: 'var(--dsw-alias-label-primary, currentColor)', color: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,0.05))', opacity: busy ? 0.5 : 1 })
        var secondary = Object.assign({}, btnBase, { background: 'none', color: 'var(--dsw-alias-label-primary, inherit)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.35))', opacity: busy ? 0.5 : 1 })

        var detailLines = info
          ? [
              t.appVersion + ' ' + info.appVersion + ' · ' + t.runtimeVersion + ' ' + info.runtimeVersion,
              t.nodeVersion + ' ' + info.nodeVersion,
              t.dataDir + ' ' + (info.dataDirLabel || info.dataDir),
            ]
          : [t.loading]

        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '16px 0' } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '14px', fontWeight: 400, lineHeight: '22px' } }, t.title),
            (detailLines || []).map(function (line) {
              return h('div', { key: line, style: { color: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,0.8))', fontSize: '12px', lineHeight: 1.5, overflowWrap: 'anywhere' } }, line)
            }),
            statusText
              ? h('div', { role: 'status', style: { color: statusColor, fontSize: '12px', marginTop: '2px', lineHeight: 1.5 } }, statusText)
              : null,
          ),
          h('button', { type: 'button', disabled: busy, onClick: function () { location.reload() }, style: secondary }, t.refreshPage),
          h('button', { type: 'button', disabled: busy, onClick: function () { if (window.confirm(t.restartConfirm)) doRestart() }, style: secondary }, t.restartClient),
          h(
            'button',
            { type: 'button', disabled: busy, onClick: function () { if (check && check.available) doCheck('apply'); else doCheck('check') }, style: primary },
            busy
              ? check.checking
                ? t.checking
                : check.restarting
                  ? t.restarting
                  : t.updating
              : check && check.available
                ? t.update
                : t.check,
          ),
        )
      }
    }

    function apply(ctx) {
      if (typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], function (scope) {
        try {
          var react = require('react')
          // Only surface the compact row in 设置 → 通用设置 (General section); the
          // folded card in the Plugins page is intentionally removed.
          var Row = DeskRow(react)
          scope.slots.inject('settings.general.item', function* () {
            yield scope.slots.register({ name: 'settings.general.item', id: 'dsh-desktop', order: 80 }, Row)
          })
        } catch (error) {
          console.error('[dsh-desktop] settings card skipped: ' + error)
        }
      })
    }

    exports.apply = apply
    exports.inject = []
    return module.exports
  },
})
