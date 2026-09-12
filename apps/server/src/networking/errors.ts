export type ErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_PORT"
  | "RESERVED_PORT"
  | "HARDWARE_UNAVAILABLE"
  | "HARDWARE_WRITE_FAILED"
  | "STATE_DIVERGED"
  | "UNKNOWN_CLIENT"
  | "STALE_LEASE"
  | "NO_AP_CAPACITY"
  | "VALIDATION_ERROR";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly statusCode = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
