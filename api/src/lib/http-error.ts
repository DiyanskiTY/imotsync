/** An error that maps directly to an HTTP response: {"error":{"code","message"}}. */
export class HttpError extends Error {
  override readonly name = 'HttpError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
