import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  decodeSession,
  encodeSession,
  getValidAccessToken,
} from "@/lib/googleOAuth";
import {
  updateGoogleSheet,
  SheetUpdate,
  SheetUpdateColumns,
} from "@/lib/driveUpload";

export const maxDuration = 60;

interface RequestBody {
  spreadsheetId: string;
  sheetName?: string;
  updates: SheetUpdate[];
  cols: SheetUpdateColumns;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const { spreadsheetId, sheetName, updates, cols } = body;

    if (!spreadsheetId || !updates || !cols) {
      return NextResponse.json(
        {
          ok: false,
          error: "spreadsheetId, updates and cols are required",
        },
        { status: 400 }
      );
    }

    const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const session = decodeSession(sessionToken);
    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          error: "Sign in with Google to update the source sheet",
        },
        { status: 401 }
      );
    }

    let accessToken: string;
    let refreshedCookie: string | undefined;
    try {
      const { accessToken: token, updatedSession } =
        await getValidAccessToken(session);
      accessToken = token;
      if (updatedSession) refreshedCookie = encodeSession(updatedSession);
    } catch (e) {
      return NextResponse.json(
        {
          ok: false,
          error:
            e instanceof Error
              ? e.message
              : "Session expired — sign in again",
        },
        { status: 401 }
      );
    }

    await updateGoogleSheet(
      spreadsheetId,
      sheetName || null,
      updates,
      cols,
      accessToken
    );

    const resp = NextResponse.json({ ok: true });
    if (refreshedCookie) {
      resp.cookies.set(SESSION_COOKIE, refreshedCookie, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_AGE_SECONDS,
      });
    }
    return resp;
  } catch (e) {
    console.error("sheets/update error:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
