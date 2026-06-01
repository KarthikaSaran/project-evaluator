/**
 * Given a Drive folder URL, list the spreadsheets inside it (.xlsx files and
 * native Google Sheets). The client uses this to "do the right thing" when a
 * user pastes a single folder URL — we auto-discover the input sheet inside
 * and reuse the same folder as the destination for report PDFs.
 *
 * Requires the user to be signed in with at least the drive.readonly scope
 * (folders shared with @interviewkickstart.com aren't listable anonymously).
 */

import { NextRequest, NextResponse } from "next/server";
import { extractFolderId } from "@/lib/driveUpload";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  decodeSession,
  encodeSession,
  getValidAccessToken,
} from "@/lib/googleOAuth";

export const maxDuration = 30;

const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface RequestBody {
  folderUrl: string;
}

interface DriveListFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export async function POST(request: NextRequest) {
  try {
    const { folderUrl } = (await request.json()) as RequestBody;
    if (!folderUrl) {
      return NextResponse.json(
        { ok: false, error: "folderUrl is required" },
        { status: 400 }
      );
    }

    const folderId = extractFolderId(folderUrl);
    if (!folderId) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Could not parse a Drive folder ID from that URL. Use a link like https://drive.google.com/drive/folders/...",
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
          error: "Sign in with Google to list files inside a Drive folder.",
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

    // Search the folder for sheets (Google Sheet or .xlsx), sorted by recency
    const q = `'${folderId}' in parents and trashed=false and (mimeType='${GSHEET_MIME}' or mimeType='${XLSX_MIME}')`;
    const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
      q
    )}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=modifiedTime%20desc&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=20`;
    const listResp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!listResp.ok) {
      const text = await listResp.text();
      if (listResp.status === 403) {
        return NextResponse.json({
          ok: false,
          error:
            "Signed-in account doesn't have view access to this folder. Make sure it's shared with your @interviewkickstart.com account.",
        });
      }
      if (listResp.status === 404) {
        return NextResponse.json({
          ok: false,
          error: "Folder not found — check the URL.",
        });
      }
      return NextResponse.json({
        ok: false,
        error: `Drive list failed (${listResp.status}): ${text.slice(0, 200)}`,
      });
    }

    const data = (await listResp.json()) as { files?: DriveListFile[] };
    const files = data.files || [];

    const resp = NextResponse.json({
      ok: true,
      folderId,
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        webViewLink: f.webViewLink,
        kind: f.mimeType === GSHEET_MIME ? "google-sheet" : "xlsx",
      })),
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
    console.error("find-sheet-in-folder error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
