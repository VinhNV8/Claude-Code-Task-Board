import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags, splitTags, suggestTags } from '../lib/taskFilter'

/** Ô nhập tag dạng chip, gợi ý từ các tag đã dùng (FR-07). Enter hoặc dấu phẩy để thêm. */
export function TagInput({
  label,
  value,
  onChange,
  suggestions,
  placeholder = 'bug, ui',
}: {
  label: string
  value: string[]
  onChange: (tags: string[]) => void
  suggestions: string[]
  placeholder?: string
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [hi, setHi] = useState(-1)

  const list = suggestTags(suggestions, value, text)
  const showList = focused && list.length > 0
  const full = value.length >= MAX_TAGS

  function add(raw: string[]) {
    const next = normalizeTags([...value, ...raw.map((t) => t.slice(0, MAX_TAG_LENGTH))]).slice(0, MAX_TAGS)
    onChange(next)
    setText('')
    setHi(-1)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' && showList) {
      e.preventDefault()
      setHi((h) => (h + 1) % list.length)
    } else if (e.key === 'ArrowUp' && showList) {
      e.preventDefault()
      setHi((h) => (h <= 0 ? list.length - 1 : h - 1))
    } else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim())) {
      // Enter chọn gợi ý đang sáng (sau khi dùng phím mũi tên); nếu không thì thêm chữ đã gõ
      const pick = e.key === 'Enter' && showList && hi >= 0 ? list[hi] : undefined
      if (!pick && !text.trim()) {
        if (e.key !== 'Tab') e.preventDefault() // tránh submit form / gõ dấu phẩy thừa
        return
      }
      e.preventDefault()
      add(pick ? [pick] : splitTags(text))
    } else if (e.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape' && showList) {
      // Đóng gợi ý, không đóng modal
      e.stopPropagation()
      setFocused(false)
    }
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700 dark:text-slate-200">
        {label}
      </label>
      <div className="relative">
        <div
          className="flex min-h-[38px] w-full flex-wrap items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-950"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault()
              inputRef.current?.focus()
            }
          }}
        >
          {value.map((t) => (
            <span key={t} className="inline-flex items-center gap-0.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {t}
              <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-slate-400 hover:text-slate-700 dark:hover:text-white" aria-label={`Bỏ tag ${t}`}>
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            id={id}
            ref={inputRef}
            className="min-w-[80px] flex-1 bg-transparent py-1 outline-none"
            value={text}
            disabled={full}
            placeholder={full ? `Tối đa ${MAX_TAGS} tag` : value.length ? '' : placeholder}
            maxLength={MAX_TAG_LENGTH * 4}
            onChange={(e) => {
              const v = e.target.value
              // Dán "a, b, c" thì tách luôn thành tag
              if (v.includes(',')) {
                const parts = v.split(',')
                const rest = parts.pop() ?? ''
                add(parts)
                setText(rest)
              } else {
                setText(v)
                setHi(-1)
                setFocused(true)
              }
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false)
              if (text.trim()) add(splitTags(text))
            }}
            role="combobox"
            aria-expanded={showList}
            aria-autocomplete="list"
          />
        </div>
        {showList && (
          <ul
            role="listbox"
            className="absolute left-0 right-0 z-10 mt-1 max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900"
          >
            {list.map((t, i) => (
              <li
                key={t}
                role="option"
                aria-selected={i === hi}
                onMouseDown={(e) => {
                  e.preventDefault()
                  add([t])
                }}
                onMouseEnter={() => setHi(i)}
                className={`cursor-pointer px-3 py-1 ${i === hi ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-700 dark:text-slate-200'}`}
              >
                {t}
              </li>
            ))}
          </ul>
        )}
      </div>
      <span className="block text-xs text-slate-500 dark:text-slate-400">Enter hoặc dấu phẩy để thêm, chọn từ gợi ý các tag đã dùng</span>
    </div>
  )
}
