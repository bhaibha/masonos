// ============================================================
// MASON OS — admin-create-user Edge Function
//
// Creates a login account + profile. The service-role key lives ONLY here,
// server-side (CLAUDE.md rule 1: never in frontend code).
//
// Security: the caller's JWT is verified and their profile role is checked —
// only a founder can create users. The service-role client is used solely
// AFTER that check passes.
//
// Deploy:
//   supabase functions deploy admin-create-user
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // ---- 1. Who is calling? ----
  const authHeader = req.headers.get('Authorization') ?? ''
  if (!authHeader.startsWith('Bearer ')) {
    return json({ error: 'Missing authorization' }, 401)
  }

  // A client bound to the CALLER's token — RLS applies, so this can only read
  // what they're allowed to read.
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

  if (!me || me.role !== 'founder') {
    return json({ error: 'Only the founder can create users' }, 403)
  }

  // Stamped on client_projects.granted_by below. Letting a client in is a
  // commercial act, so it records who did it.
  const callerId = userData.user.id

  // ---- 2. Validate input ----
  let body: {
    email?: string
    password?: string
    full_name?: string
    phone?: string
    role?: string
    designation?: string
    project_ids?: string[]
    /**
     * CLIENT ACCOUNTS ONLY. The single project this client may see.
     * `client_projects.user_id` is UNIQUE (065), so a client account belongs to
     * exactly one project and this is a scalar, not the `project_ids` array
     * that staff assignments use. Two different shapes on purpose: they are
     * different relationships, and collapsing them into one field is how an
     * outsider eventually ends up on two jobs.
     */
    client_project_id?: string
    /**
     * 'direct' (default) — create with the password the founder typed. Works
     *   today, needs no email, and sets must_change_password so that shared
     *   secret survives exactly one sign-in (077).
     * 'invite'  — send an invitation; the person chooses their own password and
     *   nobody at the firm ever knows it. Requires custom SMTP on the Supabase
     *   project, or the send fails and this returns the reason.
     */
    mode?: 'direct' | 'invite'
    /** Where the invite link lands. Always the app's /set-password. */
    redirect_to?: string
  }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const email = (body.email ?? '').trim().toLowerCase()
  const password = body.password ?? ''
  const fullName = (body.full_name ?? '').trim()
  const role = body.role ?? 'supervisor'
  const validRoles = ['founder', 'pm', 'supervisor', 'accounts', 'client']
  const isClient = role === 'client'
  const mode = body.mode === 'invite' ? 'invite' : 'direct'

  if (!email || !email.includes('@')) return json({ error: 'A valid email is required' }, 400)
  // Only the direct path needs a password — an invited user chooses their own,
  // and demanding one here would mean inventing a secret nobody uses.
  if (mode === 'direct' && password.length < 8) {
    return json({ error: 'Password must be at least 8 characters' }, 400)
  }
  if (!fullName) return json({ error: 'Full name is required' }, 400)
  if (!validRoles.includes(role)) return json({ error: 'Unknown access role' }, 400)

  // A client with no project is the "Your account is not linked to a project
  // yet" dead end. Refuse it here rather than create half an account: the check
  // is cheap and the half-created state needs SQL to repair.
  if (isClient && !body.client_project_id) {
    return json({ error: 'A client account must be linked to a project' }, 400)
  }
  // And the reverse — a staff role must never arrive carrying a client link.
  if (!isClient && body.client_project_id) {
    return json({ error: 'Only a client account takes a project link' }, 400)
  }
  // A client is an outsider, not a job title. `designation` maps titles to
  // access roles for STAFF (019) and must never become load-bearing for an
  // audience outside the firm — the 043 rule.
  if (isClient && body.designation) {
    return json({ error: 'A client account has no job title' }, 400)
  }
  // Portal access is a commercial act: only a founder grants it. The caller is
  // already known to be a founder by this point, but stating it here keeps the
  // rule next to the branch it governs.
  if (isClient && Array.isArray(body.project_ids) && body.project_ids.length > 0) {
    return json({ error: 'A client is never a project member' }, 400)
  }

  // ---- 3. Create — service role, only now that the founder check passed ----
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // TWO WAYS IN, ONE ACCOUNT SHAPE. Whichever path runs, what comes out is the
  // same auth user + profile + links, so nothing downstream has to care which
  // was used.
  let created:
    | { user: { id: string } | null }
    | null = null
  let createErr: { message: string } | null = null

  if (mode === 'invite') {
    const res = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo: body.redirect_to,
    })
    created = res.data
    createErr = res.error
    // The single most likely failure, and the message Supabase gives for it is
    // not obvious. Say what to do about it.
    if (createErr && /smtp|not authorized|rate/i.test(createErr.message)) {
      return json(
        {
          error:
            'The invitation could not be sent. Supabase only emails members of ' +
            'the project team until custom SMTP is configured. Use "Set a ' +
            'password" instead, or configure SMTP first. (' +
            createErr.message + ')',
        },
        400,
      )
    }
  } else {
    const res = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // internal tool — no confirmation round-trip
      user_metadata: { full_name: fullName },
    })
    created = res.data
    createErr = res.error
  }

  if (createErr || !created?.user) {
    return json({ error: createErr?.message ?? 'Could not create the account' }, 400)
  }

  const newId = created.user.id

  // The handle_new_user trigger (001_core.sql) already inserted a profile row
  // with the default role. Update it with the real details.
  const { error: profErr } = await admin
    .from('profiles')
    .update({
      full_name: fullName,
      phone: body.phone?.trim() || null,
      role,
      designation: body.designation?.trim() || null,
      is_active: true,
      // 077. A password somebody else chose is a shared secret and must survive
      // exactly one sign-in. An INVITED user picks their own, so there is
      // nothing to force.
      must_change_password: mode === 'direct',
    })
    .eq('id', newId)

  if (profErr) {
    // Roll back the auth user so a failed profile doesn't leave an orphan login.
    await admin.auth.admin.deleteUser(newId)
    return json({ error: `Profile setup failed: ${profErr.message}` }, 400)
  }

  // ---- 4a. Client: link to the one project, or undo the whole thing ----
  // An auth login that can sign in but reaches no project is worse than no
  // account: it looks broken to the client and needs SQL to repair. So a failed
  // link deletes the user, which cascades the profile row (001).
  if (isClient) {
    const { error: linkErr } = await admin
      .from('client_projects')
      .insert({
        user_id: newId,
        project_id: body.client_project_id,
        granted_by: callerId,
      })

    if (linkErr) {
      await admin.auth.admin.deleteUser(newId)
      return json({ error: `Portal access failed: ${linkErr.message}` }, 400)
    }

    return json({ id: newId, email, full_name: fullName, role, mode }, 200)
  }

  // ---- 4b. Staff project assignments ----
  const projectIds = Array.isArray(body.project_ids) ? body.project_ids : []
  if (projectIds.length > 0) {
    const rows = projectIds.map((pid) => ({ project_id: pid, user_id: newId }))
    const { error: memErr } = await admin
      .from('project_members')
      .upsert(rows, { onConflict: 'project_id,user_id' })
    if (memErr) {
      return json(
        { id: newId, warning: `User created, but project assignment failed: ${memErr.message}` },
        200,
      )
    }
  }

  return json({ id: newId, email, full_name: fullName, role, mode }, 200)
})
