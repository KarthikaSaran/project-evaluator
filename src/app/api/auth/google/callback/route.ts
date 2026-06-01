import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCode,
  decodeIdToken,
  encodeSession,
  getRedirectUri,
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/googleOAuth";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(
      `${origin}/?auth_error=${encodeURIComponent(oauthError)}`
    );
  }

  const storedState = request.cookies.get(STATE_COOKIE)?.value;
  if (!state || !storedState || state !== storedState) {
    return NextResponse.redirect(`${origin}/?auth_error=invalid_state`);
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/?auth_error=missing_code`);
  }

  try {
    const redirectUri = getRedirectUri(request);
    const tokens = await exchangeCode(code, redirectUri);
    const idInfo = decodeIdToken(tokens.id_token);

    const sessionPayload = encodeSession({
      email: idInfo.email || "",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    });

    const response = NextResponse.redirect(`${origin}/?auth=ok`);
    response.cookies.delete(STATE_COOKIE);
    response.cookies.set(SESSION_COOKIE, sessionPayload, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (e) {
    console.error("OAuth callback error:", e);
    const msg = e instanceof Error ? e.message : "exchange_failed";
    return NextResponse.redirect(
      `${origin}/?auth_error=${encodeURIComponent(msg)}`
    );
  }
}
