import { Fragment, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A small markdown renderer that emits REACT ELEMENTS, never HTML.
 *
 * No dependency, and — more importantly — no `dangerouslySetInnerHTML`
 * anywhere, so nothing typed into a library article can inject markup into the
 * app. The content is written by founder/PM, but "the authors are trusted" is a
 * policy that outlives nobody's memory; not having the hole is better than
 * relying on who has the password.
 *
 * Supports what reference writing actually needs: headings, bold, italic,
 * inline code, bullet and numbered lists, block quotes, horizontal rules and
 * links. Anything else renders as its own literal text rather than vanishing —
 * a renderer that silently swallows what it does not understand loses content.
 */
export function Markdown({
  source,
  className,
}: {
  source: string | null
  className?: string
}) {
  if (!source || source.trim() === '') return null

  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []
  let key = 0

  const flushPara = () => {
    if (para.length === 0) return
    blocks.push(
      <p key={key++} className="text-sm leading-relaxed">
        {inline(para.join(' '))}
      </p>,
    )
    para = []
  }

  const flushList = () => {
    if (!list) return
    const items = list.items.map((t, i) => (
      <li key={i} className="text-sm leading-relaxed">
        {inline(t)}
      </li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={key++} className="ml-5 list-decimal space-y-1.5">
          {items}
        </ol>
      ) : (
        <ul key={key++} className="ml-5 list-disc space-y-1.5">
          {items}
        </ul>
      ),
    )
    list = null
  }

  const flushQuote = () => {
    if (quote.length === 0) return
    blocks.push(
      <blockquote
        key={key++}
        className="border-l-2 border-[var(--accent)] pl-3 text-sm leading-relaxed text-muted-foreground italic"
      >
        {inline(quote.join(' '))}
      </blockquote>,
    )
    quote = []
  }

  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (line.trim() === '') {
      flushAll()
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll()
      blocks.push(<hr key={key++} className="border-border" />)
      continue
    }

    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushAll()
      const level = h[1].length
      const text = inline(h[2])
      const size =
        level === 1
          ? 'font-heading text-lg font-semibold'
          : level === 2
            ? 'font-heading text-base font-semibold'
            : 'text-sm font-semibold'
      blocks.push(
        <p key={key++} className={cn('mt-1', size)}>
          {text}
        </p>,
      )
      continue
    }

    // Block quote
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      flushPara()
      flushList()
      quote.push(q[1])
      continue
    }

    // Lists
    const ul = /^[-*+]\s+(.*)$/.exec(line.trim())
    const ol = /^(\d+)[.)]\s+(.*)$/.exec(line.trim())
    if (ul || ol) {
      flushPara()
      flushQuote()
      const ordered = Boolean(ol)
      const text = (ul ? ul[1] : ol ? ol[2] : '') as string
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push(text)
      continue
    }

    flushList()
    flushQuote()
    para.push(line.trim())
  }
  flushAll()

  return <div className={cn('space-y-3', className)}>{blocks}</div>
}

/**
 * Inline formatting. Order matters: code first, so `**not bold**` inside
 * backticks stays literal.
 */
function inline(text: string): ReactNode {
  const out: ReactNode[] = []
  // Split on the inline constructs, keeping the delimiters.
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>)
    const tok = m[0]

    if (tok.startsWith('`')) {
      out.push(
        <code
          key={k++}
          className="rounded bg-secondary px-1 py-0.5 font-mono text-[0.85em]"
        >
          {tok.slice(1, -1)}
        </code>,
      )
    } else if (tok.startsWith('**')) {
      out.push(
        <strong key={k++} className="font-semibold">
          {tok.slice(2, -2)}
        </strong>,
      )
    } else if (tok.startsWith('*')) {
      out.push(<em key={k++}>{tok.slice(1, -1)}</em>)
    } else {
      // [label](https://…) — the scheme is fixed by the pattern above, so a
      // javascript: URL cannot get here.
      const cut = tok.indexOf('](')
      const label = tok.slice(1, cut)
      const href = tok.slice(cut + 2, -1)
      out.push(
        <a
          key={k++}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--accent)] underline underline-offset-2"
        >
          {label}
        </a>,
      )
    }
    last = m.index + tok.length
  }

  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>)
  return out
}
