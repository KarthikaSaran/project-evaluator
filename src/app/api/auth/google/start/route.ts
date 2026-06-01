import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import {
  buildAuthUrl,
  getRedirectUri,
  isOAuthConfigured,
  STATE_COOKIE,
} from "@/lib/googleOAuth";

export async function GET(request: NextRequest) {
  if (!isOAuthConfigured()) {
    const origin = new URL(request.url).origin;
    return NextResponse.redirect(
      `${origin}/?auth_error=${encodeURIComponent("oauth_not_configured")}`
    );
  }

  try {
    const state = crypto.randomBytes(16).toString("base64url");
    const redirectUri = getRedirectUri(request);
    const authUrl = buildAuthUrl(state, redirectUri);

    const response = NextResponse.redirect(authUrl);
    response.cookies.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 600, // 10 min
    });
    return response;
  } catch (e) {
    const origin = new URL(request.url).origin;
    const msg = e instanceof Error ? e.message : "auth_start_failed";
    return NextResponse.redirect(
      `${origin}/?auth_error=${encodeURIComponent(msg)}`
    );
  }
}
