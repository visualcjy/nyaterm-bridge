// nyaterm-bridge — client half.
//
// Settings → NyaTerm 白名单: edit the per-workspace allowlist that governs the
// nt_* tools (which NyaTerm groups / connections a workspace may open and drive).
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load;
// the factory receives a synchronous `require` for shared client modules (only
// `react` here). The page registers into the settings shell's `settings.section`
// slot — the same seat dsh-remote uses — and talks to the host half through the
// routes it mounts on the Harness web server (`/nyaterm/api/allowlist`), so a
// save is a same-origin fetch and takes effect on the next tool call.
window.__ModuleLoader__.load({
  id: 'nyaterm-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const name = 'nyaterm-bridge'

    // ── theme tokens (fallbacks keep the page readable outside the app shell) ──
    const C = {
      text: 'var(--dsw-alias-label-primary, currentColor)',
      muted: 'var(--dsw-alias-label-secondary, #6b7280)',
      line: 'var(--dsw-alias-border-secondary, rgba(128,128,128,.28))',
      bg: 'var(--dsw-alias-bg-layer-2, transparent)',
      bgSoft: 'var(--dsw-alias-bg-layer-3, rgba(128,128,128,.08))',
      accent: 'var(--dsw-alias-label-link, #2563eb)',
      danger: 'var(--dsw-alias-label-danger, #b42318)',
      radius: 'var(--dsw-radius-md, 8px)',
    }

    /** One <style> for pseudo-classes inline styles cannot express. */
    const ensureCss = () => {
      if (document.getElementById('nyaterm-bridge-css') !== null) return
      const style = document.createElement('style')
      style.id = 'nyaterm-bridge-css'
      style.textContent = `
        .ntb input[type=text]{font:inherit;padding:6px 9px;border-radius:${C.radius};border:1px solid ${C.line};background:transparent;color:${C.text};min-width:0;width:100%}
        .ntb input[type=text]:focus{outline:2px solid ${C.accent};outline-offset:-1px}
        .ntb select{font:inherit;padding:6px 9px;border-radius:${C.radius};border:1px solid ${C.line};background:transparent;color:${C.text};min-width:0;width:100%}
        .ntb select:focus{outline:2px solid ${C.accent};outline-offset:-1px}
        .ntb button{font:inherit;padding:6px 12px;border-radius:${C.radius};border:1px solid ${C.line};background:transparent;color:${C.text};cursor:pointer}
        .ntb button:hover{border-color:${C.accent}}
        .ntb button.primary{background:${C.accent};border-color:${C.accent};color:#fff;font-weight:600}
        .ntb button.primary:disabled{opacity:.5;cursor:default}
        .ntb button.danger{color:${C.danger}}
        .ntb .chip{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border-radius:999px;border:1px solid ${C.line};font-size:12.5px;cursor:pointer;user-select:none;color:${C.text}}
        .ntb .chip.on{border-color:${C.accent}}
        .ntb .chip input{accent-color:${C.accent};margin:0}
        .ntb .chip button.mode{font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid ${C.line};background:transparent;color:inherit;line-height:1.5}
        .ntb .chip button.mode:hover{border-color:${C.accent}}
        .ntb .connRow{display:flex;align-items:center;gap:8px;padding:1px 0}
        .ntb .connRow button.mode{font-size:11.5px;padding:1px 7px;border-radius:999px;border:1px solid ${C.line};background:transparent;color:inherit;line-height:1.5;flex:none}
        .ntb .connRow button.mode:hover{border-color:${C.accent}}
        .ntb .rule{border:1px solid ${C.line};border-radius:${C.radius};padding:12px 14px;margin-bottom:12px}
        .ntb .card{border:1px solid ${C.line};border-radius:${C.radius};padding:12px 14px;margin-bottom:14px}
        .ntb .list{max-height:180px;overflow:auto;border:1px solid ${C.line};border-radius:${C.radius};padding:6px 10px;margin-top:6px}
        .ntb .list label{display:flex;gap:7px;align-items:center;padding:2px 0;font-size:12.5px;color:${C.text}}
        .ntb .muted{color:${C.muted}}
        .ntb .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
        .ntb .col{display:flex;flex-direction:column;gap:3px}
      `
      document.head.append(style)
    }

    const fmt = (rule) => JSON.stringify({
      pattern: rule.pattern, groups: rule.groups, hosts: rule.hosts, connections: rule.connections, observe: rule.observe,
    })

    /** Where the effective `nyaterm-mcp` path came from. */
    const BRIDGE_SOURCE_LABEL = {
      setting: '已保存设置',
      config: '插件配置',
      detected: '自动检测',
    }
    const sourceLabel = (source) => BRIDGE_SOURCE_LABEL[source] ?? '未找到'

    // ── data helpers (mirror the host's admission rules) ─────────────────────
    const groupMatches = (connection, list) => {
      if (!Array.isArray(list) || list.length === 0) return false
      const path = connection.groupPath
      for (const wanted of list) {
        if (path.includes(wanted)) return true
        if (path.join(' / ') === wanted || path.join('/') === wanted) return true
      }
      return false
    }

    /** 'rw' | 'ro' | null — most specific grant wins, read-only wins a tie. */
    const admitTarget = (rule, connection) => {
      if ((rule.observeConnections ?? []).includes(connection.id)) return 'ro'
      if (rule.connections.includes(connection.id)) return 'rw'
      if ((rule.observeHosts ?? []).includes(connection.name)) return 'ro'
      if (rule.hosts.includes(connection.name)) return 'rw'
      if (groupMatches(connection, rule.observeGroups ?? [])) return 'ro'
      if (groupMatches(connection, rule.groups)) return 'rw'
      return null
    }

    const admission = (rule, connection) => {
      const mode = admitTarget(rule, connection)
      if (mode === null) return null
      return rule.observe ? 'ro' : mode
    }

    const toRules = (workspaces) => Object.entries(workspaces ?? {}).map(([pattern, rule]) => ({
      pattern,
      groups: [...(rule.groups ?? [])],
      hosts: [...(rule.hosts ?? [])],
      connections: [...(rule.connections ?? [])],
      observeGroups: [...(rule.observeGroups ?? [])],
      observeHosts: [...(rule.observeHosts ?? [])],
      observeConnections: [...(rule.observeConnections ?? [])],
      observe: rule.observe === true,
    }))

    const toPayload = (rules) => {
      const workspaces = {}
      for (const rule of rules) {
        const pattern = rule.pattern.trim()
        if (pattern.length === 0) continue
        workspaces[pattern] = {
          groups: rule.groups,
          hosts: rule.hosts,
          connections: rule.connections,
          observeGroups: rule.observeGroups ?? [],
          observeHosts: rule.observeHosts ?? [],
          observeConnections: rule.observeConnections ?? [],
          observe: rule.observe === true,
        }
      }
      return { workspaces }
    }

    // ── one rule card ───────────────────────────────────────────────────────
    /** Sentinel option value: the rule keeps a hand-written path / glob. */
    const CUSTOM_WORKSPACE = '\u0000custom'
    const RuleCard = ({ rule, index, data, onChange, onRemove }) => {
      const knownGroups = React.useMemo(() => {
        const set = new Set(data.groups ?? [])
        for (const group of rule.groups) set.add(group)
        for (const group of rule.observeGroups ?? []) set.add(group)
        return [...set].sort()
      }, [data.groups, rule.groups, rule.observeGroups])
      const admitted = (data.connections ?? [])
        .map((connection) => ({ connection, mode: admission(rule, connection) }))
        .filter((row) => row.mode !== null)
      const [filter, setFilter] = React.useState('')
      // DSH's durable workspace list, offered instead of free typing. A rule
      // whose pattern is not one of them (a glob, or a path dropped from the
      // sidebar) opens in custom mode so it stays editable.
      const candidates = data.workspaceCandidates ?? []
      const candidatePaths = candidates.map((candidate) => candidate.path)
      const [customPath, setCustomPath] = React.useState(rule.pattern !== '' && !candidatePaths.includes(rule.pattern))

      const patch = (fields) => onChange(index, { ...rule, ...fields })

      const observeGroups = rule.observeGroups ?? []
      const observeConnections = rule.observeConnections ?? []

      /** The checkbox only adds/removes; the mode button cycles rw <-> ro. */
      const toggleMember = (listKey, observeKey, value) => {
        const present = rule[listKey].includes(value) || rule[observeKey].includes(value)
        if (present) {
          return patch({
            [listKey]: rule[listKey].filter((item) => item !== value),
            [observeKey]: rule[observeKey].filter((item) => item !== value),
          })
        }
        return patch({ [listKey]: [...rule[listKey], value] })
      }
      const flipMode = (listKey, observeKey, value) => {
        const ro = rule[observeKey].includes(value)
        if (ro) return patch({ [observeKey]: rule[observeKey].filter((item) => item !== value), [listKey]: [...rule[listKey], value] })
        return patch({ [listKey]: rule[listKey].filter((item) => item !== value), [observeKey]: [...rule[observeKey], value] })
      }

      const groupChips = h('div', { className: 'row', style: { gap: 6 } },
        ...knownGroups.map((group) => {
          const rw = rule.groups.includes(group)
          const ro = observeGroups.includes(group)
          const on = rw || ro
          return h('label', { key: group, className: `chip${on ? ' on' : ''}` },
            h('input', { type: 'checkbox', checked: on, onChange: () => toggleMember('groups', 'observeGroups', group) }),
            group,
            on
              ? h('button', {
                type: 'button', className: 'mode',
                title: '只读：可以开会话、读终端输出，但不能执行命令',
                onClick: (event) => { event.preventDefault(); event.stopPropagation(); flipMode('groups', 'observeGroups', group) },
              }, ro ? '只读' : '读写')
              : null,
          )
        }),
        h('input', {
          type: 'text', placeholder: '其他分组，回车添加', style: { width: 180 },
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            const value = event.currentTarget.value.trim()
            if (value.length === 0) return
            patch({ groups: [...new Set([...rule.groups, value])] })
            event.currentTarget.value = ''
          },
        }),
      )

      const needle = filter.trim().toLowerCase()
      const rows = (data.connections ?? [])
        .filter((connection) => needle.length === 0
          || connection.name.toLowerCase().includes(needle)
          || connection.groupPath.join(' / ').toLowerCase().includes(needle)
          || connection.id.toLowerCase().includes(needle))
        .map((connection) => {
          const rw = rule.connections.includes(connection.id)
          const ro = observeConnections.includes(connection.id)
          const on = rw || ro
          return h('div', { key: connection.id, className: 'connRow' },
            h('label', { style: { flex: 1, minWidth: 0 } },
              h('input', { type: 'checkbox', checked: on, onChange: () => toggleMember('connections', 'observeConnections', connection.id) }),
              h('span', null, connection.name),
              h('span', { className: 'muted' }, connection.groupPath.length > 0 ? `[${connection.groupPath.join(' / ')}]` : '(未分组)'),
            ),
            on
              ? h('button', {
                type: 'button', className: 'mode',
                title: '只读：可以开会话、读终端输出，但不能执行命令',
                onClick: () => flipMode('connections', 'observeConnections', connection.id),
              }, ro ? '只读' : '读写')
              : null,
          )
        })
      const vanished = [...new Set([...rule.connections, ...observeConnections])]
        .filter((value) => !(data.connections ?? []).some((connection) => connection.id === value))
      for (const id of vanished) {
        rows.push(h('div', { key: id, className: 'connRow' },
          h('label', { style: { flex: 1, minWidth: 0 } },
            h('input', { type: 'checkbox', checked: true, onChange: () => toggleMember('connections', 'observeConnections', id) }),
            h('span', null, id),
            h('span', { className: 'muted' }, '(已不存在于 NyaTerm)'),
          ),
          observeConnections.includes(id)
            ? h('span', { className: 'mode' }, '只读')
            : null,
        ))
      }

      return h('div', { className: 'rule' },
        h('div', { className: 'row' },
          h('span', { className: 'muted', style: { minWidth: 52, fontSize: 12.5 } }, '工作区'),
          h('div', { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 } },
            h('select', {
              className: 'sel',
              value: customPath ? CUSTOM_WORKSPACE : rule.pattern,
              onChange: (event) => {
                const next = event.target.value
                if (next === CUSTOM_WORKSPACE) {
                  setCustomPath(true)
                  return
                }
                setCustomPath(false)
                patch({ pattern: next })
              },
            },
              h('option', { value: '' }, candidates.length === 0
                ? 'DSH 里还没有工作区记录 —— 用下面的自定义路径'
                : '选择工作区…'),
              ...candidates.map((candidate) => h('option', { key: candidate.path, value: candidate.path },
                candidate.title.length > 0 && candidate.title !== candidate.path
                  ? `${candidate.title} — ${candidate.path}`
                  : candidate.path)),
              h('option', { value: CUSTOM_WORKSPACE }, '自定义路径 / 通配符…'),
            ),
            customPath
              ? h('input', {
                type: 'text', value: rule.pattern, spellCheck: false,
                placeholder: '/Users/you/project 或 /Users/you/work-*',
                onChange: (event) => patch({ pattern: event.target.value }),
              })
              : null,
          ),
          h('label', { className: 'chip', title: '整个工作区只读：覆盖下面所有分组的设置' },
            h('input', { type: 'checkbox', checked: rule.observe, onChange: (event) => patch({ observe: event.target.checked }) }),
            '全部只读',
          ),
          h('button', { className: 'danger', type: 'button', onClick: () => onRemove(index) }, '删除'),
        ),
        h('div', { style: { marginTop: 10 } },
          h('div', { className: 'muted', style: { fontSize: 12.5, marginBottom: 6 } }, '放行的分组'),
          groupChips,
        ),
        h('div', { style: { marginTop: 10 } },
          h('div', { className: 'row' },
            h('span', { className: 'muted', style: { fontSize: 12.5 } }, '放行的连接'),
            h('input', { type: 'text', placeholder: '按名字/分组过滤…', style: { width: 220 }, onChange: (event) => setFilter(event.target.value) }),
          ),
          h('div', { className: 'list' }, ...(rows.length > 0 ? rows : [h('div', { className: 'muted', style: { fontSize: 12.5 } }, '没有匹配的连接')])),
        ),
        h('div', { className: 'muted', style: { marginTop: 8, fontSize: 12.5 } },
          `此规则当前可到达 ${admitted.length} / ${(data.connections ?? []).length} 条连接`,
          admitted.length > 0
            ? `（${admitted.filter((row) => row.mode === 'rw').length} 可写、${admitted.filter((row) => row.mode === 'ro').length} 只读）：`
              + admitted.map((row) => (row.mode === 'ro' ? `${row.connection.name}(只读)` : row.connection.name)).join('、')
            : '',
        ),
      )
    }

    // ── the settings page ───────────────────────────────────────────────────
    const Page = () => {
      const [data, setData] = React.useState(null)
      const [rules, setRules] = React.useState([])
      const [bridgeDraft, setBridgeDraft] = React.useState('')
      const [baseline, setBaseline] = React.useState('')
      const [status, setStatus] = React.useState({ kind: 'muted', text: '读取中…' })
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setStatus({ kind: 'muted', text: '读取中…' })
        const response = await fetch('/nyaterm/api/allowlist', { headers: { accept: 'application/json' } })
        if (!response.ok) {
          throw new Error(response.status === 401 || response.status === 403
            ? `无法访问白名单接口（HTTP ${response.status}）：请确认 nyaterm-bridge 插件已启用，并刷新页面重试。`
            : `读取白名单失败：HTTP ${response.status}`)
        }
        const next = await response.json()
        const loaded = toRules(next.workspaces)
        const savedBridge = next.bridge?.saved ?? ''
        setData(next)
        setRules(loaded)
        setBridgeDraft(savedBridge)
        setBaseline(JSON.stringify({ ...toPayload(loaded), bridgeExecutable: savedBridge }))
        setStatus({ kind: 'ok', text: '已读取' })
      }, [])

      React.useEffect(() => { load().catch((error) => setStatus({ kind: 'err', text: error.message })) }, [load])

      const payloadOf = (list = rules, draft = bridgeDraft) => ({
        ...toPayload(list),
        bridgeExecutable: draft.trim(),
      })
      const dirty = JSON.stringify(payloadOf()) !== baseline
      const onChange = (index, rule) => setRules((current) => current.map((item, at) => (at === index ? rule : item)))
      const onRemove = (index) => setRules((current) => current.filter((item, at) => at !== index))

      /** Re-scan this machine without discarding unsaved workspace edits. */
      const detect = async () => {
        setStatus({ kind: 'muted', text: '检测中…' })
        try {
          const response = await fetch('/nyaterm/api/allowlist', { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`检测失败：HTTP ${response.status}`)
          const next = await response.json()
          const candidates = next.bridge?.candidates ?? []
          setData((current) => ({ ...current, bridge: next.bridge }))
          if (bridgeDraft.trim().length === 0 && candidates.length > 0) setBridgeDraft(candidates[0])
          setStatus(candidates.length > 0
            ? { kind: 'ok', text: `检测到 ${candidates.length} 个 nyaterm-mcp` }
            : { kind: 'err', text: '没有检测到 nyaterm-mcp，请手动填写完整路径' })
        } catch (error) {
          setStatus({ kind: 'err', text: error.message })
        }
      }

      const save = async () => {
        const payload = payloadOf()
        const patterns = Object.keys(payload.workspaces)
        if (patterns.length !== rules.filter((rule) => rule.pattern.trim().length > 0).length) {
          setStatus({ kind: 'err', text: '有空白或重复的工作区规则，先修掉再保存' })
          return
        }
        if (patterns.length === 0) {
          setStatus({ kind: 'err', text: '至少保留一条规则' })
          return
        }
        setBusy(true)
        setStatus({ kind: 'muted', text: '保存中…' })
        try {
          const response = await fetch('/nyaterm/api/allowlist', {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
          })
          const body = await response.json().catch(() => ({}))
          if (!response.ok) {
            setStatus({ kind: 'err', text: `保存失败：${(body.problems ?? [body.error ?? `HTTP ${response.status}`]).join('；')}` })
            return
          }
          const savedBridge = body.bridgeExecutable ?? ''
          setBridgeDraft(savedBridge)
          // Refresh "当前生效" without re-reading (and thus discarding) the rules.
          if (body.bridge !== undefined) setData((current) => ({ ...current, bridge: body.bridge }))
          setBaseline(JSON.stringify({ ...toPayload(rules), bridgeExecutable: savedBridge }))
          setStatus({ kind: 'ok', text: '已保存，立即生效' })
        } catch (error) {
          setStatus({ kind: 'err', text: `保存失败：${error.message}` })
        } finally {
          setBusy(false)
        }
      }

      if (data === null) {
        return h('div', { className: 'ntb', style: { padding: '24px 4px', color: C.muted } }, status.text)
      }

      const policy = data.policy ?? {}
      const bridge = data.bridge ?? {}
      const candidates = bridge.candidates ?? []
      const bridgeDirty = bridgeDraft.trim() !== (bridge.saved ?? '')
      const colour = status.kind === 'err' ? C.danger : status.kind === 'ok' ? 'var(--dsw-alias-label-success, #067647)' : C.muted

      return h('div', { className: 'ntb', style: { padding: '4px 2px 24px', color: C.text } },
        h('div', { className: 'card' },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, '工作区白名单'),
          h('div', { className: 'muted', style: { fontSize: 12.5, lineHeight: 1.6 } },
            '决定每个工作区可以操作 NyaTerm 的哪些分组与连接。可写 = 能开会话并执行命令；只读 = 能开会话、能读终端输出，但不能执行命令。保存后立即生效，不需要重启。',
            h('br'),
            '未匹配任何规则的工作区默认',
            policy.defaultObserveOnly ? '只读' : '被拒绝',
            '；勾选「只读」的规则不允许开会话或执行命令。',
          ),
          h('div', { className: 'muted', style: { fontSize: 12, marginTop: 8, wordBreak: 'break-all' } }, `存储文件：${data.storeFile}`),
          data.nyaTermError === null || data.nyaTermError === undefined ? null : h('div', { style: { color: C.danger, fontSize: 12.5, marginTop: 8 } },
            `NyaTerm 当前不可达，分组与连接列表为空：${data.nyaTermError}`),
          policy.enforceAllowlist === false ? h('div', { style: { color: C.danger, fontSize: 12.5, marginTop: 8 } },
            '强制白名单已关闭（enforceAllowlist: false）——这里的规则不会生效。') : null,
        ),

        h('div', { className: 'card' },
          h('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 4 } }, 'MCP 程序位置'),
          h('div', { className: 'muted', style: { fontSize: 12.5, lineHeight: 1.6 } },
            'nyaterm-mcp 跟随 NyaTerm 安装，位置因安装方式和用户而异：Windows 普通用户装在各用户的 ',
            h('code', null, '%LOCALAPPDATA%\\Programs\\NyaTerm\\'),
            ' 下，管理员安装才在 Program Files。留空表示自动检测（平台默认位置 → PATH）。',
            h('br'),
            '自定义路径必须存在、可执行，且文件名是 nyaterm-mcp（Windows 为 nyaterm-mcp.exe）。保存后立即生效，不需要重启。',
          ),
          h('div', { className: 'muted', style: { fontSize: 12.5, marginTop: 8, wordBreak: 'break-all' } },
            `当前生效：${bridge.effective || '(未找到)'}（${sourceLabel(bridge.source)}）`),
          bridgeDirty
            ? h('div', { style: { color: C.accent, fontSize: 12.5, marginTop: 4 } }, '改动尚未保存 —— 点页面底部的「保存」生效。')
            : null,
          bridge.problem
            ? h('div', { style: { color: C.danger, fontSize: 12.5, marginTop: 4 } }, `路径不可用：${bridge.problem}`)
            : null,
          h('div', { style: { marginTop: 8 } },
            h('input', {
              type: 'text', value: bridgeDraft, spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off',
              placeholder: candidates.length > 0 ? candidates[0] : '留空自动检测，或填写 nyaterm-mcp 的完整路径',
              onChange: (event) => setBridgeDraft(event.target.value),
            }),
          ),
          h('div', { className: 'row', style: { marginTop: 6 } },
            h('button', { type: 'button', onClick: detect }, '自动检测'),
            h('button', { type: 'button', disabled: bridgeDraft.length === 0, onClick: () => setBridgeDraft('') }, '恢复自动'),
          ),
          candidates.length > 0
            ? h('div', { className: 'row', style: { marginTop: 8, gap: 6 } },
              h('span', { className: 'muted', style: { fontSize: 12.5 } }, '本机检测到：'),
              ...candidates.map((candidate) => h('button', {
                key: candidate, type: 'button',
                style: { fontSize: 12, padding: '2px 8px', maxWidth: '100%', wordBreak: 'break-all', textAlign: 'left' },
                title: candidate,
                onClick: () => setBridgeDraft(candidate),
              }, candidate)),
            )
            : h('div', { className: 'muted', style: { fontSize: 12.5, marginTop: 8 } },
              '没有自动检测到 nyaterm-mcp，请手动填写完整路径。'),
        ),

        rules.length === 0
          ? h('div', { className: 'muted', style: { padding: '8px 0 12px', fontSize: 13 } }, '还没有任何规则——未列入的工作区会被拒绝。')
          : null,

        ...rules.map((rule, index) => h(RuleCard, { key: index, rule, index, data, onChange, onRemove })),

        h('div', { className: 'row', style: { marginTop: 4 } },
          h('button', { type: 'button', onClick: () => setRules((current) => [...current, { pattern: '', groups: [], hosts: [], connections: [], observeGroups: [], observeHosts: [], observeConnections: [], observe: false }]) }, '+ 添加工作区规则'),
          h('button', { type: 'button', className: 'primary', disabled: !dirty || busy, onClick: save }, busy ? '保存中…' : '保存'),
          h('button', { type: 'button', disabled: busy, onClick: () => load().catch((error) => setStatus({ kind: 'err', text: error.message })) }, '重新读取'),
          h('span', { style: { color: colour, fontSize: 12.5, marginLeft: 4 } }, status.text),
        ),
      )
    }

    // ── plugin body (same shape as a host plugin: name/inject/apply) ────────
    function apply(ctx) {
      // A settings page must never take the client boot down: if the slot seat
      // is missing or shaped differently on some build, fail inert (no page)
      // instead of throwing inside the boot graph.
      try {
        ensureCss()
        // `settings.section` is the settings shell's nav-item seat; inject()
        // keeps this plugin dormant (rather than broken) when a composition
        // swaps the shell out.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'nyaterm-allowlist',
          order: 60,
          label: () => 'NyaTerm 白名单',
        }, Page))
      } catch (error) {
        console.error('nyaterm-bridge: settings page failed to register', error)
      }
    }

    exports.name = name
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
