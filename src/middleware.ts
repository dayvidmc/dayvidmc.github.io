import { NextResponse, type NextRequest } from 'next/server';

/**
 * Put the path on the request, where a server layout can read it.
 *
 * A layout in the App Router is not told which page it is wrapping. That was
 * fine while the staff menu was a dropdown with no "you are here" marker
 * (§2.65) — the page's own heading said where you were, and adding middleware
 * for a nicety was not worth it.
 *
 * A sidebar changes that. A permanent list of thirty destinations with nothing
 * marking the current one is worse than a dropdown: it shows you everything
 * except the one thing you need, which is where you are. So the trade has
 * turned over, and this is the cheapest way to turn it.
 *
 * The matcher keeps this off static assets and the API. It runs on page
 * requests only, and all it does is copy a string.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    /*
     * Everything except:
     *   api            — no layout, no need
     *   _next/*        — the build output
     *   *.svg|png|ico  — files served straight from disk
     */
    '/((?!api|_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|ico|webp)$).*)',
  ],
};
