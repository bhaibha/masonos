// ============================================================
// MASON OS — learn-draft Edge Function
//
// Drafts the STRUCTURE of a Mason Learn entry with Google Gemini. The API key
// lives ONLY here, server-side — the same rule as admin-create-user, and the
// reason this is an Edge Function rather than a fetch from the browser.
//
// ---------- WHAT IT RETURNS, AND WHAT IT REFUSES TO ----------
// It returns a SKELETON: the step sequence for a procedure, where a safety note
// and a QA checkpoint belong on each step, and which IS standards are likely
// relevant BY NUMBER AND TITLE ONLY.
//
// It does not return, and the schema below has nowhere to put:
//   * clause text from any standard        (BIS sells them; copying is theft)
//   * a numeric requirement of any kind    (cover, curing days, tolerance, mix)
//   * anything presented as a fact about what a code says
//
// That is not squeamishness. A hallucinated cover value, sitting in the firm's
// own library under the firm's name, reaches a bar bender — and the shape of a
// procedure is the part a model is actually good at, while the numbers are the
// part it is confidently wrong about. So it drafts the shape and the engineer
// writes the substance.
//
// The prompt says all of this, AND the response schema enforces it structurally:
// every field is a placeholder or a citation, none is a value.
//
// ---------- SECURITY ----------
// The caller's JWT is verified and their profile role checked — founder/PM only,
// matching learn_article_write. Re-verified here rather than trusted from the
// client, exactly as admin-create-user does.
//
// Deploy:
//   supabase secrets set GEMINI_API_KEY=...
//   supabase functions deploy learn-draft
// (SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.)
// ============================================================

import { createClient } from 'jsr:@supabase/supabase-js@2'

// supabase-js's functions.invoke() attaches `apikey`, `x-client-info` and
// `x-supabase-api-version` on top of the two obvious headers. Any header the
// browser sends that is NOT named here fails the preflight, and the request
// never leaves the machine — which surfaces as the generic
// "Failed to send a request to the Edge Function", indistinguishable from the
// function not being deployed at all. List what the client actually sends.
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

// Flash: this is a short structured generation, not an essay. It is also the
// tier with a free allowance, which at four active projects is very likely to
// cover the firm's entire usage.
//
// Google RETIRES these on a published schedule, and a retired model answers
// `generateContent` with a bare 404 that reads like a broken URL:
// `gemini-2.0-flash` — the original choice here — was shut down on 1 June 2026.
// So the name is an env var: when the next one is retired, the fix is
// `supabase secrets set GEMINI_MODEL=…` rather than a code change and a deploy.
//
// Default is 3.5-flash (released May 2026, no announced shutdown). Deliberately
// NOT 2.5-flash, which is already scheduled to go on 16 October 2026 — moving
// to a model with a known death date two months out is not a migration.
const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.5-flash'

/**
 * The response schema IS the safety mechanism.
 *
 * There is no field for a value, a tolerance or a quotation, so the model
 * cannot return one in a structured response even if the prompt were ignored.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    summary_prompt: {
      type: 'string',
      description:
        'One sentence describing what this procedure covers, written as a prompt for the engineer to replace.',
    },
    scope_prompt: { type: 'string' },
    ppe_prompt: {
      type: 'string',
      description:
        'Generic PPE for this kind of work. No standard numbers, no specifications.',
    },
    suggested_tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Three to six short lowercase keywords.',
    },
    suggested_is_refs: {
      type: 'array',
      items: { type: 'string' },
      description:
        'IS standard NUMBERS only, e.g. "IS 456". Never a requirement, value or clause. Empty array if unsure — a wrong citation is worse than none.',
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instruction: {
            type: 'string',
            description:
              'What is done at this step, in plain site language. Describe the ACTION. Where a value belongs, write the placeholder "___" rather than a number.',
          },
          safety_note: {
            type: 'string',
            description:
              'The hazard at THIS step and the control for it. Empty string if the step has no distinct hazard.',
          },
          qa_checkpoint: {
            type: 'string',
            description:
              'What is checked before moving on, phrased as a check. Never state the acceptance value — write "as specified on the drawing" or "___".',
          },
        },
        required: ['instruction', 'safety_note', 'qa_checkpoint'],
      },
    },
  },
  required: ['steps', 'suggested_tags', 'suggested_is_refs'],
}

const SYSTEM = `You draft the SKELETON of a construction method statement for an
Indian residential contractor. You are producing a form for a qualified engineer
to complete, not a finished document.

ABSOLUTE RULES:
1. Never reproduce, quote, paraphrase or summarise the text of any IS standard,
   BIS publication or any other copyrighted code. You may cite a standard by
   NUMBER only (e.g. "IS 456") where it is plainly relevant.
2. Never state a numeric requirement of any kind — no cover, no curing period,
   no tolerance, no mix ratio, no spacing, no strength, no dimension. Where a
   number belongs, write "___" or "as specified on the drawing".
3. Never invent site-specific practice. Describe the ORDER OF WORK, which is
   general, and leave the specifics as placeholders.
4. If you are not confident a standard applies, return an empty is_refs array.
   A wrong citation is worse than no citation.

Write 6 to 12 steps. Use plain language a site supervisor reads easily. Attach
each safety note and QA checkpoint to the step it belongs to, never to the
document as a whole.`

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const geminiKey = Deno.env.get('GEMINI_API_KEY')

  if (!geminiKey) {
    // Named explicitly, because "AI drafting is unavailable" with no reason is
    // the kind of message that costs somebody an afternoon.
    return json(
      {
        error:
          'GEMINI_API_KEY is not set on this project. Run: supabase secrets set GEMINI_API_KEY=…',
      },
      503,
    )
  }

  // ---- 1. Who is calling? ----
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization' }, 401)
  }

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: userData, error: userErr } = await asCaller.auth.getUser()
  if (userErr || !userData.user) return json({ error: 'Invalid session' }, 401)

  const { data: me } = await asCaller
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle()

  // Matches learn_article_write. Checked here rather than trusted from the
  // client — the client cannot be the thing that decides.
  if (!me || !['founder', 'pm'].includes(me.role as string)) {
    return json({ error: 'Only a founder or PM may draft library content' }, 403)
  }

  // ---- 2. Input ----
  let body: { title?: string; activity?: string; trades?: string[] }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const title = (body.title ?? '').trim()
  const activity = (body.activity ?? '').trim()
  if (!title && !activity) {
    return json({ error: 'Give it a title or an activity to work from' }, 400)
  }

  const ask = [
    `Title: ${title || '(none given)'}`,
    `Activity: ${activity || '(none given)'}`,
    body.trades?.length ? `Trades involved: ${body.trades.join(', ')}` : null,
    '',
    'Draft the skeleton of this method statement.',
  ]
    .filter(Boolean)
    .join('\n')

  // ---- 3. Gemini ----
  let res: Response
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': geminiKey,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: 'user', parts: [{ text: ask }] }],
          generationConfig: {
            // Low, not zero: a skeleton benefits from a little variety in
            // phrasing, but this is not the place for invention.
            temperature: 0.3,
            responseMimeType: 'application/json',
            responseSchema: SCHEMA,
          },
        }),
      },
    )
  } catch (e) {
    return json({ error: `Could not reach Gemini: ${String(e)}` }, 502)
  }

  if (!res.ok) {
    const detail = await res.text()

    // A 404 here is almost never a broken URL — it is a model that Google has
    // retired, which is a scheduled event rather than a fault. Say so, and name
    // the model, because "Gemini returned 404" sent somebody looking at their
    // API key for an hour.
    if (res.status === 404) {
      return json(
        {
          error:
            `Gemini has no model called "${MODEL}" — it has almost certainly ` +
            `been retired. Set a current one with: ` +
            `supabase secrets set GEMINI_MODEL=<name>`,
          detail: detail.slice(0, 500),
        },
        502,
      )
    }

    // Pass the provider's own message through. A generic "AI failed" hides a
    // quota message or a bad key, which are the two things that actually happen.
    return json(
      { error: `Gemini returned ${res.status}`, detail: detail.slice(0, 500) },
      502,
    )
  }

  const payload = await res.json()
  const text: string | undefined =
    payload?.candidates?.[0]?.content?.parts?.[0]?.text

  if (!text) {
    return json(
      { error: 'Gemini returned no content', detail: JSON.stringify(payload).slice(0, 500) },
      502,
    )
  }

  let draft: Record<string, unknown>
  try {
    draft = JSON.parse(text)
  } catch {
    return json({ error: 'Gemini returned a malformed draft' }, 502)
  }

  // ---- 4. A last belt-and-braces pass ----
  // The schema has no field for a value, but the model still writes prose into
  // the fields it does have. Anything that looks like a stated requirement is
  // replaced with a placeholder rather than trusted — the engineer is going to
  // fill these in regardless, and a plausible wrong number is the failure mode
  // this whole design exists to avoid.
  const scrub = (s: unknown): string => {
    let out = typeof s === 'string' ? s : ''
    // "25 mm", "7 days", "M25", "1:1.5:3", "150 c/c" → placeholder
    out = out.replace(
      /\b\d+(\.\d+)?\s?(mm|cm|m|kg|days?|hours?|hrs?|mpa|n\/mm2|%)\b/gi,
      '___',
    )
    out = out.replace(/\bM\s?\d{2,3}\b/g, '___')
    out = out.replace(/\b\d+\s?:\s?\d+(\.\d+)?\s?:\s?\d+(\.\d+)?\b/g, '___')
    out = out.replace(/\b\d+\s?c\/c\b/gi, '___ c/c')
    return out
  }

  const steps = Array.isArray(draft.steps)
    ? (draft.steps as Record<string, unknown>[]).slice(0, 20).map((s) => ({
        instruction: scrub(s.instruction),
        safety_note: scrub(s.safety_note),
        qa_checkpoint: scrub(s.qa_checkpoint),
      }))
    : []

  if (steps.length === 0) {
    return json({ error: 'Gemini produced no steps — try a clearer title' }, 502)
  }

  return json({
    model: MODEL,
    summary_prompt: scrub(draft.summary_prompt),
    scope_prompt: scrub(draft.scope_prompt),
    ppe_prompt: scrub(draft.ppe_prompt),
    // IS refs are kept as citations only, and anything that is not a bare
    // standard number is dropped rather than shown.
    suggested_is_refs: Array.isArray(draft.suggested_is_refs)
      ? (draft.suggested_is_refs as unknown[])
          .filter((r) => typeof r === 'string')
          .map((r) => (r as string).trim())
          .filter((r) => /^IS\s?\d{3,5}(\s?:\s?\d{4})?$/i.test(r))
          .slice(0, 8)
      : [],
    suggested_tags: Array.isArray(draft.suggested_tags)
      ? (draft.suggested_tags as unknown[])
          .filter((t) => typeof t === 'string')
          .map((t) => (t as string).trim().toLowerCase())
          .slice(0, 8)
      : [],
    steps,
  })
})
