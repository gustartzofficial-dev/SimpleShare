const SESSION_MS = 2 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, '0')).join('');
const digest = async (value) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
const equal = (a, b) => {
  let difference = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return difference === 0;
};

export async function adminAuth(storage, env, path, body) {
  const password = String(env.ADMIN_PASSWORD || '');
  if (password.length < 20)
    return reply(
      {
        error:
          'Admin access is disabled. Set an ADMIN_PASSWORD Worker secret of at least 20 characters.',
      },
      503,
    );
  const now = Date.now();
  const fingerprint = await digest(password);
  const state = (await storage.get('admin-auth')) || { sessions: [], attempts: {} };
  state.sessions = state.sessions.filter(
    (session) => session.expiresAt > now && session.fingerprint === fingerprint,
  );
  for (const [ip, attempt] of Object.entries(state.attempts))
    if (attempt.until <= now) delete state.attempts[ip];
  if (path === '/admin/login') {
    const ip = await digest(String(body.ip || 'unknown'));
    const attempt = state.attempts[ip];
    if (attempt?.count >= 5)
      return reply({ error: 'Too many login attempts. Try again in 15 minutes.' }, 429);
    // Bound persisted state and password work even when source IPs vary.
    const total = Object.values(state.attempts).reduce((sum, item) => sum + item.count, 0);
    if (total >= 200)
      return reply({ error: 'Admin login is temporarily rate limited. Try again later.' }, 429);
    if (!equal(await digest(String(body.password || '')), fingerprint)) {
      state.attempts[ip] = {
        count: (attempt?.count || 0) + 1,
        until: attempt?.until || now + ATTEMPT_WINDOW_MS,
      };
      await storage.put('admin-auth', state);
      return reply({ error: 'Incorrect password.' }, 401);
    }
    delete state.attempts[ip];
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = now + SESSION_MS;
    state.sessions = state.sessions.slice(-19);
    state.sessions.push({ hash: await digest(token), fingerprint, expiresAt });
    await storage.put('admin-auth', state);
    return reply({ token, expiresAt });
  }
  const hash = await digest(String(body.token || ''));
  const session = state.sessions.find((item) => equal(item.hash, hash));
  if (!session) return reply({ error: 'Sign in to continue.' }, 401);
  if (path === '/admin/logout') {
    state.sessions = state.sessions.filter((item) => item !== session);
    await storage.put('admin-auth', state);
  }
  return reply({ ok: true, expiresAt: session.expiresAt });
}
