/**
 * Centralized API client with automatic 401 handling
 * When a 401 response is received, the session is cleared and the user is redirected to login
 */

/**
 * Enhanced fetch that handles 401 responses automatically
 * Clears local session state and reloads the page to trigger login flow
 */
export async function apiFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const response = await fetch(url, options);

  // If we get a 401, the session has expired
  if (response.status === 401) {
    console.warn("Session expired, redirecting to login");

    // Clear any local session state
    try {
      // Trigger a page reload which will check session and show login
      globalThis.location.href = "/";
    } catch (error) {
      console.error("Failed to redirect after session expiry:", error);
    }

    // Return the response anyway for consistency
    return response;
  }

  return response;
}

/**
 * Helper for GET requests
 */
export function apiGet(url: string): Promise<Response> {
  return apiFetch(url);
}

/**
 * Helper for POST requests
 */
export function apiPost(
  url: string,
  body?: any,
): Promise<Response> {
  return apiFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Helper for PATCH requests
 */
export function apiPatch(
  url: string,
  body?: any,
): Promise<Response> {
  return apiFetch(url, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Helper for PUT requests
 */
export function apiPut(
  url: string,
  body?: any,
): Promise<Response> {
  return apiFetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/**
 * Helper for DELETE requests
 */
export function apiDelete(url: string): Promise<Response> {
  return apiFetch(url, {
    method: "DELETE",
  });
}
