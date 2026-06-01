import { NextRequest, NextResponse } from "next/server";
import {
  fetchDriveSpreadsheet,
  statusFromErrorType,
} from "@/lib/driveFetch";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  decodeSession,
  encodeSession,
  getValidAccessToken,
} from "@/lib/googleOAuth";

export const maxDuration = 60;

interface RequestBody {
  driveLink: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const driveLink = body?.driveLink;
    if (!driveLink) {
      return NextResponse.json(
        { ok: false, error: "driveLink is required" },
        { status: 400 }
      );
    }

    // Resolve an access token from the session cookie (if signed in)
    const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const session = decodeSession(sessionToken);
    let accessToken: string | undefined;
    let refreshedCookie: string | undefined;
    if (session) {
      try {
        const { accessToken: token, updatedSession } =
          await getValidAccessToken(session);
        accessToken = token;
        if (updatedSession) {
          refreshedCookie = encodeSession(updatedSession);
        }
      } catch {
        // Token couldn't be refreshed — fall back to anonymous fetch
      }
    }

    const fetched = await fetchDriveSpreadsheet(driveLink, accessToken);

    if (!fetched.ok || !fetched.data) {
      const resp = NextResponse.json({
        ok: false,
        status: statusFromErrorType(fetched.errorType),
        error: fetched.error || "Drive fetch failed",
      });
      if (refreshedCookie) attachRefreshedCookie(resp, refreshedCookie);
      return resp;
    }

    const resp = NextResponse.json({
      ok: true,
      filename: fetched.filename,
      mimeType: fetched.mimeType,
      contentBase64: fetched.data.toString("base64"),
      size: fetched.data.length,
    });
    if (refreshedCookie) attachRefreshedCookie(resp, refreshedCookie);
    return resp;
  } catch (e) {
    console.error("fetch-sheet error:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

function attachRefreshedCookie(resp: NextResponse, cookieValue: string) {
  resp.cookies.set(SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}
