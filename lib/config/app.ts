/**
 * Server-controlled application origin and derived absolute URLs.
 *
 * These values are deliberately derived ONLY from server-side configuration
 * (`APP_URL`), never from client-supplied request data. A malicious request
 * origin/Host header can therefore never influence where outbound links (e.g.
 * the password-reset redirect) point.
 *
 * `APP_URL` is required and validated: there is no fallback origin (no
 * localhost/port-3000 default). A deployment that omits or misconfigures it
 * fails fast with an `AppConfigurationError` so a reset flow can never
 * silently fall back to a localhost or attacker-influenced address.
 */

const APP_URL_ENV_VAR = "APP_URL";

/** Thrown when `APP_URL` is missing or is not a valid absolute http(s) origin. */
export class AppConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppConfigurationError";
  }
}

/** Server-controlled public origin of this app (no trailing slash). */
export function getAppOrigin(): string {
  const raw = process.env[APP_URL_ENV_VAR]?.trim();

  if (!raw) {
    throw new AppConfigurationError(
      `Missing required environment variable ${APP_URL_ENV_VAR}: set it to the ` +
        "public http(s) origin of this deployment (e.g. https://app.example.com)."
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppConfigurationError(
      `${APP_URL_ENV_VAR} is not a valid URL: set it to an absolute http(s) ` +
        "origin such as https://app.example.com."
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppConfigurationError(
      `${APP_URL_ENV_VAR} must be an http(s) URL (got protocol "${url.protocol}").`
    );
  }

  if (!url.hostname) {
    throw new AppConfigurationError(
      `${APP_URL_ENV_VAR} must include a host (e.g. https://app.example.com).`
    );
  }

  // URL#origin drops any path/query/hash and never carries a trailing slash.
  return url.origin;
}

/** Absolute URL for the password-reset page, built from server config only. */
export function getResetPasswordRedirectUrl(): string {
  return `${getAppOrigin()}/reset-password`;
}
