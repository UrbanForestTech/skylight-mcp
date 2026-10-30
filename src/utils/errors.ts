/**
 * Base error class for Skylight API errors
 */
export class SkylightError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
    public recoverable: boolean = false
  ) {
    super(message);
    this.name = "SkylightError";
  }
}

/**
 * Authentication failed - token may be expired or invalid
 */
export class AuthenticationError extends SkylightError {
  constructor(message: string = "Authentication failed. Your token may be expired or invalid.") {
    super(message, "AUTH_FAILED", 401, true);
    this.name = "AuthenticationError";
  }
}

/**
 * Configuration error - missing or invalid settings
 */
export class ConfigurationError extends SkylightError {
  constructor(message: string) {
    super(message, "CONFIG_ERROR", undefined, true);
    this.name = "ConfigurationError";
  }
}

/**
 * Resource not found
 */
export class NotFoundError extends SkylightError {
  constructor(resource: string) {
    super(`${resource} not found`, "NOT_FOUND", 404, false);
    this.name = "NotFoundError";
  }
}

/**
 * Rate limited by the API
 */
export class RateLimitError extends SkylightError {
  constructor(retryAfter?: number) {
    super(
      `Rate limited by Skylight API. ${retryAfter ? `Retry after ${retryAfter}s` : "Please wait and try again."}`,
      "RATE_LIMITED",
      429,
      true
    );
    this.name = "RateLimitError";
  }
}

/**
 * API returned an unexpected response format
 */
export class ParseError extends SkylightError {
  constructor(message: string = "Unexpected API response format") {
    super(message, "PARSE_ERROR", undefined, false);
    this.name = "ParseError";
  }
}

/**
 * Pull the human-readable message out of a Skylight error body.
 * Handles JSON:API `errors: [{detail|title}]`, Rails-style
 * `errors: {field: ["msg"]}`, and plain `error`/`message` strings.
 * Returns null when the body has nothing readable (e.g. an HTML error page).
 */
export function extractApiMessage(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const messages: string[] = [];

  const { errors } = record;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === "string") messages.push(entry);
      else if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const text = e.detail ?? e.title ?? e.message;
        if (typeof text === "string") messages.push(text);
      }
    }
  } else if (errors && typeof errors === "object") {
    for (const [field, value] of Object.entries(errors as Record<string, unknown>)) {
      const name = field === "base" ? "" : `${field.charAt(0).toUpperCase()}${field.slice(1).replace(/_/g, " ")} `;
      for (const text of Array.isArray(value) ? value : [value]) {
        if (typeof text === "string") messages.push(`${name}${text}`);
      }
    }
  }

  for (const key of ["error_description", "message", "error"] as const) {
    if (messages.length === 0 && typeof record[key] === "string") messages.push(record[key] as string);
  }

  return messages.length > 0 ? messages.join("; ").slice(0, 500) : null;
}

/**
 * Message for a failed Skylight response: the API's own words when it gave
 * any, otherwise the start of the raw body.
 */
export function describeHttpError(status: number, body: string): string {
  const detail = extractApiMessage(body);
  if (detail) return `HTTP ${status}: ${detail}`;
  const raw = body.trim();
  return raw ? `HTTP ${status}: ${raw.slice(0, 200)}` : `HTTP ${status}`;
}

/**
 * Format an error for MCP tool response
 * Accepts unknown to handle any value from catch blocks safely
 */
export function formatErrorForMcp(error: unknown): string {
  if (error instanceof AuthenticationError) {
    return `Authentication Error: ${error.message}

Your Skylight token may have expired. To fix this:
1. If using email/password auth, retry with valid SKYLIGHT_EMAIL and SKYLIGHT_PASSWORD
2. If using a manual token, capture fresh API traffic using a proxy tool
3. Update your SKYLIGHT_TOKEN environment variable if you are using manual token auth

See the auth documentation for detailed steps.`;
  }

  if (error instanceof NotFoundError) {
    return `Not Found: ${error.message}

This could mean:
- The requested item doesn't exist
- Your frame ID is incorrect
- The item was deleted from Skylight`;
  }

  if (error instanceof RateLimitError) {
    return `Rate Limited: ${error.message}

The Skylight API is temporarily limiting requests. Please wait a moment and try again.`;
  }

  if (error instanceof ConfigurationError) {
    return `Configuration Error: ${error.message}

Please check your environment variables are set correctly.`;
  }

  if (error instanceof SkylightError) {
    return `Skylight Error: ${error.message}`;
  }

  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }

  return `Error: ${String(error)}`;
}
