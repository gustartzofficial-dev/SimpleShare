import { adminHtml, adminCss, adminScript } from './admin-page.js';

const headers = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const response = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8', ...extra },
  });
const cookieName = 'ss_admin';
const sessionCookie = (token, secure, age = 7200) =>
  `${cookieName}=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;

export async function handleAdmin(request, env, stub, readJson) {
  const url = new URL(request.url);
  const secure = url.protocol === 'https:';
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    return response({ error: 'HTTPS required.' }, 403);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin)
    return response({ error: 'Admin requests must come from this origin.' }, 403);
  if (request.method === 'GET') {
    const asset = {
      '/admin': [adminHtml, 'text/html'],
      '/admin/': [adminHtml, 'text/html'],
      '/admin/app.js': [adminScript, 'text/javascript'],
      '/admin/styles.css': [adminCss, 'text/css'],
    }[url.pathname];
    if (asset)
      return new Response(asset[0], {
        headers: { ...headers, 'content-type': asset[1] + '; charset=utf-8' },
      });
  }
  if (!url.pathname.startsWith('/admin/api/')) return response({ error: 'Not found.' }, 404);
  if (!['GET', 'POST'].includes(request.method))
    return response({ error: 'Method not allowed.' }, 405);
  if (
    request.method === 'POST' &&
    (origin !== url.origin ||
      request.headers.get('x-admin-action') !== '1' ||
      !request.headers.get('content-type')?.startsWith('application/json'))
  )
    return response({ error: 'Invalid admin request.' }, 403);
  const call = (path, body) =>
    stub.fetch('https://budget' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    if (Number(request.headers.get('content-length') || 0) > 65536)
      return response({ error: 'Request too large.' }, 413);
    const body = request.method === 'POST' ? await readJson(request) : {};
    if (url.pathname === '/admin/api/login' && request.method === 'POST') {
      if (typeof body.password !== 'string' || body.password.length > 1024)
        return response({ error: 'Enter your admin password.' }, 400);
      const result = await call('/admin/login', {
        password: body.password,
        ip: request.headers.get('cf-connecting-ip') || 'local',
      });
      const auth = await result.json();
      return result.ok
        ? response({ ok: true, expiresAt: auth.expiresAt }, 200, {
            'set-cookie': sessionCookie(auth.token, secure),
          })
        : response(auth, result.status);
    }
    const token =
      (request.headers.get('cookie') || '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(cookieName + '='))
        ?.slice(cookieName.length + 1) || '';
    const auth = await call('/admin/authorize', { token });
    if (!auth.ok)
      return response(await auth.json(), auth.status, {
        'set-cookie': sessionCookie('', secure, 0),
      });
    const route = {
      'GET /admin/api/status': '/admin/status',
      'POST /admin/api/reset': '/reset',
      'POST /admin/api/settings': '/settings',
      'POST /admin/api/announcement': '/announcement',
      'POST /admin/api/clear-announcement': '/clear-announcement',
      'POST /admin/api/logout': '/admin/logout',
    }[request.method + ' ' + url.pathname];
    if (!route) return response({ error: 'Not found.' }, 404);
    const result = await call(route, route === '/admin/logout' ? { token } : body);
    return response(
      await result.json(),
      result.status,
      route === '/admin/logout' ? { 'set-cookie': sessionCookie('', secure, 0) } : {},
    );
  } catch (error) {
    return response(
      { error: error.status ? error.message : 'The admin service is unavailable. Try again.' },
      error.status || 503,
    );
  }
}
