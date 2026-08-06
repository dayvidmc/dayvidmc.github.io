import { headers } from 'next/headers';

/**
 * The path being rendered, from the header the middleware sets.
 *
 * Returns an empty string when there is no request to read — a build-time
 * prerender, say — and every caller treats that as "mark nothing", which is
 * the right answer when there is no current page to be on.
 */
export async function currentPath(): Promise<string> {
  try {
    return (await headers()).get('x-pathname') ?? '';
  } catch {
    return '';
  }
}

/** Whether this path belongs to the tool rather than the public website. */
export function isStaffPath(path: string): boolean {
  return path === '/hq' || path.startsWith('/hq/') || path === '/pos' || path.startsWith('/pos/');
}
