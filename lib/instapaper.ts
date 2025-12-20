/**
 * Instapaper Simple API client.
 * Sends articles to Instapaper using the Simple API.
 * https://www.instapaper.com/api/simple
 */

export interface InstapaperCredentials {
  username: string;
  password: string;
}

export interface InstapaperAddResult {
  success: boolean;
  error?: string;
}

/**
 * Send an article to Instapaper.
 * Uses Simple API with basic authentication.
 */
export async function sendToInstapaper(
  url: string,
  credentials: InstapaperCredentials,
  title?: string,
): Promise<InstapaperAddResult> {
  try {
    // Validate URL
    const parsedUrl = new URL(url);
    if (!parsedUrl.protocol.startsWith("http")) {
      throw new Error("Only HTTP(S) URLs are supported");
    }

    // Build API request
    const apiUrl = new URL("https://www.instapaper.com/api/add");
    apiUrl.searchParams.set("url", url);
    if (title) {
      apiUrl.searchParams.set("title", title);
    }

    // Use Basic Authentication
    const authHeader = `Basic ${
      btoa(`${credentials.username}:${credentials.password}`)
    }`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const response = await fetch(apiUrl.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Authorization": authHeader,
        "User-Agent": "kipclip/1.0 (+https://kipclip.com)",
      },
    });

    clearTimeout(timeoutId);

    // Instapaper returns 201 on success
    if (response.status === 201) {
      return { success: true };
    }

    // Handle error responses
    const statusText = response.statusText || "Unknown error";

    if (response.status === 403) {
      return {
        success: false,
        error: "Invalid Instapaper credentials",
      };
    }

    if (response.status === 400) {
      return {
        success: false,
        error: "Invalid URL or request",
      };
    }

    if (response.status === 500) {
      return {
        success: false,
        error: "Instapaper service error",
      };
    }

    return {
      success: false,
      error: `Instapaper API error: ${response.status} ${statusText}`,
    };
  } catch (error: any) {
    console.error("Failed to send to Instapaper:", error);

    if (error.name === "AbortError") {
      return {
        success: false,
        error: "Request to Instapaper timed out",
      };
    }

    return {
      success: false,
      error: error.message || "Failed to send to Instapaper",
    };
  }
}

/**
 * Validate Instapaper credentials by attempting authentication.
 * Returns true if credentials are valid.
 */
export async function validateInstapaperCredentials(
  credentials: InstapaperCredentials,
): Promise<{ valid: boolean; error?: string }> {
  try {
    const authUrl = "https://www.instapaper.com/api/authenticate";
    const authHeader = `Basic ${
      btoa(`${credentials.username}:${credentials.password}`)
    }`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(authUrl, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Authorization": authHeader,
        "User-Agent": "kipclip/1.0 (+https://kipclip.com)",
      },
    });

    clearTimeout(timeoutId);

    if (response.status === 200) {
      return { valid: true };
    }

    if (response.status === 403) {
      return { valid: false, error: "Invalid username or password" };
    }

    return {
      valid: false,
      error: `Authentication failed: ${response.status}`,
    };
  } catch (error: any) {
    console.error("Failed to validate Instapaper credentials:", error);

    if (error.name === "AbortError") {
      return { valid: false, error: "Request timed out" };
    }

    return {
      valid: false,
      error: error.message || "Validation failed",
    };
  }
}
