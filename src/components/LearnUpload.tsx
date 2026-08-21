import { FileUp, Loader2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { FieldRow, Select, Textarea } from '@/components/Field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { errText } from '@/lib/errText'
import { extractText, type ExtractResult } from '@/lib/pdfText'
import { uploadLearnDocument } from '@/lib/queries/learn'
import type { LearnCategory } from '@/lib/types'

const splitList = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)

interface Props {
  /** Set when filing an attachment on an article; null for a standalone upload. */
  articleId?: string | null
  /** Shelves, for a standalone upload. Ignored when articleId is set. */
  categories?: LearnCategory[]
  /** Pre-selected shelf. */
  defaultCategory?: string | null
  onDone: () => void
  onCancel: () => void
}

/**
 * Filing a document into the library.
 *
 * The text is extracted BEFORE the upload, in this component, so that what the
 * screen says about searchability is a fact rather than a promise: by the time
 * the row exists, we already know whether anything can be found inside it. A
 * scanned PDF says so on the spot, while the person who has the file in front
 * of them can still decide to find a better copy.
 */
export function LearnUpload({
  articleId = null,
  categories = [],
  defaultCategory = null,
  onDone,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [extract, setExtract] = useState<ExtractResult | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [refNo, setRefNo] = useState('')
  const [isRefs, setIsRefs] = useState('')
  const [tags, setTags] = useState('')
  const [category, setCategory] = useState(
    defaultCategory ?? categories[0]?.code ?? '',
  )

  async function pick(f: File | null) {
    setFile(f)
    setExtract(null)
    if (!f) return

    // Title defaults to the filename without its extension. It is a starting
    // point, not a decision — "IS456-2000.pdf" is a worse shelf label than
    // anything a person would type, but it beats an empty box.
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ''))

    setReading(true)
    // extractText never throws: a file we cannot parse must still be filable.
    setExtract(await extractText(f))
    setReading(false)
  }

  async function save() {
    if (!file) {
      toast.error('Choose a file first')
      return
    }
    if (!articleId && !category) {
      toast.error('Pick a shelf for it')
      return
    }

    setBusy(true)
    try {
      await uploadLearnDocument(
        file,
        {
          article_id: articleId,
          category_code: articleId ? null : category,
          title,
          description,
          ref_no: refNo,
          is_refs: splitList(isRefs),
          trades: [],
          tags: splitList(tags),
        },
        extract ?? {
          text: '',
          pageCount: null,
          status: 'pending',
          note: null,
        },
      )

      toast.success('Filed', {
        description:
          extract?.status === 'ok'
            ? 'Its contents are searchable.'
            : 'The file is stored. Its contents are not searchable.',
      })
      onDone()
    } catch (err) {
      const msg = errText(err) ?? ''
      toast.error('Could not file it', {
        description: msg.includes('learn_doc_path_uk')
          ? 'That file has already been uploaded.'
          : msg,
      })
      setBusy(false)
    }
  }

  return (
    <section className="paper space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="font-heading text-[15px] font-semibold">
          {articleId ? 'Attach a document' : 'Add a document'}
        </p>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".pdf,.txt,.md,.csv,.docx,.xlsx,.dwg,image/*"
        onChange={(e) => void pick(e.target.files?.[0] ?? null)}
      />

      <Button
        type="button"
        variant="outline"
        className="h-12 w-full justify-start gap-2 text-base"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
      >
        <FileUp className="size-4" />
        {file ? file.name : 'Choose a file'}
      </Button>

      {/* What the library will and won't be able to find inside it, said before
          anything is saved rather than discovered later in a search that
          returns nothing. */}
      {reading && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Reading the text out of it…
        </p>
      )}

      {extract && !reading && (
        <div
          className={
            extract.status === 'ok'
              ? 'rounded-lg bg-[color-mix(in_oklab,var(--positive)_10%,transparent)] px-3 py-2 text-xs text-[var(--positive)]'
              : 'rounded-lg bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-3 py-2 text-xs text-[var(--warning)]'
          }
        >
          {extract.status === 'ok' ? (
            <>
              Searchable — {extract.text.length.toLocaleString('en-IN')}{' '}
              characters read
              {extract.pageCount ? ` from ${extract.pageCount} pages` : ''}.
              {extract.note ? ` ${extract.note}` : ''}
            </>
          ) : (
            extract.note
          )}
        </div>
      )}

      {!articleId && categories.length > 0 && (
        <FieldRow label="Shelf" htmlFor="d_shelf">
          <Select
            id="d_shelf"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </FieldRow>
      )}

      <FieldRow label="Title" htmlFor="d_title">
        <Input
          id="d_title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What this document is"
          className="h-12 text-base"
        />
      </FieldRow>

      <FieldRow label="What it covers" htmlFor="d_desc">
        <Textarea
          id="d_desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A line so somebody can tell whether to open it"
          rows={2}
        />
      </FieldRow>

      <div className="grid grid-cols-2 gap-2">
        <FieldRow label="Our reference" htmlFor="d_ref">
          <Input
            id="d_ref"
            value={refNo}
            onChange={(e) => setRefNo(e.target.value)}
            placeholder="DOC-012"
            className="h-12 text-base"
          />
        </FieldRow>
        <FieldRow label="Standards cited" htmlFor="d_isrefs">
          <Input
            id="d_isrefs"
            value={isRefs}
            onChange={(e) => setIsRefs(e.target.value)}
            placeholder="IS 456, IS 1200"
            className="h-12 text-base"
          />
        </FieldRow>
      </div>

      <FieldRow label="Tags" htmlFor="d_tags">
        <Input
          id="d_tags"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="concrete, waterproofing"
          className="h-12 text-base"
        />
      </FieldRow>

      <p className="text-[11px] text-muted-foreground">
        Uploaded byte for byte — nothing is re-compressed, so a scanned spec
        sheet stays legible. Everything is filed as a draft until you publish it.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="ghost" className="h-11" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button className="h-11" onClick={() => void save()} disabled={busy || reading}>
          {busy ? 'Filing…' : 'File it'}
        </Button>
      </div>
    </section>
  )
}
