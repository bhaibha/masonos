import { Info, Layers, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Select } from '@/components/Field'
import { Skeleton } from '@/components/Skeleton'
import { Button } from '@/components/ui/button'
import { signedDrawingUrl } from '@/lib/storage'

interface Sheet {
  id: string
  label: string
  filePath: string | null
  discipline: string
}

/**
 * Two drawing sheets laid over each other with an opacity slider.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * It is a LOOKING AID. Two images, exported at whatever scale and crop they
 * happened to have, stacked so the eye can spot "that duct runs straight
 * through that beam". It is the digital version of holding two prints up to a
 * window, which is how this has always been done.
 *
 * It is NOT a geometric check. The two sheets are not registered to a common
 * origin, not scaled to each other, and not dimensionally related in any way.
 * It cannot prove a clearance and it cannot prove the absence of a clash. The
 * caption says so on screen, permanently and not behind a tooltip — a tool that
 * looks like Navisworks and is not is worse than no tool, because somebody will
 * trust it.
 *
 * Nudge and scale controls are provided precisely BECAUSE alignment is manual:
 * pretending the sheets line up automatically would be the lie. Whatever the
 * user lands on is their alignment, by eye, and they know it.
 *
 * PDFs are not rendered. A drawing sheet uploaded as a PDF opens in its own tab
 * instead — rendering it here would mean pulling pdf.js onto this screen for a
 * feature that works on the image exports people actually mark up.
 */
export function DrawingOverlay({
  sheets,
  onClose,
}: {
  sheets: Sheet[]
  onClose: () => void
}) {
  const withFiles = sheets.filter((s) => s.filePath)

  const [aId, setAId] = useState(withFiles[0]?.id ?? '')
  const [bId, setBId] = useState(withFiles[1]?.id ?? '')
  const [aUrl, setAUrl] = useState<string | null>(null)
  const [bUrl, setBUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [opacity, setOpacity] = useState(50)
  const [dx, setDx] = useState(0)
  const [dy, setDy] = useState(0)
  const [scale, setScale] = useState(100)

  const load = useCallback(async () => {
    const a = withFiles.find((s) => s.id === aId)
    const b = withFiles.find((s) => s.id === bId)
    if (!a?.filePath || !b?.filePath) {
      setAUrl(null)
      setBUrl(null)
      return
    }
    setLoading(true)
    const [ua, ub] = await Promise.all([
      signedDrawingUrl(a.filePath, 600),
      signedDrawingUrl(b.filePath, 600),
    ])
    setAUrl(ua)
    setBUrl(ub)
    setLoading(false)
  }, [aId, bId, withFiles])

  useEffect(() => {
    void load()
  }, [load])

  const isPdf = (id: string) =>
    (withFiles.find((s) => s.id === id)?.filePath ?? '')
      .toLowerCase()
      .endsWith('.pdf')

  if (withFiles.length < 2) {
    return (
      <section className="paper space-y-3 p-5">
        <div className="flex items-start justify-between gap-3">
          <p className="font-heading text-[15px] font-semibold">Overlay sheets</p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground">
          You need at least two drawings with an issued file on this project.
          Register them under Docs → Drawings and issue a revision for each.
        </p>
      </section>
    )
  }

  return (
    <section className="paper space-y-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="font-heading flex items-center gap-2 text-[15px] font-semibold">
          <Layers className="size-4 text-[var(--accent)]" />
          Overlay sheets
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Stated permanently, not behind a tooltip. A tool that looks like clash
          detection and is not is worse than no tool. */}
      <p className="flex items-start gap-2 rounded-lg bg-[color-mix(in_oklab,var(--warning)_11%,transparent)] px-3 py-2 text-[11px] leading-relaxed text-[var(--warning)]">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        A looking aid, not a geometric check. These sheets are not scaled or
        aligned to each other — you are lining them up by eye. It can show you
        where to go and look. It cannot prove a clearance, and it cannot prove
        there is no clash.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <Select
          value={aId}
          onChange={(e) => setAId(e.target.value)}
          aria-label="Base sheet"
        >
          {withFiles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select
          value={bId}
          onChange={(e) => setBId(e.target.value)}
          aria-label="Overlay sheet"
        >
          {withFiles.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </div>

      {(isPdf(aId) || isPdf(bId)) && (
        <p className="text-[11px] text-muted-foreground">
          One of these is a PDF and cannot be stacked here. Open it from Docs →
          Drawings, or upload an image export of the sheet to overlay it.
        </p>
      )}

      {loading && <Skeleton className="aspect-[4/3] w-full" />}

      {!loading && aUrl && bUrl && !isPdf(aId) && !isPdf(bId) && (
        <>
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-white ring-1 ring-border">
            <img
              src={aUrl}
              alt="Base sheet"
              className="absolute inset-0 size-full object-contain"
            />
            <img
              src={bUrl}
              alt="Overlay sheet"
              className="absolute inset-0 size-full object-contain"
              style={{
                opacity: opacity / 100,
                transform: `translate(${dx}px, ${dy}px) scale(${scale / 100})`,
              }}
            />
          </div>

          <div className="space-y-3">
            <Slider
              label="Overlay opacity"
              value={opacity}
              min={0}
              max={100}
              suffix="%"
              onChange={setOpacity}
            />
            <Slider
              label="Overlay scale"
              value={scale}
              min={50}
              max={150}
              suffix="%"
              onChange={setScale}
            />
            <div className="grid grid-cols-2 gap-3">
              <Slider
                label="Nudge across"
                value={dx}
                min={-200}
                max={200}
                suffix="px"
                onChange={setDx}
              />
              <Slider
                label="Nudge down"
                value={dy}
                min={-200}
                max={200}
                suffix="px"
                onChange={setDy}
              />
            </div>

            <Button
              variant="ghost"
              size="sm"
              className="h-10 w-full gap-1.5"
              onClick={() => {
                setOpacity(50)
                setDx(0)
                setDy(0)
                setScale(100)
              }}
            >
              <RotateCcw className="size-3.5" /> Reset alignment
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Spotted something? Take a screenshot and attach it when you raise the
            clash — the picture is what makes the register useful to somebody who
            was not standing here.
          </p>
        </>
      )}
    </section>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  suffix: string
  onChange: (v: number) => void
}) {
  const id = `sl_${label.replace(/\s+/g, '_')}`
  return (
    <div>
      <label
        htmlFor={id}
        className="flex items-baseline justify-between text-[11px] text-muted-foreground"
      >
        <span>{label}</span>
        <span className="tabular-nums">
          {value}
          {suffix}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-full bg-secondary accent-[var(--accent)]"
      />
    </div>
  )
}
