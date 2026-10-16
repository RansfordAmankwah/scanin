/**
 * Face capture lives behind this interface so a native capture (or a hardened liveness flow in a
 * later phase) can replace it without touching the enrollment screen. No face computation happens in
 * the browser: this only grabs frames and hands them to the server, which calls the verifier.
 */
export type CaptureFrames = () => Promise<string[]>;

export class CaptureError extends Error {
  constructor(readonly code: 'NO_CAMERA' | 'DENIED' | 'FAILED') {
    super(code);
  }
}

/** The default browser capture: a few frames from the front camera over getUserMedia (HTTPS only). */
export const browserCapture: CaptureFrames = async () => {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) throw new CaptureError('NO_CAMERA');
  let stream: MediaStream;
  try {
    stream = await media.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  } catch {
    throw new CaptureError('DENIED');
  }
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new CaptureError('FAILED');
    const frames: string[] = [];
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 200));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.6));
    }
    return frames;
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
};
