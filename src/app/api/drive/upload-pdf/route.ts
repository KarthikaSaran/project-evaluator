import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  decodeSession,
  encodeSession,
  getValidAccessToken,
} from "@/lib/googleOAuth";
import {
  uploadPdfToFolder,
  extractFolderId,
} from "@/lib/driveUpload";

export const maxDuration = 60;

interface RequestBody {
  folderUrl: string;
  filename: string;
  pdfBase64: string;
}

export async function POST(request: NextRequest) {
  try {
    const { folderUrl, filename, pdfBase64 } =
      (await request.json()) as RequestBody;

    if (!folderUrl || !filename || !pdfBase64) {
      return NextResponse.json(
        { ok: false, error: "folderUrl, filename and pdfBase64 are required" },
        { status: 400 }
      );
    }

    const folderId = extractFolderId(folderUrl);
    if (!folderId) {
      return NextResponse.json(
        { ok: false, error: "Could not parse a Drive folder ID from folderUrl" },
        { status: 400 }
      );
    }

    // ---- Auth ----
    const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const session = decodeSession(sessionToken);
    if (!session) {
      return NextResponse.json(
        {
          ok: false,
          error: "Sign in with Google to upload reports to Drive",
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

    // ---- Decode + upload ----
    const pdfBuffer = Buffer.from(pdfBase64, "base64");
    const uploaded = await uploadPdfToFolder(
      folderId,
      filename,
      pdfBuffer,
      accessToken
    );

    const resp = NextResponse.json({
      ok: true,
      fileId: uploaded.fileId,
      webViewLink: uploaded.webViewLink,
      filename: uploaded.filename,
    });
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
    console.error("upload-pdf error:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
