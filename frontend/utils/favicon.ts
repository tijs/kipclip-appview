/**
 * Returns a reliable favicon URL using Google's favicon proxy.
 * The proxy always returns a valid image (default globe for unknown domains),
 * avoiding 404s, CORS errors, and mixed-content warnings from direct favicon URLs.
 */
export function faviconUrl(bookmarkUrl: string): string {
  try {
    const { hostname } = new URL(bookmarkUrl);
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return "";
  }
}
