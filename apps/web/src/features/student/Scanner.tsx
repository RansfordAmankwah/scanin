import QrScanner from 'qr-scanner';
import { useEffect, useRef } from 'react';

export type CameraProblem = 'denied' | 'unavailable';

/**
 * Live camera view that reports each decoded QR value. Reports a camera problem instead of
 * throwing. Camera access needs HTTPS (or localhost) and a user-granted permission.
 */
export function Scanner({
  onDecode,
  onProblem,
}: {
  onDecode: (text: string) => void;
  onProblem: (problem: CameraProblem) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  // Latest callbacks without restarting the camera on every render.
  const handlers = useRef({ onDecode, onProblem });
  handlers.current = { onDecode, onProblem };

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let stopped = false;
    const scanner = new QrScanner(
      el,
      (result) => {
        if (!stopped) handlers.current.onDecode(result.data);
      },
      {
        preferredCamera: 'environment',
        maxScansPerSecond: 5,
        returnDetailedScanResult: true,
        highlightScanRegion: true,
      },
    );
    scanner.start().catch((err: unknown) => {
      if (stopped) return;
      const name = err instanceof Error ? err.name : '';
      const message = typeof err === 'string' ? err : err instanceof Error ? err.message : '';
      const denied =
        name === 'NotAllowedError' ||
        name === 'SecurityError' ||
        /denied|permission/i.test(message);
      handlers.current.onProblem(denied ? 'denied' : 'unavailable');
    });
    return () => {
      stopped = true;
      scanner.stop();
      scanner.destroy();
    };
  }, []);

  return (
    <div className="scanner">
      <video
        ref={video}
        aria-label="Camera view for scanning the class QR code"
        muted
        playsInline
      />
    </div>
  );
}
