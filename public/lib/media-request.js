export class MediaRequestError extends Error {
  constructor(message, { status = 0, code = '', retryable = true, sessionSafe = false } = {}) {
    super(message);
    this.name = 'MediaRequestError';
    Object.assign(this, { status, code, retryable, sessionSafe });
  }
}
export async function requestMedia(path, init = {}, { timeout = 12000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) abort();
  else init.signal?.addEventListener('abort', abort, { once: true });
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(path, { ...init, signal: controller.signal });
        let body;
        try {
          body = JSON.parse(await response.clone().text());
        } catch (error) {
          throw new MediaRequestError('Media service returned an invalid response', {
            status: response.status,
          });
        }
        if (!response.ok || body.errorCode || body.error) {
          const code = body.errorCode || body.code || '';
          const terminal =
            [400, 401, 403, 404, 429].includes(response.status) || body.budgetBlocked;
          throw new MediaRequestError(
            body.errorDescription || body.error || 'Media request failed (' + response.status + ')',
            {
              status: response.status,
              code,
              retryable: !terminal,
              sessionSafe: [400, 401, 403, 404, 429].includes(response.status),
            },
          );
        }
        return { response, body };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new MediaRequestError('Media request timed out'));
        }, timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', abort);
  }
}
export function serialUpdates() {
  let tail = Promise.resolve();
  return (update) => {
    const result = tail.then(update);
    tail = result.catch(() => {});
    return result;
  };
}
