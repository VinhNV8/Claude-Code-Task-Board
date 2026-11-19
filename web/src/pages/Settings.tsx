import { useEffect, useState } from 'react'
import { Bell, CalendarClock, Cpu, FileText, Info, KeyRound, Languages, Timer } from 'lucide-react'
import { IS_MOCK, notify, refreshAgents, saveClaudeAuth, saveTelegram, testTelegram, toast, updateSettings, useStore } from '../store/store'
import { AgentSelect, ChainEditor, useAgents } from '../components/AgentSelect'
import type { ClaudeAuthMode } from '../types'
import { MODEL_OPTIONS } from '../lib/model'
import { Button, Field, inputCls } from '../components/ui'
import { TemplateManager } from '../components/TemplateManager'
import { ScheduleManager } from '../components/ScheduleManager'
import { LANG, LANGS, setLang, tr, type Lang } from '../lib/i18n'

/** SPEC-MULTI-AGENT FR-92: agent nào đã được hỗ trợ / đã cài trên máy, phiên bản, nút dò lại. */
function AgentStatusList() {
  const agents = useAgents()
  const [checking, setChecking] = useState(false)
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">{tr('Các agent trên máy')}</span>
        <Button
          variant="ghost"
          disabled={checking}
          onClick={async () => {
            setChecking(true)
            await refreshAgents()
            setChecking(false)
          }}
        >
          {tr('Kiểm tra lại')}
        </Button>
      </div>
      <ul className="space-y-1">
        {agents.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-2 text-xs">
            <span className="w-36 font-medium">{a.label}</span>
            <span className={a.supported && a.installed ? 'text-emerald-600' : 'text-slate-500'}>
              {!a.supported ? tr('Sắp có') : a.installed ? tr('Đã cài') : tr('Chưa cài')}
            </span>
            {a.version && <span className="text-slate-500">{a.version}</span>}
            {a.limitedUntil && (
              <span className="text-amber-600">
                {tr('Hết hạn mức đến {time}', { time: new Date(a.limitedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Section({ icon, title, children }: { icon: JSX.Element; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="mb-4 inline-flex items-center gap-2 font-semibold">
        {icon} {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

/** Thông báo Telegram (FR-51): token chỉ gửi lên, không bao giờ đọc lại từ backend. */
function TelegramSettings() {
  const { telegram } = useStore().settings
  const [enabled, setEnabled] = useState(telegram.enabled)
  const [chatId, setChatId] = useState(telegram.chatId)
  const [appUrl, setAppUrl] = useState(telegram.appUrl)
  const [botToken, setBotToken] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | 'clear' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setEnabled(telegram.enabled)
    setChatId(telegram.chatId)
    setAppUrl(telegram.appUrl)
  }, [telegram.enabled, telegram.chatId, telegram.appUrl])

  const input = () => ({ enabled, chatId, appUrl: appUrl.trim() || location.origin, botToken: botToken.trim() || undefined })

  async function run(kind: 'save' | 'test' | 'clear') {
    setBusy(kind)
    setError(null)
    const err =
      kind === 'test' ? await testTelegram(input()) : kind === 'clear' ? await saveTelegram({ botToken: null, enabled: false }) : await saveTelegram(input())
    setBusy(null)
    if (err) return setError(err)
    if (kind !== 'test') setBotToken('')
    toast({
      kind: 'success',
      title: kind === 'test' ? tr('Đã gửi tin nhắn thử tới Telegram') : kind === 'clear' ? tr('Đã xoá bot token') : tr('Đã lưu cấu hình Telegram'),
    })
  }

  return (
    <div className="space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
      <label className="flex items-center gap-3">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        <span className="text-sm">
          {tr('Gửi thông báo qua Telegram')}
          <span className="block text-xs text-slate-500">{tr('Dùng cùng lựa chọn “Thông báo khi task chuyển sang” ở trên, tin nhắn kèm liên kết mở task.')}</span>
        </span>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bot token" hint={telegram.hasToken ? tr('Đã lưu token. Để trống để giữ nguyên, nhập để thay.') : tr('Tạo bot với @BotFather rồi dán token vào đây.')}>
          <input
            type="password"
            autoComplete="off"
            className={inputCls}
            value={botToken}
            placeholder={telegram.hasToken ? tr('•••••••• (đã lưu)') : '123456789:ABC…'}
            onChange={(e) => setBotToken(e.target.value)}
          />
        </Field>
        <Field label="Chat ID" hint={tr('Nhắn /start cho bot trước. Có thể là số (nhóm bắt đầu bằng -100) hoặc @tenkenh.')}>
          <input className={inputCls} value={chatId} placeholder="123456789" onChange={(e) => setChatId(e.target.value)} />
        </Field>
      </div>
      <Field label={tr('Địa chỉ giao diện (dùng cho liên kết mở task)')} hint={tr('Để trống sẽ dùng địa chỉ bạn đang mở.')}>
        <input className={inputCls} value={appUrl} placeholder={location.origin} onChange={(e) => setAppUrl(e.target.value)} />
      </Field>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!!busy} onClick={() => run('save')}>
          {busy === 'save' ? tr('Đang lưu…') : tr('Lưu Telegram')}
        </Button>
        <Button size="sm" disabled={!!busy || (!botToken.trim() && !telegram.hasToken) || !chatId.trim()} onClick={() => run('test')}>
          {busy === 'test' ? tr('Đang gửi…') : tr('Gửi thử')}
        </Button>
        {telegram.hasToken && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('clear')}>
            {tr('Xoá token')}
          </Button>
        )}
      </div>
    </div>
  )
}

const AUTH_OPTIONS: { value: ClaudeAuthMode; label: string; hint: string }[] = [
  {
    value: 'subscription',
    label: tr('Đăng nhập Claude Code (gói Pro/Max)'),
    hint: tr('Dùng phiên đăng nhập Claude Code trên máy này. Chi phí nằm trong gói, có hạn mức theo 5 giờ và theo tuần. Chỉ dành cho cá nhân tự dùng, không dùng để phục vụ người khác.'),
  },
  {
    value: 'apiKey',
    label: tr('API key (trả theo token)'),
    hint: tr('Tính tiền theo token vào tài khoản Claude Console, riêng với gói Pro/Max. Budget tháng của project trở thành giới hạn cứng: hết budget là dừng. Key sai sẽ báo lỗi ở lần chạy task đầu tiên. Vẫn cần Claude Code CLI trên máy (không cần đăng nhập).'),
  },
]

/** Xác thực Claude: chọn chế độ, nhập API key. Key chỉ gửi lên, không bao giờ đọc lại từ backend. */
function ClaudeAuthSettings() {
  const { auth } = useStore().settings
  const [mode, setMode] = useState<ClaudeAuthMode>(auth.mode)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setMode(auth.mode), [auth.mode])

  const hasKey = auth.hasApiKey || auth.envApiKey
  const missingKey = mode === 'apiKey' && !apiKey.trim() && !hasKey
  const dirty = mode !== auth.mode || !!apiKey.trim()

  async function run(kind: 'save' | 'clear') {
    setBusy(kind)
    setError(null)
    const err =
      kind === 'clear' ? await saveClaudeAuth({ apiKey: null }) : await saveClaudeAuth({ mode, apiKey: apiKey.trim() || undefined })
    setBusy(null)
    if (err) return setError(err)
    setApiKey('')
    toast({
      kind: 'success',
      title: kind === 'clear' ? tr('Đã xoá API key đã lưu') : tr('Đã lưu cài đặt xác thực'),
    })
  }

  const keyHint = auth.envApiKey
    ? tr('Đang dùng key từ biến môi trường TASKBOARD_ANTHROPIC_API_KEY (…{hint}). Key lưu ở đây chỉ dùng khi bỏ biến này.', { hint: auth.apiKeyHint ?? '' })
    : auth.hasApiKey
      ? tr('Đã lưu key …{hint} (mã hoá). Để trống để giữ nguyên, nhập để thay.', { hint: auth.apiKeyHint ?? '' })
      : tr('Tạo key trong Claude Console → API keys.')

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {AUTH_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-3">
            <input type="radio" name="claude-auth-mode" className="mt-1" checked={mode === o.value} onChange={() => setMode(o.value)} />
            <span className="text-sm">
              {o.label}
              <span className="block text-xs text-slate-500">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {mode === 'apiKey' && (
        <>
          <Field label="API key" hint={keyHint}>
            <input
              type="password"
              autoComplete="off"
              className={inputCls}
              value={apiKey}
              placeholder={hasKey ? tr('•••• {hint} (đã có)', { hint: auth.apiKeyHint ?? '' }) : 'sk-ant-…'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
          <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {tr('Chi phí là tiền thật. Nên đặt budget tháng cho từng project và đặt giới hạn chi tiêu (spend limit) trong Claude Console.')}{' '}
            {tr('Số tiền Task Board hiển thị tính theo giá niêm yết, có thể lệch nhẹ so với hoá đơn.')}
          </p>
        </>
      )}
      {missingKey && <p className="text-xs text-rose-600">{tr('Chế độ API key cần có key trước khi lưu.')}</p>}
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!!busy || missingKey || !dirty} onClick={() => run('save')}>
          {busy === 'save' ? tr('Đang lưu…') : tr('Lưu xác thực')}
        </Button>
        {auth.hasApiKey && (
          <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run('clear')}>
            {tr('Xoá key đã lưu')}
          </Button>
        )}
      </div>
    </div>
  )
}

export function Settings() {
  const { settings } = useStore()
  const [health, setHealth] = useState<{ claude: { found: boolean; version?: string; source?: string; path?: string } } | null>(null)
  useEffect(() => {
    if (IS_MOCK) return
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => {})
  }, [])
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )

  async function enableBrowser(on: boolean) {
    if (on && perm !== 'granted' && perm !== 'unsupported') {
      const r = await Notification.requestPermission()
      setPerm(r)
      if (r !== 'granted') {
        toast({ kind: 'warning', title: tr('Trình duyệt chưa cho phép thông báo') })
        return
      }
    }
    updateSettings({ browserNotifications: on })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">{tr('Cài đặt')}</h1>

      <Section icon={<Languages size={18} />} title={tr('Ngôn ngữ')}>
        <Field label={'Language / Ng\u00f4n ng\u1eef'} hint={tr('Ngôn ngữ giao diện. Trong VS Code, mặc định theo ngôn ngữ của VS Code.')}>
          <select className={inputCls} value={LANG} onChange={(e) => setLang(e.target.value as Lang)}>
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section icon={<Cpu size={18} />} title={tr('Thực thi')}>
        <Field label={tr('Số task chạy song song tối đa (toàn hệ thống)')} hint={tr('Task ở Needs Input vẫn chiếm slot. Nên để 2 để tránh vượt giới hạn sử dụng của gói Claude.')}>
          <input
            type="number"
            min={1}
            max={5}
            className={`${inputCls} w-32`}
            value={settings.maxParallel}
            onChange={(e) => updateSettings({ maxParallel: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
        <Field label={tr('Agent mặc định')} hint={tr('Dùng khi task và project đều không chọn agent. Mỗi agent dùng phiên đăng nhập CLI riêng trên máy.')}>
          <AgentSelect className={`${inputCls} w-64`} value={settings.defaultAgent} onChange={(v) => v && updateSettings({ defaultAgent: v })} />
        </Field>
        <AgentStatusList />
        <div className="space-y-2">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.failover.enabled}
              onChange={(e) => updateSettings({ failover: { ...settings.failover, enabled: e.target.checked } })}
            />
            <span className="text-sm">
              {tr('Tự chuyển agent khi agent đang dùng hết hạn mức')}
              <span className="block text-xs text-slate-500">
                {tr('Task chạy tiếp bằng agent kế tiếp trong chuỗi (đã cài, còn lượt, hỗ trợ mức quyền của task) thay vì chờ giờ reset. Yêu cầu sửa giữ agent dự phòng; Chạy lại quay về agent gốc. Project có thể dùng chuỗi riêng hoặc tắt.')}
              </span>
            </span>
          </label>
          {settings.failover.enabled && (
            <div className="pl-7">
              <ChainEditor
                value={settings.failover.chain}
                onChange={(chain) => chain.length >= 2 && updateSettings({ failover: { ...settings.failover, chain } })}
              />
            </div>
          )}
        </div>
        <Field label={tr('Model mặc định')} hint={tr('Dùng khi task và project đều không chọn model. Run sửa theo review / tiếp tục giữ model của lần chạy trước.')}>
          <select className={`${inputCls} w-64`} value={settings.defaultModel} onChange={(e) => updateSettings({ defaultModel: e.target.value })}>
            <option value="">{tr('Mặc định của Claude CLI')}</option>
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {settings.defaultModel && !MODEL_OPTIONS.some((o) => o.value === settings.defaultModel) && (
              <option value={settings.defaultModel}>{settings.defaultModel}</option>
            )}
          </select>
        </Field>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={settings.autoEscalate ?? true} onChange={(e) => updateSettings({ autoEscalate: e.target.checked })} />
          <span className="text-sm">
            {tr('Tự nâng model khi task thất bại')}
            <span className="block text-xs text-slate-500">
              {tr('Retry sau lần chạy lỗi, hoặc Yêu cầu sửa từ lần thứ 2, sẽ lên một bậc (Haiku → Sonnet → Opus). Không áp dụng cho model chọn tay.')}
            </span>
          </span>
        </label>
      </Section>

      <Section icon={<KeyRound size={18} />} title={tr('Xác thực Claude')}>
        <ClaudeAuthSettings />
      </Section>

      <Section icon={<Timer size={18} />} title={tr('Xin quyền (Needs Input)')}>
        <Field label={tr('Tự động từ chối sau (phút)')} hint={tr('Nếu bạn không phản hồi, quyền bị từ chối và Claude tiếp tục theo hướng khác.')}>
          <input
            type="number"
            min={1}
            max={240}
            className={`${inputCls} w-32`}
            value={settings.permissionTimeoutMin}
            onChange={(e) => updateSettings({ permissionTimeoutMin: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      </Section>

      <Section icon={<Bell size={18} />} title={tr('Thông báo')}>
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={settings.browserNotifications} onChange={(e) => enableBrowser(e.target.checked)} />
          <span className="text-sm">
            {tr('Thông báo của trình duyệt (kể cả khi đang ở tab khác)')}
            <span className="block text-xs text-slate-500">
              {tr('Quyền hiện tại:')}{' '}
              {perm === 'granted' ? tr('đã cho phép') : perm === 'denied' ? tr('bị chặn, hãy mở lại trong cài đặt trình duyệt') : perm === 'unsupported' ? tr('không hỗ trợ') : tr('chưa hỏi')}
            </span>
          </span>
        </label>
        <div>
          <p className="mb-2 text-sm font-medium">{tr('Thông báo khi task chuyển sang')}</p>
          <div className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ['review', 'Review'],
                ['needsInput', 'Needs Input'],
                ['failed', 'Failed'],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="inline-flex items-center gap-2">
                <input type="checkbox" checked={settings.notifyOn[k]} onChange={(e) => updateSettings({ notifyOn: { ...settings.notifyOn, [k]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </div>
        </div>
        <Button size="sm" onClick={() => notify({ kind: 'info', title: tr('Thông báo thử'), body: tr('Bạn sẽ nhận thông báo như thế này') }, { force: true })}>
          {tr('Gửi thông báo thử')}
        </Button>
        <TelegramSettings />
      </Section>

      <Section icon={<FileText size={18} />} title={tr('Template prompt')}>
        <TemplateManager />
      </Section>

      <Section icon={<CalendarClock size={18} />} title={tr('Lên lịch task (cron)')}>
        <ScheduleManager />
      </Section>

      <Section icon={<Info size={18} />} title={tr('Hệ thống')}>
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Claude Code CLI</dt>
          <dd className="break-all font-mono text-xs">
            {IS_MOCK
              ? tr('(bản giả lập: chưa kết nối)')
              : !health
                ? tr('Đang kiểm tra…')
                : health.claude.found
                  ? `${health.claude.version} · ${health.claude.source === 'vscode-extension' ? tr('từ extension VSCode') : health.claude.source} · ${health.claude.path}`
                  : tr('⚠ Không tìm thấy. Cài extension Claude Code, hoặc đặt đường dẫn CLI (CLAUDE_BIN) rồi khởi động lại.')}
          </dd>
          <dt className="text-slate-500">{tr('Xác thực')}</dt>
          <dd>
            {settings.auth.mode === 'apiKey'
              ? `API key …${settings.auth.apiKeyHint ?? tr('(chưa có)')}${settings.auth.envApiKey ? ` · ${tr('từ biến môi trường')}` : ''}`
              : tr('Phiên đăng nhập Claude Code trên máy (gói Pro/Max)')}
          </dd>
          <dt className="text-slate-500">Backend</dt>
          <dd className="font-mono text-xs">{IS_MOCK ? tr('(bản giả lập)') : health ? `${location.host} · online` : '…'}</dd>
        </dl>
      </Section>
    </div>
  )
}
