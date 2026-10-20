/**
 * HTTP status for a Runtime Host reverse RPC (sessions, terminals) that did not succeed.
 *
 * 502/504 would be the textbook codes — AWB is a gateway to the host — but AWB is served
 * behind Cloudflare, which replaces an origin's 502/504 with its own HTML error page. The
 * JSON reason then never reaches the screen: the new-session dialog showed only
 * "Request failed" while the manager had answered "The repository is on <branch> with
 * local changes …" (2026-10-20). So the reason travels on codes Cloudflare passes through.
 */
/** The host answered, and the answer is a failure with a reason (`message`). */
export const HOST_RPC_FAILED_STATUS = 422;
/** The host did not answer in time. */
export const HOST_RPC_TIMEOUT_STATUS = 503;
