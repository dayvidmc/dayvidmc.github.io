import { headers } from 'next/headers';

/**
 * Where this site is actually reachable, according to the request.
 *
 * Needed wherever an absolute URL leaves the building — a payment provider's
 * return address, a link in an email — because a relative path is no use in
 * either place, and a hard-coded one is wrong in every environment but the one
 * it was written in.
 *
 * `x-forwarded-host` first because everything here runs behind a proxy: `host`
 * alone gives the container's internal name, which is how a payment provider
 * ends up redirecting a coach to localhost.
 *
 * Returns an empty string when there is no request context to read, and every
 * caller treats that as "queue it without a link" rather than inventing one.
 */
export async function requestOrigin(): Promise<string> {
  try {
    const headerList = await headers();
    const host = headerList.get('x-forwarded-host') ?? headerList.get('host') ?? '';
    if (!host) return '';
    const proto = headerList.get('x-forwarded-proto') ?? 'https';
    return `${proto}://${host}`;
  } catch {
    return '';
  }
}
