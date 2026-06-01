import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  decodeSession,
  isOAuthConfigured,
} from "@/lib/googleOAuth";

export async function GET(request: NextRequest) {
  if (!isOAuthConfigured()) {
    return NextResponse.json({
      signedIn: false,
      configured: false,
    });
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = decodeSession(token);
  if (!session) {
    return NextResponse.json({ signedIn: false, configured: true });
  }
  return NextResponse.json({
    signedIn: true,
    configured: true,
    email: session.email,
  });
}
