export async function boundedMediaFetch(
  url,
  init = {},
  { timeout = 10000, fetchImpl = fetch } = {},
) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...init, signal: controller.signal });
        const body = await response.arrayBuffer();
        return new Response(body, { status: response.status, headers: response.headers });
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Media upstream timed out'));
        }, timeout);
      }),
    ]);
  } catch (error) {
    return Response.json(
      {
        errorCode: 'upstream_unavailable',
        errorDescription: controller.signal.aborted
          ? 'Cloudflare media service timed out.'
          : 'Cloudflare media service is temporarily unavailable.',
      },
      { status: controller.signal.aborted ? 504 : 502 },
    );
  } finally {
    clearTimeout(timer);
  }
}
