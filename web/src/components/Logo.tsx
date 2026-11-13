import { useId } from 'react'

// Logo Claude Workspace: ba cột (bảng công việc) + tia sáng (AI). Giữ đồng bộ với web/public/logo.svg.
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId()
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label="Claude Workspace" data-testid="logo">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${id})`} />
      <rect x="14" y="30" width="8" height="20" rx="2.5" fill="#fff" fillOpacity=".72" />
      <rect x="28" y="20" width="8" height="30" rx="2.5" fill="#fff" />
      <rect x="42" y="36" width="8" height="14" rx="2.5" fill="#fff" fillOpacity=".72" />
      <path d="M46 8c.9 4.6 2.4 6.1 7 7-4.6.9-6.1 2.4-7 7-.9-4.6-2.4-6.1-7-7 4.6-.9 6.1-2.4 7-7z" fill="#fde68a" />
    </svg>
  )
}
