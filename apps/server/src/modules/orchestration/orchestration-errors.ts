/**
 * Status-carrying error for the orchestration module.
 *
 * Same shape QaRunService / ActionsService use (a plain Error with a `status`
 * field) rather than a NestJS HttpException, because these services are called
 * from BOTH the REST controller (which maps `status` onto the response) and the
 * MCP tool layer (which turns the message into an `err()` payload and must not
 * have a NestJS exception escape into the MCP transport).
 */
export function orchestrationError(status: number, message: string): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}
