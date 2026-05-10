/**
 * Build the URL that an unauthenticated visitor should be sent to so they can
 * sign in and bounce back to the page they came from.
 *
 * Always points at `/signin` — never `/`. The homepage is a marketing landing
 * for logged-out visitors and does not host the login form, so a `/?redirect=`
 * URL strands the user there with no path back to the original flow (notably
 * the bookmarklet/share `/save` popup).
 */
export function buildLoginRedirectUrl(
  pathname: string,
  search: string,
): string {
  return `/signin?redirect=${encodeURIComponent(pathname + search)}`;
}
