export type StoreErrorCode =
  | 'not_found'
  | 'invalid'
  | 'not_draft'
  | 'already_sent'
  | 'stale_tip'
  | 'stale_lease'
  | 'attached_elsewhere'
  | 'detached'
  | 'too_many_sessions'
  | 'archived'
  | 'cancelled'
  | 'dictation_unavailable'
  | 'invalid_audio'
  | 'transcription_failed'
  | 'transcription_timeout'
  | 'speech_unavailable'
  | 'speech_failed'
  | 'too_large'
  | 'unsupported_file';

const httpStatusByCode: Record<StoreErrorCode, 400 | 404 | 409 | 413 | 415 | 500 | 503 | 504> = {
  not_found: 404,
  invalid: 400,
  not_draft: 409,
  already_sent: 409,
  stale_tip: 409,
  stale_lease: 409,
  attached_elsewhere: 409,
  detached: 409,
  too_many_sessions: 503,
  archived: 409,
  cancelled: 409,
  dictation_unavailable: 503,
  invalid_audio: 400,
  transcription_failed: 500,
  transcription_timeout: 504,
  speech_unavailable: 503,
  speech_failed: 500,
  too_large: 413,
  unsupported_file: 415,
};

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
  }

  get httpStatus() {
    return httpStatusByCode[this.code];
  }
}
