import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHANNEL =
  process.env.PLAYWRIGHT_CHANNEL === 'chromium'
    ? undefined
    : (process.env.PLAYWRIGHT_CHANNEL ?? 'msedge');

/**
 * Turns the QR image shown on the lecturer's projector page into a short MJPEG video, drawn the way
 * a phone camera would see it (centred on a white wall, framed within the scan area).
 */
export async function qrVideoFromProjector(projector: Page): Promise<string> {
  const src = await projector.getByRole('img', { name: /QR code/i }).getAttribute('src');
  if (!src?.startsWith('data:image/png')) throw new Error('projector QR is not an image');
  const jpegBase64 = await projector.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 640, 480);
    g.imageSmoothingEnabled = false;
    const size = 300; // inside the scanner's central 2/3 scan region, as a student would frame it
    g.drawImage(img, (640 - size) / 2, (480 - size) / 2, size, size);
    return canvas.toDataURL('image/jpeg', 0.95).split(',')[1]!;
  }, src);

  const frame = Buffer.from(jpegBase64, 'base64');
  const file = join(mkdtempSync(join(tmpdir(), 'scanin-camera-')), 'qr.mjpeg');
  writeFileSync(file, Buffer.concat(Array.from({ length: 60 }, () => frame))); // MJPEG is just JPEGs back to back
  return file;
}

/** A browser whose "camera" plays the given video file and whose permission prompt is auto-accepted. */
export function launchWithFakeCamera(videoFile: string): Promise<Browser> {
  return chromium.launch({
    channel: CHANNEL,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${videoFile}`,
    ],
  });
}
