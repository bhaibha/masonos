// ============================================================
// assistant — the in-app AI chat panel (migration 064)
//
// Answers questions about the firm's own data, answers construction questions
// grounded in Mason Learn, explains the app, and PROPOSES a small set of safe
// records for a person to confirm.
//
// ---------- THE WHOLE SECURITY STORY ----------
//   * The Supabase client is built from the CALLER'S Authorization header, so
//     RLS applies to every read and every write. No service-role key exists in
//     this feature.
//   * The model never emits SQL. It picks a name from the whitelist in
//     tools.ts; anything else is refused before it runs.
//   * Write tools do not write. They record a PROPOSAL and return a card. Only
//     fn_assistant_execute writes, and only after the user taps Confirm — and
//     it is SECURITY INVOKER, so the insert obeys the caller's own policies.
//   * There is no code path to any financial table. Not a guarded one — none.
//
// ---------- STREAMING ----------
// Server-sent events. The tool loop runs against streamGenerateContent: a
// stream that turns out to contain a functionCall is drained, the tool is run,
// and a fresh stream is opened with the result appended. A stream that contains
// text is forwarded to the browser as it arrives. So the user sees "checking
// open snags…" and then words appearing, which is what actually happened.
//
// Deploy:  supabase functions deploy assistant
// GEMINI_API_KEY is already set on this project (learn-draft, photo-analyse);
// secrets are project-wide, so this inherits it with no extra step.
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'
import { runTool, toolsForRole, type Role } from './tools.ts'
import { APP_GUIDE } from './guide.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// A perishable constant — a retired model answers with a bare 404 that reads
// like a broken URL (gemini-2.0-flash went on 1 June 2026).
//
// ASSISTANT_MODEL first, so this can be pointed at a heavier model WITHOUT
// dragging learn-draft along with it. Supabase secrets are project-wide, so a
// bare GEMINI_MODEL change silently re-points every function that reads it —
// the Learn skeleton drafter does not need a reasoning model and would just
// cost more and take longer.
const MODEL =
  Deno.env.get('ASSISTANT_MODEL') ??
  Deno.env.get('GEMINI_MODEL') ??
  'gemini-3.5-flash'

/** Bounded. Without a ceiling a confused model can loop on tools forever. */
const MAX_TOOL_ROUNDS = 5
const DAILY_LIMIT = Number(Deno.env.get('ASSISTANT_DAILY_LIMIT') ?? '60')

const SYSTEM = (role: string, projectHint: string | null) => `
You are the assistant inside Mason OS, the internal construction-management app
of Your Masons — a luxury residential contractor in Bengaluru. You are talking
to a member of staff whose role is: ${role}.
${projectHint ? `They currently have "${projectHint}" open.` : ''}

WHAT YOU DO
1. Answer questions about their own data by CALLING TOOLS. Never guess a figure
   or a count — call the tool and report what it returns. If you did not call a
   tool, say you do not know.
2. Answer construction questions. Call search_knowledge FIRST so the answer
   reflects how this firm actually works. If the library has nothing, you may
   answer from general knowledge — but say plainly that it is general guidance,
   not verified against this firm's specification or the project drawings.
3. Explain the app, using the guide below.
4. Propose records for the user to confirm. Proposing is not doing.

HARD LIMITS — say so plainly and point at the screen:
* You cannot create, change, void or delete ANY financial record: expenses,
  budgets, purchase orders, invoices, variation orders, RA bills, retention,
  overheads. There is no tool for it. Point at Money and the relevant tab.
* You cannot delete or void anything at all. Deletion and voiding are
  deliberate acts with their own confirmation and reason, on the record's own
  screen.
* You cannot change roles, permissions, project membership or settings. That is
  Admin, founder only.
* You cannot certify, approve or sign anything off.

DATA RULES
* A tool that returns "restricted for your role" means the DATABASE refused —
  the user's role does not permit it. Say that plainly. Never guess the figure
  and never imply the data does not exist.
* Money is INR. Write figures as ₹1,20,000 in the Indian convention.
* If a tool returns nothing, say nothing was found — do not say there is none,
  because a filter may simply not have matched.

BEFORE PROPOSING ANYTHING
Ask for what is missing. A snag needs a location. A task needs a project and a
title. An RFI needs a question worth a consultant's time. If the request is
ambiguous — which project, which date, which area — ASK, do not assume. One
question at a time.

After you call a propose_ tool, a confirmation card appears on screen. NOTHING
HAS BEEN CREATED. Tell them to check the values and tap Confirm. Never say
"I've created" or "I've raised" — say "I've drafted this for you to confirm".

STYLE
Plain language a site engineer reads on a phone. Short. No preamble, no
"Certainly!". Indian construction terms are fine — RCC, shuttering, c/c, chajja.
Never invent an IS clause number or a measured value. If you do not know, say so.

--- APP GUIDE ---
${APP_GUIDE}
`.trim()

/**
 * Turns Gemini's 429 body into something actionable.
 *
 * "Try again in a minute" is useless advice if the limit was a DAILY one, and
 * a preview Pro model on the free tier is usually a daily (or zero) allowance
 * rather than a per-minute one. Google's body names the quota it refused and
 * often a retryDelay; surfacing both is the difference between waiting sixty
 * seconds pointlessly and changing the model.
 */
function quotaMessage(detail: string, model: string): string {
  let metric = ''
  let retry = ''
  try {
    const body = JSON.parse(detail)
    const details = body?.error?.details ?? []
    for (const d of details) {
      if (typeof d?.retryDelay === 'string') retry = d.retryDelay
      for (const v of d?.violations ?? []) {
        if (typeof v?.quotaMetric === 'string') metric = v.quotaMetric
        if (typeof v?.quotaId === 'string' && !metric) metric = v.quotaId
      }
    }
  } catch {
    /* body was not JSON — fall through to the generic message */
  }

  const perDay = /per_?day|PerDay/i.test(metric)

  if (perDay) {
    return (
      `Gemini refused: the DAILY free-tier quota for "${model}" is used up` +
      (metric ? ` (${metric})` : '') +
      '. It resets at midnight Pacific time. Preview Pro models have a very ' +
      'small free allowance — switch back to a Flash model with: ' +
      'supabase secrets set ASSISTANT_MODEL=gemini-3.5-flash'
    )
  }

  return (
    `Gemini is rate-limiting "${model}"` +
    (metric ? ` (${metric})` : '') +
    '. ' +
    (retry ? `Retry in about ${retry}.` : 'Wait a minute and try again.') +
    ' If this keeps happening, a Flash model has far higher free-tier limits.'
  )
}

/**
 * One Gemini call, with a short retry on TRANSIENT failures only.
 *
 * 503 UNAVAILABLE means Google is out of capacity for that model right now —
 * nothing to do with our quota, and usually gone within a second or two.
 * Preview models hit it often. Retrying a 400 or a 404 would be pointless
 * (the request is wrong), and retrying a daily 429 would be rude, so only
 * 503 and 429-with-a-short-delay are retried.
 *
 * Two attempts, not ten: somebody is watching a spinner on a site phone, and
 * an assistant that takes thirty seconds to fail is worse than one that fails
 * in three and says why.
 */
async function callGemini(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let last: Response | null = null
  for (let i = 0; i < attempts; i++) {
    const res = await fetch(url, init)
    if (res.ok) return res
    if (res.status !== 503 && res.status !== 429) return res

    last = res
    if (i === attempts - 1) break
    // 503s clear fast; a 429 that is going to clear at all clears slowly.
    await new Promise((r) => setTimeout(r, res.status === 503 ? 900 * (i + 1) : 2500))
  }
  return last!
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const geminiKey = Deno.env.get('GEMINI_API_KEY')

  if (!geminiKey) {
    return json(
      {
        error:
          'GEMINI_API_KEY is not set on this project. Run: supabase secrets set GEMINI_API_KEY=…',
      },
      503,
    )
  }

  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization' }, 401)
  }

  // Every query in this request runs on THIS client. Nothing else exists.
  const db = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: userData, error: userErr } = await db.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)

  const { data: me } = await db
    .from('profiles')
    .select('role, full_name')
    .eq('id', userData.user.id)
    .maybeSingle()

  const role = (me?.role as Role) ?? null
  if (!role) return json({ error: 'No profile for this session' }, 403)

  // A client has no tools — none of them list 'client' — so nothing could leak.
  // Refused anyway: without this they reach Gemini on the firm's quota and get
  // a general chatbot wearing the firm's name. The assistant is an internal
  // tool and says so.
  if ((role as string) === 'client') {
    return json(
      { error: 'The assistant is not part of the client portal.' },
      403,
    )
  }

  let body: {
    message?: string
    thread_id?: string | null
    project_hint?: string | null
    history?: { role: string; content: string }[]
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const message = (body.message ?? '').trim()
  if (!message) return json({ error: 'Say something first.' }, 400)

  // Rate limit BEFORE the model call, so a refused turn does not cost quota
  // it did not use. The counter is SECURITY DEFINER and has no write policy,
  // so it cannot be reset by the thing being counted.
  const { error: quotaErr } = await db.rpc('fn_assistant_quota', {
    p_limit: DAILY_LIMIT,
  })
  if (quotaErr) {
    return json({ error: quotaErr.message }, 429)
  }

  const declarations = toolsForRole(role).map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }))

  // Gemini's own message shape. History is capped: a long thread is mostly
  // noise by the tenth turn and it is the user's token budget being spent.
  const contents: Record<string, unknown>[] = []
  for (const h of (body.history ?? []).slice(-10)) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    })
  }
  contents.push({ role: 'user', parts: [{ text: message }] })

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        )
      }

      try {
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          const res = await callGemini(
            `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': geminiKey,
              },
              body: JSON.stringify({
                systemInstruction: {
                  parts: [{ text: SYSTEM(role, body.project_hint ?? null) }],
                },
                contents,
                tools: [{ functionDeclarations: declarations }],
                generationConfig: { temperature: 0.2 },
              }),
            },
          )

          if (!res.ok) {
            const detail = await res.text()
            send('error', {
              message:
                res.status === 404
                  ? `Gemini has no model called "${MODEL}". Either it has been retired, or the name is wrong — a Pro model needs its full preview id, e.g. gemini-3.1-pro-preview. Set it with: supabase secrets set ASSISTANT_MODEL=<name>`
                  : res.status === 429
                    ? quotaMessage(detail, MODEL)
                    : res.status === 503
                      ? `"${MODEL}" is overloaded at Google's end right now — this is their capacity, not your quota, and it is common on preview models. Tried three times. A Flash model is far more reliably available: supabase secrets set ASSISTANT_MODEL=gemini-3.5-flash`
                      : `Gemini returned ${res.status}. ${detail.slice(0, 200)}`,
            })
            controller.close()
            return
          }

          // ---- read one SSE stream ----
          const reader = res.body!.getReader()
          const dec = new TextDecoder()
          let buf = ''
          let sawText = false
          const calls: { name: string; args: Record<string, unknown> }[] = []
          const modelParts: Record<string, unknown>[] = []
          let textSoFar = ''

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buf += dec.decode(value, { stream: true })

            const lines = buf.split('\n')
            buf = lines.pop() ?? ''
            for (const line of lines) {
              if (!line.startsWith('data:')) continue
              const raw = line.slice(5).trim()
              if (!raw || raw === '[DONE]') continue

              let chunk: Record<string, unknown>
              try {
                chunk = JSON.parse(raw)
              } catch {
                continue
              }

              const parts =
                // deno-lint-ignore no-explicit-any
                (chunk as any)?.candidates?.[0]?.content?.parts ?? []
              for (const part of parts) {
                // KEEP THE PART VERBATIM. Gemini 2.5+ attaches a
                // `thoughtSignature` to functionCall parts and REQUIRES it
                // echoed back unchanged on the following turn. Rebuilding the
                // part as `{ functionCall: part.functionCall }` drops it, and
                // the next request fails with
                //   400 "Function call is missing a thought_signature"
                // — which reads like a malformed request rather than a lost
                // field. Never reconstruct a part; pass back what arrived.
                const prev = modelParts[modelParts.length - 1] as
                  | Record<string, unknown>
                  | undefined

                // A thinking model emits its reasoning as parts flagged
                // `thought: true`. They carry text AND a signature, so they
                // must be kept for the next turn — but they must NEVER be
                // shown. Streaming them would put the model's private
                // working-out in front of a site engineer as if it were the
                // answer.
                if (part.thought === true) {
                  modelParts.push({ ...part })
                  continue
                }

                if (typeof part.text === 'string' && part.text !== '') {
                  sawText = true
                  textSoFar += part.text
                  send('text', { delta: part.text })

                  // Merge consecutive text chunks so the model turn is a few
                  // parts rather than one per streamed token.
                  if (
                    prev &&
                    typeof prev.text === 'string' &&
                    !('thoughtSignature' in part)
                  ) {
                    prev.text = (prev.text as string) + part.text
                  } else {
                    modelParts.push({ ...part })
                  }
                  continue
                }

                if (part.functionCall) {
                  calls.push({
                    name: part.functionCall.name,
                    args: part.functionCall.args ?? {},
                  })
                }

                modelParts.push({ ...part })
              }
            }
          }

          // No tool wanted: that was the answer.
          if (calls.length === 0) {
            if (!sawText) {
              send('error', {
                message:
                  'The assistant returned nothing. Try rephrasing the question.',
              })
            }
            send('done', { text: textSoFar })
            controller.close()
            return
          }

          if (round === MAX_TOOL_ROUNDS) {
            send('error', {
              message:
                'That question needed too many lookups. Try asking about one thing at a time.',
            })
            controller.close()
            return
          }

          // ---- run the tools, as the caller ----
          contents.push({ role: 'model', parts: modelParts })
          const responseParts: Record<string, unknown>[] = []

          for (const call of calls) {
            send('tool', { name: call.name, args: call.args })

            const result = await runTool(
              db,
              role,
              body.thread_id ?? null,
              call.name,
              call.args,
            )

            // A proposal reaches the browser as its own event, so the card can
            // render from the SAME payload that was stored — the card and the
            // eventual insert cannot disagree.
            const r = result as Record<string, unknown>
            if (r && r.proposed === true) {
              send('proposal', {
                action_id: r.action_id,
                kind: r.kind,
                project: r.project,
                values: r.values,
              })
            }

            responseParts.push({
              functionResponse: {
                name: call.name,
                response: { result },
              },
            })
          }

          contents.push({ role: 'user', parts: responseParts })
        }
      } catch (e) {
        send('error', { message: `Something broke: ${String(e)}` })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...CORS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
})
