/**
 * Google OAuth helpers.
 *
 * The session is stored as a HttpOnly cookie containing a JSON payload signed
 * with an HMAC over SESSION_SECRET. We need GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET and SESSION_SECRET configured as env vars. The redirect
 * URI is derived from the request host so the same code works locally and on
 * Vercel without an extra env var.
 *
 * Scopes:
 *   - drive.readonly: needed to read arbitrary files the user has been granted
 *     view access to (including ones shared with their domain).
 *   - openid email: so we can show the signed-in account email in the UI.
 */

import crypto from "crypto";
import type { NextRequest } from "next/server";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly", // read submission files
  "https://www.googleapis.com/auth/drive.file", // create/overwrite report PDFs we upload
  "https://www.googleapis.com/auth/spreadsheets", // update source Google Sheet in place
  "openid",
  "email",
].join(" ");

export const SESSION_COOKIE = "pe_g_session";
export const STATE_COOKIE = "pe_oauth_state";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionData {
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // ms since epoch
}

function getSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      "SESSION_SECRET env var is not set or too short (need 32+ random chars). Generate one with: openssl rand -hex 32"
    );
  }
  return s;
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("base64url");
}

export function encodeSession(data: SessionData): string {
  const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): SessionData | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(payload);
  // Timing-safe compare
  if (
    expected.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))
  ) {
    return null;
  }
  try {
    return JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8")
    ) as SessionData;
  } catch {
    return null;
  }
}

export function getRedirectUri(request: NextRequest | Request): string {
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    return `${appUrl.replace(/\/$/, "")}/api/auth/google/callback`;
  }
  // Honour x-forwarded-proto/host so we get https on Vercel
  const headers = (request as Request).headers;
  const proto = headers.get("x-forwarded-proto") || "https";
  const host = headers.get("x-forwarded-host") || headers.get("host");
  if (host) {
    return `${proto}://${host}/api/auth/google/callback`;
  }
  const url = new URL((request as Request).url);
  return `${url.origin}/api/auth/google/callback`;
}

export function buildAuthUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID env var is not set");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });

  // Hosted-domain hint so the picker defaults to the IK Workspace.
  if (process.env.GOOGLE_HOSTED_DOMAIN) {
    params.set("hd", process.env.GOOGLE_HOSTED_DOMAIN);
  }

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
  token_type?: string;
}

export async function exchangeCode(
  code: string,
  redirectUri: string
): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth env vars not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${text}`);
  }
  return (await response.json()) as TokenResponse;
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ access_token: string; expires_in: number }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth env vars not configured");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }
  return (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
}

export function decodeIdToken(idToken: string | undefined): {
  email?: string;
  hd?: string;
} {
  if (!idToken) return {};
  const parts = idToken.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
  } catch {
    return {};
  }
}

/**
 * Get a fresh access token from a session. If the cached one is within 60s of
 * expiry, transparently refresh and return the new session payload to store.
 */
export async function getValidAccessToken(session: SessionData): Promise<{
  accessToken: string;
  updatedSession?: SessionData;
}> {
  const now = Date.now();
  if (session.expiresAt - now > 60_000) {
    return { accessToken: session.accessToken };
  }
  if (!session.refreshToken) {
    throw new Error("Session expired and no refresh token available");
  }
  const refreshed = await refreshAccessToken(session.refreshToken);
  const updated: SessionData = {
    ...session,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
  };
  return { accessToken: refreshed.access_token, updatedSession: updated };
}

export function isOAuthConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.SESSION_SECRET
  );
}
