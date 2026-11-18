// The one user of the global fetch in server code. Every HTTP call made with
// fetch goes through fetchWithin, which takes a deadline that covers the
// whole call. Without one, Node's fetch waits minutes for a server that
// stalls, and a request that awaits the call stays open as long (hunt
// 261117-0852-025).
//
// A client with its own HTTP stack, such as an SDK, has one owner module
// instead, and that module's call sets its own deadline.
// server/parser-owners.test.ts holds both rules, and
// docs/agents/requests-and-responses.md#calls-to-other-services says how to
// add a call.

/**
 * Calls fetch and aborts the request once timeoutMs has passed, or when
 * init.signal aborts. The deadline covers connecting, the headers and reading
 * the body, so a caller that reads the body after this resolves is bounded
 * too. At the deadline the call, or the body read, rejects with a
 * DOMException named TimeoutError.
 */
export function fetchWithin(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadline])
    : deadline;
  return fetch(input, { ...init, signal });
}
