import { Fragment, type ReactNode } from 'react'

/**
 * Renderer Markdown gọn nhẹ cho output của Claude (summary, kết quả).
 * Hỗ trợ: heading, đoạn văn, danh sách (lồng theo thụt lề), code block, blockquote,
 * bảng GFM, đường kẻ ngang; inline: `code`, **đậm**, *nghiêng*, ~~gạch~~, [link](url).
 * Không dùng dangerouslySetInnerHTML, nên an toàn với nội dung bất kỳ.
 */

type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; text: string }
  | { t: 'hr' }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: string[]; align: ('left' | 'center' | 'right' | undefined)[]; rows: string[][] }

type ListItem = { text: string; children: Block[] }

const RE_FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/
const RE_HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RE_HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/
const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))

const isBlockStart = (line: string) =>
  RE_FENCE.test(line) || RE_HEADING.test(line) || RE_HR.test(line) || RE_LIST.test(line) || RE_QUOTE.test(line)

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      i++
      continue
    }

    const fence = line.match(RE_FENCE)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++])
      i++
      blocks.push({ t: 'code', lang: fence[2], text: body.join('\n') })
      continue
    }

    const h = line.match(RE_HEADING)
    if (h) {
      blocks.push({ t: 'h', level: h[1].length, text: h[2] })
      i++
      continue
    }

    if (RE_HR.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined,
      )
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]))
      blocks.push({ t: 'table', head, align, rows })
      continue
    }

    if (RE_QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && RE_QUOTE.test(lines[i])) body.push(lines[i++].match(RE_QUOTE)![1])
      blocks.push({ t: 'quote', text: body.join('\n') })
      continue
    }

    const li = line.match(RE_LIST)
    if (li) {
      // Gom toàn bộ khối danh sách (kể cả dòng thụt lề / dòng nối tiếp) rồi parse đệ quy.
      const baseIndent = li[1].length
      const ordered = /\d/.test(li[2])
      const items: { first: string; rest: string[] }[] = []
      while (i < lines.length) {
        const l = lines[i]
        const m = l.match(RE_LIST)
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          items.push({ first: m[3], rest: [] })
          i++
        } else if (l.trim() && (/^\s/.test(l) || !isBlockStart(l)) && items.length) {
          items[items.length - 1].rest.push(l.slice(Math.min(baseIndent + 2, l.search(/\S/))))
          i++
        } else if (!l.trim() && i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && items.length) {
          items[items.length - 1].rest.push('')
          i++
        } else break
      }
      blocks.push({
        t: 'list',
        ordered,
        start: ordered ? parseInt(li[2], 10) : 1,
        items: items.map(({ first, rest }) => {
          const nestedAt = rest.findIndex((r) => isBlockStart(r))
          const cont = nestedAt === -1 ? rest : rest.slice(0, nestedAt)
          const nested = nestedAt === -1 ? [] : rest.slice(nestedAt)
          return { text: [first, ...cont.filter((c) => c.trim())].join(' '), children: parse(nested.join('\n')) }
        }),
      })
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim())
    if (para.length === 0) para.push(lines[i++].trim())
    blocks.push({ t: 'p', text: para.join('\n') })
  }
  return blocks
}

const RE_INLINE = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\n/g

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let k = 0
  for (const m of text.matchAll(RE_INLINE)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    last = idx + m[0].length
    const key = k++
    if (m[2] !== undefined)
      out.push(
        <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.85em] text-rose-700 dark:bg-slate-800 dark:text-rose-300">
          {m[2].trim()}
        </code>,
      )
    else if (m[3] !== undefined || m[4] !== undefined)
      out.push(<strong key={key} className="font-semibold text-slate-900 dark:text-slate-100">{inline(m[3] ?? m[4])}</strong>)
    else if (m[5] !== undefined) out.push(<del key={key}>{inline(m[5])}</del>)
    else if (m[6] !== undefined || m[7] !== undefined) out.push(<em key={key}>{inline(m[6] ?? m[7])}</em>)
    else if (m[8] !== undefined || m[10] !== undefined) {
      const href = m[9] ?? m[10]
      const safe = /^(https?:|mailto:|#|\/)/i.test(href)
      out.push(
        safe ? (
          <a key={key} href={href} target="_blank" rel="noreferrer" className="text-indigo-600 underline underline-offset-2 hover:text-indigo-500 dark:text-indigo-400">
            {m[8] !== undefined ? inline(m[8]) : href}
          </a>
        ) : (
          <Fragment key={key}>{m[8] ?? href}</Fragment>
        ),
      )
    } else out.push(<br key={key} />)
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const H_CLASS = [
  'text-base font-semibold',
  'text-[0.95rem] font-semibold',
  'text-sm font-semibold',
  'text-sm font-semibold text-slate-700 dark:text-slate-300',
]

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'h': {
        const Tag = `h${Math.min(b.level + 2, 6)}` as 'h3'
        return (
          <Tag key={i} className={`${H_CLASS[Math.min(b.level, 4) - 1]} mt-4 first:mt-0 text-slate-900 dark:text-slate-100`}>
            {inline(b.text)}
          </Tag>
        )
      }
      case 'p':
        return <p key={i}>{inline(b.text)}</p>
      case 'code':
        return (
          <pre key={i} className="overflow-x-auto rounded-md bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100 dark:bg-black/40">
            <code>{b.text}</code>
          </pre>
        )
      case 'quote':
        return (
          <blockquote key={i} className="space-y-2 border-l-4 border-slate-300 pl-3 text-slate-600 dark:border-slate-600 dark:text-slate-400">
            {renderBlocks(parse(b.text))}
          </blockquote>
        )
      case 'hr':
        return <hr key={i} className="border-slate-200 dark:border-slate-700" />
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul'
        return (
          <Tag
            key={i}
            start={b.ordered && b.start !== 1 ? b.start : undefined}
            className={`space-y-1 pl-5 marker:text-slate-400 ${b.ordered ? 'list-decimal' : 'list-disc'}`}
          >
            {b.items.map((it, j) => {
              const task = it.text.match(/^\[([ xX])\]\s+(.*)$/s)
              return (
                <li key={j} className={`pl-1 ${task ? 'list-none -ml-5' : ''}`}>
                  {task ? (
                    <span className="flex items-start gap-2">
                      <input type="checkbox" checked={task[1] !== ' '} readOnly className="mt-1 accent-emerald-600" />
                      <span>{inline(task[2])}</span>
                    </span>
                  ) : (
                    inline(it.text)
                  )}
                  {it.children.length > 0 && <div className="mt-1 space-y-1">{renderBlocks(it.children)}</div>}
                </li>
              )
            })}
          </Tag>
        )
      }
      case 'table':
        return (
          <div key={i} className="overflow-x-auto rounded-md border border-slate-200 dark:border-slate-700">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-800/60">
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={{ textAlign: b.align[j] }} className="border-b border-slate-200 px-3 py-2 font-semibold dark:border-slate-700">
                      {inline(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    {b.head.map((_, c) => (
                      <td key={c} style={{ textAlign: b.align[c] }} className="px-3 py-1.5 align-top">
                        {inline(r[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
    }
  })
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`space-y-2.5 break-words text-sm leading-relaxed text-slate-700 dark:text-slate-300 ${className}`}>
      {renderBlocks(parse(text))}
    </div>
  )
}

/** Bỏ cú pháp Markdown để hiển thị 1 dòng xem trước (vd. Inbox). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(', '))
    .replace(/\s*\|\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
}
