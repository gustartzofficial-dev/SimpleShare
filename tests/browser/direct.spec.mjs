import { test, expect } from '@playwright/test';
const room = 'abcdef1234567890abcdef12';
function broker() {
  const clients = new Map();
  return (socket) => {
    clients.set(socket, new Set());
    socket.onMessage((message) => {
      const packet = Buffer.from(message);
      let offset = 1,
        length = 0,
        multiplier = 1,
        byte;
      do {
        byte = packet[offset++];
        length += (byte & 127) * multiplier;
        multiplier *= 128;
      } while (byte & 128);
      const body = packet.subarray(offset, offset + length),
        type = packet[0] >> 4;
      if (type === 1) {
        socket.send(Buffer.from([32, 2, 0, 0]));
        return;
      }
      if (type === 8) {
        const size = body.readUInt16BE(2);
        clients.get(socket).add(body.subarray(4, 4 + size).toString());
        socket.send(Buffer.from([144, 3, body[0], body[1], 0]));
        return;
      }
      if (type === 3) {
        const size = body.readUInt16BE(0),
          topic = body.subarray(2, 2 + size).toString();
        for (const [peer, topics] of clients) if (topics.has(topic)) peer.send(packet);
        return;
      }
      if (type === 12) socket.send(Buffer.from([208, 0]));
    });
    socket.onClose(() => clients.delete(socket));
  };
}
test('two direct-room browsers exchange real video and stop cleanly', async ({ browser }, info) => {
  test.setTimeout(60000);
  const senderContext = await browser.newContext(),
    viewerContext = await browser.newContext();
  const sender = await senderContext.newPage(),
    viewer = await viewerContext.newPage();
  const route = broker();
  for (const page of [sender, viewer]) {
    await page.routeWebSocket(/broker\.emqx|broker\.hivemq|test\.mosquitto/, route);
    await page.addInitScript(() => {
      const Original = RTCPeerConnection;
      window.RTCPeerConnection = class extends Original {
        constructor(configuration) {
          super({ ...configuration, iceServers: [] });
        }
      };
    });
  }
  await sender.addInitScript(() => {
    localStorage.setItem('simpleshare-name', 'Alex');
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#d76b45';
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff';
        ctx.font = '36px sans-serif';
        ctx.fillText('Actual test video', 60, 180);
        const stream = canvas.captureStream(15);
        window.testCapturedTrack = stream.getVideoTracks()[0];
        setInterval(() => {
          ctx.fillStyle = '#d76b45';
          ctx.fillRect(0, 320, 640, 40);
          ctx.fillStyle = '#fff';
          ctx.fillText(String(Date.now()), 60, 350);
        }, 100);
        return stream;
      },
    });
  });
  await viewer.addInitScript(() => localStorage.setItem('simpleshare-name', 'Jules'));
  try {
    await sender.goto('/?room=' + room + '&p2p=1');
    await viewer.goto('/?room=' + room + '&p2p=1');
    await expect(sender.locator('#peopleCount')).toHaveText('2');
    await expect(viewer.locator('#peopleCount')).toHaveText('2');
    await sender.locator('#shareBtn').click();
    await expect(sender.locator('#stopBtn')).toBeVisible();
    await viewer.getByRole('button', { name: 'Watch Stream', exact: true }).click();
    await expect
      .poll(() => viewer.locator('.tile video').evaluate((video) => video.videoWidth), {
        timeout: 20000,
      })
      .toBe(640);
    await expect(viewer.locator('.tile-name')).toHaveText('Alex');
    await viewer.screenshot({
      path: `work/qa/direct-video-${info.project.name}.png`,
      animations: 'disabled',
    });
    await sender.locator('#stopBtn').click();
    await expect(viewer.locator('#streamCount')).toHaveText('0');
    expect(await sender.evaluate(() => window.testCapturedTrack.readyState)).toBe('ended');
    await sender.locator('#leaveDockBtn').click();
    await expect(sender).toHaveURL('http://127.0.0.1:4173/');
    await expect(viewer.locator('#peopleCount')).toHaveText('1');
  } finally {
    await senderContext.close();
    await viewerContext.close();
  }
});
