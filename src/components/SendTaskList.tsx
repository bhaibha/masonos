import { Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { COMPANY } from '@/lib/company'
import { errText } from '@/lib/errText'
import { fetchProjectTeam } from '@/lib/queries/tasks'
import { shareText, waNumber } from '@/lib/share'
import { formatDayLabel } from '@/lib/useSelectedDate'
import { TASK_STATUS_LABEL, type TaskRow } from '@/lib/types'

/**
 * Sends the day's task list to somebody on WhatsApp.
 *
 * This exists alongside the 7am push, not instead of it: the push only reaches
 * people who have installed the app and granted permission, and on a site not
 * everyone will. A message you can send by hand always arrives.
 *
 * Nothing is sent automatically — WhatsApp opens with the text written and the
 * person taps send.
 */
export function SendTaskList({
  projectId,
  projectName,
  date,
  tasks,
}: {
  projectId: string
  projectName: string | null
  date: string
  tasks: TaskRow[]
}) {
  const [open, setOpen] = useState(false)
  const [team, setTeam] = useState<
    { id: string; full_name: string; phone: string | null; role: string }[]
  >([])

  useEffect(() => {
    if (!open) return
    fetchProjectTeam(projectId)
      .then(setTeam)
      .catch(() => setTeam([]))
  }, [open, projectId])

  /** Plain text, because it lands in a chat window, not a document. */
  function buildMessage(): string {
    const lines = [
      `${projectName ?? 'Project'} — ${formatDayLabel(date)}`,
      '',
      ...tasks.map((t, i) => {
        const bits = [t.trade, t.work_area].filter(Boolean).join(' · ')
        const qty =
          t.target_qty !== null ? ` — ${t.target_qty} ${t.qty_unit ?? ''}`.trimEnd() : ''
        // Status only when it isn't the default, so a fresh list stays clean.
        const status =
          t.status === 'pending' ? '' : ` [${TASK_STATUS_LABEL[t.status]}]`
        return `${i + 1}. ${t.title}${bits ? ` (${bits})` : ''}${qty}${status}`
      }),
      '',
      `— ${COMPANY.name}`,
    ]
    return lines.join('\n')
  }

  async function send(phone: string | null, name: string) {
    try {
      const outcome = await shareText({
        message: buildMessage(),
        phone,
        label: `${projectName ?? 'Project'} tasks`,
      })

      if (outcome === 'shared') {
        toast.success('Shared', { description: 'Pick the app and send.' })
      } else if (outcome === 'downloaded-and-opened-whatsapp') {
        toast.success('WhatsApp opened', {
          description: phone
            ? `Chat with ${name} — review and send.`
            : 'Pick the chat, then send.',
        })
      }
      setOpen(false)
    } catch (err) {
      toast.error('Could not open WhatsApp', { description: errText(err) })
    }
  }

  if (tasks.length === 0) return null

  return (
    <>
      <Button
        variant="outline"
        className="h-12 w-full text-base"
        onClick={() => setOpen((o) => !o)}
      >
        <Send className="size-4" aria-hidden="true" />
        Send today's list
      </Button>

      {open && (
        <div className="paper space-y-2 p-4">
          <p className="text-[11px] tracking-[0.14em] text-muted-foreground uppercase">
            Send to
          </p>

          {team.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nobody is assigned to this project yet — you can still pick a chat
              manually below.
            </p>
          )}

          <ul className="space-y-1">
            {team.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => void send(m.phone, m.full_name)}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 text-left text-sm transition-colors hover:bg-secondary"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {m.full_name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {/* Say plainly when there's no number rather than opening
                          an empty chat and letting them wonder. */}
                      {waNumber(m.phone)
                        ? m.phone
                        : 'No number on file — opens the chat picker'}
                    </span>
                  </span>
                  <Send
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>

          <Button
            variant="ghost"
            className="h-11 w-full"
            onClick={() => void send(null, '')}
          >
            Pick the chat myself
          </Button>
        </div>
      )}
    </>
  )
}
