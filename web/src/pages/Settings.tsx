import { useEffect, useState } from 'react'
import { Bell, Cpu, Info, Timer } from 'lucide-react'
import { IS_MOCK, toast, updateSettings, useStore } from '../store/store'
import { Button, Field, inputCls } from '../components/ui'

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
        toast({ kind: 'warning', title: 'Trình duyệt chưa cho phép thông báo' })
        return
      }
    }
    updateSettings({ browserNotifications: on })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-lg font-semibold">Cài đặt</h1>

      <Section icon={<Cpu size={18} />} title="Thực thi">
        <Field label="Số task chạy song song tối đa (toàn hệ thống)" hint="Task ở Needs Input vẫn chiếm slot. Nên để 2 để tránh vượt giới hạn sử dụng của gói Claude.">
          <input
            type="number"
            min={1}
            max={5}
            className={`${inputCls} w-32`}
            value={settings.maxParallel}
            onChange={(e) => updateSettings({ maxParallel: Math.max(1, Number(e.target.value) || 1) })}
          />
        </Field>
      </Section>

      <Section icon={<Timer size={18} />} title="Xin quyền (Needs Input)">
        <Field label="Tự động từ chối sau (phút)" hint="Nếu bạn không phản hồi, quyền bị từ chối và Claude tiếp tục theo hướng khác.">
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

      <Section icon={<Bell size={18} />} title="Thông báo">
        <label className="flex items-center gap-3">
          <input type="checkbox" checked={settings.browserNotifications} onChange={(e) => enableBrowser(e.target.checked)} />
          <span className="text-sm">
            Thông báo của trình duyệt (kể cả khi đang ở tab khác)
            <span className="block text-xs text-slate-500">
              Quyền hiện tại: {perm === 'granted' ? 'đã cho phép' : perm === 'denied' ? 'bị chặn, hãy mở lại trong cài đặt trình duyệt' : perm === 'unsupported' ? 'không hỗ trợ' : 'chưa hỏi'}
            </span>
          </span>
        </label>
        <div>
          <p className="mb-2 text-sm font-medium">Thông báo khi task chuyển sang</p>
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
        <Button size="sm" onClick={() => toast({ kind: 'info', title: 'Thông báo thử', body: 'Bạn sẽ nhận thông báo như thế này' })}>
          Gửi thông báo thử
        </Button>
      </Section>

      <Section icon={<Info size={18} />} title="Hệ thống">
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Claude Code CLI</dt>
          <dd className="break-all font-mono text-xs">
            {IS_MOCK
              ? '(bản giả lập: chưa kết nối)'
              : !health
                ? 'Đang kiểm tra…'
                : health.claude.found
                  ? `${health.claude.version} · ${health.claude.source === 'vscode-extension' ? 'từ extension VSCode' : health.claude.source} · ${health.claude.path}`
                  : '⚠ Không tìm thấy. Đặt biến môi trường CLAUDE_BIN rồi khởi động lại.'}
          </dd>
          <dt className="text-slate-500">Xác thực</dt>
          <dd>Dùng phiên đăng nhập Claude Code trên máy, không dùng API key</dd>
          <dt className="text-slate-500">Backend</dt>
          <dd className="font-mono text-xs">{IS_MOCK ? '(bản giả lập)' : health ? `${location.host} · online` : '…'}</dd>
        </dl>
      </Section>
    </div>
  )
}
