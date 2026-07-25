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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  // ---- 2. Validate input ----
  let body: {
    email?: string
    password?: string
    full_name?: string
    phone?: string
    role?: string
    designation?: string
    project_ids?: string[]
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
  const validRoles = ['founder', 'pm', 'supervisor', 'accounts']

  if (!email || !email.includes('@')) return json({ error: 'A valid email is required' }, 400)
  if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400)
  if (!fullName) return json({ error: 'Full name is required' }, 400)
  if (!validRoles.includes(role)) return json({ error: 'Unknown access role' }, 400)

  // ---- 3. Create — service role, only now that the founder check passed ----
  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // internal tool — no confirmation round-trip
    user_metadata: { full_name: fullName },
  })

  if (createErr || !created.user) {
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
    })
    .eq('id', newId)

  if (profErr) {
    // Roll back the auth user so a failed profile doesn't leave an orphan login.
    await admin.auth.admin.deleteUser(newId)
    return json({ error: `Profile setup failed: ${profErr.message}` }, 400)
  }

  // ---- 4. Project assignments ----
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

  return json({ id: newId, email, full_name: fullName, role }, 200)
})
