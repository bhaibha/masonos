// ============================================================
// photo-analyse — D1, the AI photo helper (migration 061)
//
// Sends ONE site photo to Gemini Flash and returns a description plus a list of
// things worth checking. The API key stays here; the browser never sees it.
//
// ---------- WHY THE FUNCTION DOWNLOADS THE IMAGE ITSELF ----------
// The client sends a storage PATH, not the bytes. The function then fetches the
// object using a Supabase client built from the CALLER'S OWN Authorization
// header, so the `site-photos` bucket policy decides whether that person may
// read that photo. If it refused, we never had the image to send.
//
// The alternative — the browser posts base64 — would work and would mean the
// function analyses whatever it is handed, including a photo from a project the
// caller cannot open. Making storage RLS the gate costs one round trip.
//
// NEVER the service-role key. It would read any object on the project and turn
// this endpoint into an "analyse any photo in the company" API.
//
// ---------- WHY THE FUNCTION WRITES THE ROW ----------
// It inserts into `photo_analyses` itself, again as the caller, so the stored
// text is provably what the model returned. If the browser did the insert, the
// `model` column would be a claim rather than a fact, and 061's guard trigger
// (which freezes the analysis text from PostgREST) would be guarding nothing.
//
// ---------- WHAT THE MODEL IS NOT ALLOWED TO DO ----------
// Three layers, same structure as learn-draft (058):
//   1. The response SCHEMA has no field for a severity, a measurement or a
//      verdict. It cannot return one because there is nowhere to put it.
//   2. The system prompt forbids diagnosing and forbids numbers.
//   3. A regex scrub replaces anything that still looks like a measurement.
//
// A vision model cannot measure a crack from a photograph. A stated width would
// be invention, and an invented width in a construction record is worse than no
// record at all — somebody would quote it.
//
// Deploy:
//   supabase functions deploy photo-analyse
// GEMINI_API_KEY is already set on this project for learn-draft; secrets are
// project-wide, so this function inherits it with no extra step.
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

// A perishable constant — Google retires these on a published schedule and a
// retired model answers with a bare 404 that reads like a broken URL
// (gemini-2.0-flash went on 1 June 2026). Overridable without a deploy.
const MODEL =
  Deno.env.get('GEMINI_VISION_MODEL') ??
  Deno.env.get('GEMINI_MODEL') ??
  'gemini-3.5-flash'

// Compressed site photos are ≤300KB (CLAUDE.md rule 4). This ceiling is well
// clear of that and stops an uncompressed original being posted at Gemini.
const MAX_BYTES = 4 * 1024 * 1024

/**
 * The response schema IS the safety mechanism.
 *
 * There is no `severity`, no `verdict`, no `measurement` and no `pass_fail`.
 * The model physically cannot return one. Every concern must carry
 * `what_to_check`, which forces the output into the grammar of a question for a
 * person rather than a finding.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    description: {
      type: 'string',
      description:
        'Plain factual description of what is visible in the photograph. ' +
        'No judgement, no diagnosis, no numbers.',
    },
    concerns: {
      type: 'array',
      description:
        'Things a site engineer might want to look at more closely. May be ' +
        'empty. Never a conclusion.',
      items: {
        type: 'object',
        properties: {
          concern: {
            type: 'string',
            description:
              'What appears to be visible, hedged. e.g. "possible honeycombing ' +
              'near the base of the column".',
          },
          what_to_check: {
            type: 'string',
            description:
              'What a person should physically do to confirm or rule it out.',
          },
        },
        required: ['concern', 'what_to_check'],
      },
    },
    nothing_notable: {
      type: 'boolean',
      description:
        'True when the photo shows no obvious cause for concern. Saying so is ' +
        'a useful answer.',
    },
  },
  required: ['description', 'concerns', 'nothing_notable'],
}

const SYSTEM = `You are helping a construction site engineer in Bengaluru take a
second look at a photograph. You are NOT an inspector and NOT a defect detector.

WHAT YOU DO
Describe what is visible, then list anything a person might want to check more
closely. Typical things worth flagging on a residential concrete-frame job:
cracking, honeycombing, exposed or corroding reinforcement, water ingress or
damp staining, spalling, formwork or scaffold condition, missing PPE, poor
housekeeping and trip hazards, unguarded edges or openings.

HARD RULES — these are not style preferences.
1. NEVER state a measurement. You cannot measure anything from a photograph.
   No crack widths, no cover depths, no dimensions, no percentages, no grades.
2. NEVER give a verdict, a severity or a pass/fail. You are not deciding
   anything. A person with a tape and a torch decides.
3. NEVER diagnose a cause. "Possible cracking" is allowed. "Structural crack
   caused by settlement" is not — you cannot tell shrinkage from settlement
   from a picture, and being wrong about that is expensive.
4. HEDGE every concern: "possible", "appears to be", "what looks like".
5. If the photo is unclear, too dark, or shows nothing relevant, SAY SO in the
   description and return an empty concerns list. A confident answer about a
   blurry photo is worse than no answer.
6. Do not identify or describe individuals. If PPE is a concern, say "a worker
   in frame appears to be without a hard hat" — never describe the person.
7. Plain language a site supervisor reads easily. No jargon for its own sake.

Return between 0 and 5 concerns. Fewer, and better, beats a long list.`

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

  // Matches pa_insert in 061. Checked here rather than trusted from the client
  // — the client cannot be the thing that decides.
  if (!me || !['founder', 'pm', 'supervisor'].includes(me.role as string)) {
    return json({ error: 'Your role cannot analyse site photos' }, 403)
  }

  // ---- 2. Input ----
  let body: {
    project_id?: string
    photo_path?: string
    source?: string
    site_log_id?: string | null
    snag_id?: string | null
    comment_id?: string | null
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const projectId = (body.project_id ?? '').trim()
  const photoPath = (body.photo_path ?? '').trim()
  if (!projectId || !photoPath) {
    return json({ error: 'project_id and photo_path are both required' }, 400)
  }

  // The path must sit under the project it claims. Storage RLS enforces this
  // too, but catching it here gives a message that says what is wrong instead
  // of an opaque download failure.
  if (!photoPath.startsWith(`${projectId}/`)) {
    return json(
      { error: 'That photo does not belong to that project.' },
      400,
    )
  }

  // ---- 3. Fetch the image AS THE CALLER ----
  const { data: blob, error: dlErr } = await asCaller.storage
    .from('site-photos')
    .download(photoPath)

  if (dlErr || !blob) {
    return json(
      {
        error:
          'Could not read that photo. It may have been deleted, or you may not have access to that project.',
      },
      403,
    )
  }

  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (bytes.byteLength > MAX_BYTES) {
    return json(
      { error: 'That image is too large to analyse.' },
      413,
    )
  }

  // Chunked, because String.fromCharCode(...) on a 300KB array blows the
  // argument limit and fails as a RangeError that reads like a network problem.
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  const base64 = btoa(binary)
  const mime = blob.type || 'image/jpeg'

  // ---- 4. Gemini ----
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
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: mime, data: base64 } },
                {
                  text:
                    'Look at this site photograph. Describe what is visible, ' +
                    'then list anything worth checking more closely. Remember: ' +
                    'no measurements, no severities, no verdicts.',
                },
              ],
            },
          ],
          generationConfig: {
            // Low: this is an observation, not a piece of writing.
            temperature: 0.2,
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
    if (res.status === 404) {
      return json(
        {
          error:
            `Gemini has no model called "${MODEL}" — it has almost certainly ` +
            `been retired. Set a current one with: ` +
            `supabase secrets set GEMINI_VISION_MODEL=<name>`,
          detail: detail.slice(0, 500),
        },
        502,
      )
    }
    return json(
      { error: `Gemini returned ${res.status}`, detail: detail.slice(0, 500) },
      502,
    )
  }

  const payload = await res.json()
  const text: string | undefined =
    payload?.candidates?.[0]?.content?.parts?.[0]?.text

  if (!text) {
    // A safety block lands here: the model returned a candidate with no text.
    const reason = payload?.candidates?.[0]?.finishReason
    return json(
      {
        error:
          reason === 'SAFETY'
            ? 'Gemini declined to analyse this image.'
            : 'Gemini returned no content',
        detail: JSON.stringify(payload).slice(0, 400),
      },
      502,
    )
  }

  let out: {
    description?: string
    concerns?: { concern?: string; what_to_check?: string }[]
    nothing_notable?: boolean
  }
  try {
    out = JSON.parse(text)
  } catch {
    return json({ error: 'Gemini returned a malformed analysis' }, 502)
  }

  // ---- 5. Belt and braces ----
  // The schema has nowhere to put a measurement, but the model still writes
  // prose into the fields it does have. Anything that looks like a stated
  // dimension is removed rather than trusted: a width the model invented, sitting
  // in a construction record, is the single most damaging thing this feature
  // could produce.
  const scrub = (s: unknown): string => {
    let v = typeof s === 'string' ? s : ''
    // "0.3 mm", "25mm", "2 m", "150 cm"
    v = v.replace(/\b\d+(\.\d+)?\s?(mm|cm|m|metres?|meters?|inch(es)?|ft)\b/gi, '—')
    // "M25", "Fe500"
    v = v.replace(/\bM\s?\d{2,3}\b/g, '—').replace(/\bFe\s?\d{3}\b/gi, '—')
    // "about 30%"
    v = v.replace(/\b\d+(\.\d+)?\s?%/g, '—')
    // "grade 40", "class 2"
    v = v.replace(/\b(grade|class)\s+\d+\b/gi, '$1 —')
    return v.trim()
  }

  const description = scrub(out.description)
  const concerns = (Array.isArray(out.concerns) ? out.concerns : [])
    .slice(0, 5)
    .map((c) => ({
      concern: scrub(c?.concern),
      what_to_check: scrub(c?.what_to_check),
    }))
    .filter((c) => c.concern !== '')

  // ---- 6. Store it, as the caller ----
  const { data: row, error: insErr } = await asCaller
    .from('photo_analyses')
    .insert({
      project_id: projectId,
      photo_path: photoPath,
      bucket: 'site-photos',
      source: body.source ?? 'other',
      site_log_id: body.site_log_id ?? null,
      snag_id: body.snag_id ?? null,
      comment_id: body.comment_id ?? null,
      description,
      concerns,
      model: MODEL,
    })
    .select('id')
    .single()

  if (insErr) {
    // The unique index on photo_path is the likely one: somebody tapped twice,
    // or two people opened the same photo. Say which, rather than leaking a
    // constraint name at a site engineer.
    const dup = (insErr.message ?? '').includes('photo_analysis_path_uk')
    return json(
      {
        error: dup
          ? 'This photo has already been analysed. Reload to see the existing suggestion.'
          : `Could not save the analysis: ${insErr.message}`,
      },
      dup ? 409 : 500,
    )
  }

  return json({
    id: row.id,
    description,
    concerns,
    nothing_notable: Boolean(out.nothing_notable) || concerns.length === 0,
    model: MODEL,
  })
})
