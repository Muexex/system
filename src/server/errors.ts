export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 400, code = 'INVALID_INPUT') {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}
export function fail(message: string, status = 400, code = 'INVALID_INPUT'): never {
  throw new DomainError(message, status, code);
}
