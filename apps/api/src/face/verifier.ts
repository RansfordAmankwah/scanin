/**
 * The face verifier boundary. All biometric computation lives behind this interface, so no raw frame
 * ever reaches the database, the logs or the rest of the app. We build against it, provide a
 * deterministic fake for development and tests, and a production stub that refuses until a real
 * vendor is integrated. Select with FACE_VERIFIER.
 *
 *   enroll(frames)                      -> { templateRef }
 *   verify(templateRef, frames, challenge) -> { liveness, matchScore, modelVersion }
 *   deleteTemplate(templateRef)         -> void
 *
 * `frames` are opaque capture blobs held only in memory for the duration of the call.
 */
export type Liveness = 'PASS' | 'FAIL';

export interface EnrollResult {
  templateRef: string;
}
export interface VerifyResult {
  liveness: Liveness;
  matchScore: number;
  modelVersion: string;
}

export interface FaceVerifier {
  /** The model version in force, recorded with an enrollment and each check. */
  readonly modelVersion: string;
  enroll(frames: string[]): Promise<EnrollResult>;
  verify(templateRef: string, frames: string[], challenge: string): Promise<VerifyResult>;
  deleteTemplate(templateRef: string): Promise<void>;
}

export type FaceVerifierErrorCode = 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'BAD_FRAMES';

/** A failure from the verifier itself (outage, missing config), distinct from a normal FAIL result. */
export class FaceVerifierError extends Error {
  constructor(
    readonly code: FaceVerifierErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FaceVerifierError';
  }
}

// -------------------------------------------------------------------------------------------------
// Fake verifier: deterministic, driven entirely by the frames the test supplies. A frame is a plain
// string carrying directives, so a fixture decides every outcome without any real image processing.
//
//   "subject:alice"   the identity captured (enrolment records it; a check matches against it)
//   "live:false"      the capture is not live (a check returns liveness FAIL)
//   "score:0.42"      force an exact match score (otherwise 1.0 on a match, 0.0 otherwise)
//   "outage"          the verifier is unavailable (throws UNAVAILABLE), to exercise the fallback
//   "undeletable"     deleteTemplate fails for this template, to exercise the deletion retry
// -------------------------------------------------------------------------------------------------
const directive = (frames: string[], key: string): string | undefined => {
  const prefix = `${key}:`;
  for (const f of frames) if (f.startsWith(prefix)) return f.slice(prefix.length);
  return undefined;
};
const subjectOf = (frames: string[]): string => directive(frames, 'subject') ?? 'unknown';

export class FakeFaceVerifier implements FaceVerifier {
  readonly modelVersion = 'fake-1.0';
  /** Templates handed out but not yet deleted, so tests can assert deletion actually happened. */
  readonly live = new Set<string>();

  async enroll(frames: string[]): Promise<EnrollResult> {
    if (frames.length === 0) throw new FaceVerifierError('BAD_FRAMES', 'No frames supplied.');
    if (frames.includes('outage')) throw new FaceVerifierError('UNAVAILABLE', 'Verifier is down.');
    const templateRef = `fake-template:${subjectOf(frames)}`;
    this.live.add(templateRef);
    return { templateRef };
  }

  async verify(templateRef: string, frames: string[], _challenge: string): Promise<VerifyResult> {
    if (frames.includes('outage')) throw new FaceVerifierError('UNAVAILABLE', 'Verifier is down.');
    const liveness: Liveness = directive(frames, 'live') === 'false' ? 'FAIL' : 'PASS';
    const forced = directive(frames, 'score');
    const matches = templateRef === `fake-template:${subjectOf(frames)}`;
    const matchScore = forced !== undefined ? Number(forced) : matches ? 1 : 0;
    return { liveness, matchScore, modelVersion: this.modelVersion };
  }

  async deleteTemplate(templateRef: string): Promise<void> {
    if (templateRef.includes('undeletable'))
      throw new FaceVerifierError('UNAVAILABLE', 'Vendor could not delete the template.');
    this.live.delete(templateRef);
  }
}

// -------------------------------------------------------------------------------------------------
// Production stub: no real vendor is integrated yet, so every call refuses loudly. This keeps the
// pilot from silently "working" against nothing.
// -------------------------------------------------------------------------------------------------
export class ProductionFaceVerifier implements FaceVerifier {
  readonly modelVersion = 'unconfigured';
  private refuse(): never {
    throw new FaceVerifierError(
      'NOT_CONFIGURED',
      'No face-verification vendor is configured for this deployment.',
    );
  }
  async enroll(): Promise<EnrollResult> {
    return this.refuse();
  }
  async verify(): Promise<VerifyResult> {
    return this.refuse();
  }
  async deleteTemplate(): Promise<void> {
    return this.refuse();
  }
}

export function createFaceVerifier(kind: 'fake' | 'production'): FaceVerifier {
  return kind === 'fake' ? new FakeFaceVerifier() : new ProductionFaceVerifier();
}
