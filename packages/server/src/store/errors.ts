export type StoreErrorCode =
  | 'not_found'
  | 'invalid'
  | 'not_draft'
  | 'already_sent'
  | 'stale_tip'
  | 'attached_elsewhere'
  | 'detached'
  | 'too_many_sessions';

const httpStatusByCode: Record<StoreErrorCode, 400 | 404 | 409 | 503> = {
  not_found: 404,
  invalid: 400,
  not_draft: 409,
  already_sent: 409,
  stale_tip: 409,
  attached_elsewhere: 409,
  detached: 409,
  too_many_sessions: 503,
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
