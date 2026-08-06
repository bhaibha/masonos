// Mason OS — daily task push
//
// Triggered by pg_cron (via pg_net) each morning. Reads fn_daily_task_digest(),
// looks up each person's push subscriptions, and sends one notification per
// device.
//
// ---------- WHY THE SERVICE ROLE IS SAFE HERE ----------
// This function holds the service-role key, so it must never be callable by a
// stranger. Two gates: it refuses anything without the shared secret header,
// and it takes no input at all — there is no user id, no project, nothing an
// attacker could steer. The worst a leaked secret buys is triggering the same
// notification twice.
//
// ---------- DEAD SUBSCRIPTIONS ----------
// A 404 or 410 from the push service means the endpoint is gone for good
// (uninstalled, permission revoked). Those are marked disabled rather than
// deleted, so a person who stops getting notifications has an explanation.
// Any other failure just increments a counter — a push service having a bad
// minute should not unsubscribe anybody.
//
// Secrets required on the function:
//   PUSH_SECRET            shared with the cron job
//   VAPID_PUBLIC_KEY       same key the browser subscribes with
//   VAPID_PRIVATE_KEY      never leaves the server
//   VAPID_SUBJECT          mailto:you@example.com
//   APP_URL                where tapping the notification should land

import { createClient } from 'jsr:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

interface DigestRow {
  user_id: string
  full_name: string
  task_count: number
  overdue_count: number
  project_names: string
}

interface SubRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  failure_count: number
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const secret = Deno.env.get('PUSH_SECRET')

  // A MISSING secret is a setup mistake and says so — a bare 403 here sent us
  // hunting for a mismatch that didn't exist. A WRONG secret still gets the
  // terse reply, because that one might be an attacker.
  if (!secret) {
    return new Response(
      'PUSH_SECRET is not set on this function. Add it under Edge Functions → Secrets.',
      { status: 500 },
    )
  }
  if (req.headers.get('x-mason-secret') !== secret) {
    return new Response('Forbidden', { status: 403 })
  }

  const vapidPublic = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com'
  const appUrl = Deno.env.get('APP_URL') ?? '/'

  if (!vapidPublic || !vapidPrivate) {
    return new Response('VAPID keys not configured', { status: 500 })
  }

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate)

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  // ---------- who has work today ----------
  const { data: digest, error: digestErr } = await supabase.rpc(
    'fn_daily_task_digest',
  )

  if (digestErr) {
    return new Response(JSON.stringify({ error: digestErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const rows = (digest ?? []) as DigestRow[]
  if (rows.length === 0) {
    return json({ sent: 0, note: 'Nothing due — no notifications sent.' })
  }

  // ---------- their devices ----------
  const { data: subs, error: subErr } = await supabase
    .from('push_subscriptions')
    .select('id, user_id, endpoint, p256dh, auth, failure_count')
    .in(
      'user_id',
      rows.map((r) => r.user_id),
    )
    .is('disabled_at', null)

  if (subErr) {
    return new Response(JSON.stringify({ error: subErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const byUser = new Map<string, SubRow[]>()
  for (const s of (subs ?? []) as SubRow[]) {
    const list = byUser.get(s.user_id) ?? []
    list.push(s)
    byUser.set(s.user_id, list)
  }

  let sent = 0
  let disabled = 0
  let failed = 0

  for (const row of rows) {
    const devices = byUser.get(row.user_id) ?? []
    if (devices.length === 0) continue

    // Wording comes from the counts the database returned, so the notification
    // and the screen can never disagree.
    const bits: string[] = []
    if (row.task_count > 0) bits.push(`${row.task_count} due today`)
    if (row.overdue_count > 0) bits.push(`${row.overdue_count} still open`)

    const payload = JSON.stringify({
      title: `${bits.join(' · ')}`,
      body: row.project_names,
      url: `${appUrl}/tasks`,
      tag: 'mason-daily-tasks',
    })

    for (const d of devices) {
      try {
        await webpush.sendNotification(
          {
            endpoint: d.endpoint,
            keys: { p256dh: d.p256dh, auth: d.auth },
          },
          payload,
        )
        sent += 1
        await supabase
          .from('push_subscriptions')
          .update({ last_success_at: new Date().toISOString(), failure_count: 0 })
          .eq('id', d.id)
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode

        if (status === 404 || status === 410) {
          // Gone for good — uninstalled or permission revoked.
          disabled += 1
          await supabase
            .from('push_subscriptions')
            .update({ disabled_at: new Date().toISOString() })
            .eq('id', d.id)
        } else {
          // A transient failure must not unsubscribe anyone.
          failed += 1
          await supabase
            .from('push_subscriptions')
            .update({ failure_count: d.failure_count + 1 })
            .eq('id', d.id)
        }
      }
    }
  }

  return json({ people: rows.length, sent, disabled, failed })
})

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}
