/**
 * The origin a request was made to, as the caller saw it.
 *
 * An A2A agent card carries an absolute `url`, so Kawal has to know its own
 * address at request time. Behind a proxy or a platform edge the request's
 * own URL says `http://localhost:3000`, and the forwarded headers say what
 * the outside world typed. The forwarded values win when present.
 *
 * The host is validated rather than trusted: it goes verbatim into a document
 * other agents will dial, and a forged header must not be able to point them
 * somewhere else.
 */
export function originOf(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();

  const host =
    forwardedHost && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(forwardedHost) ? forwardedHost : url.host;
  const proto = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : url.protocol.replace(":", "");

  return `${proto}://${host}`;
}
