import { NextRequest, NextResponse } from "next/server";
import { parseUploadedFile } from "@/lib/fileParser";
import { evaluateSubmission } from "@/lib/evaluator";
import { fetchDriveFile, statusFromErrorType } from "@/lib/driveFetch";
import {
  SESSION_COOKIE,
  decodeSession,
  encodeSession,
  getValidAccessToken,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/googleOAuth";
import { ProjectCategory } from "@/lib/types";

export const maxDuration = 300;

interface RequestBody {
  driveLink: string;
  category: ProjectCategory;
  projectId?: string;
  identifier?: string;
  /** Submitter's email from the sheet's email column. When present and valid,
      becomes the report's submissionName so the PDF (filename + cover page)
      is identified by email everywhere. */
  email?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const { driveLink, category, projectId, identifier, email } = body;

    if (!driveLink) {
      return NextResponse.json(
        {
          ok: false,
          status: "No Drive link",
          error: "driveLink is required",
        },
        { status: 400 }
      );
    }
    if (!category) {
      return NextResponse.json(
        {
          ok: false,
          status: "Missing category",
          error: "category is required",
        },
        { status: 400 }
      );
    }

    // ---- Resolve a usable access token from the session cookie (if any) ----
    const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const session = decodeSession(sessionToken);
    let accessToken: string | undefined;
    let refreshedSessionCookie: string | undefined;

    if (session) {
      try {
        const { accessToken: token, updatedSession } =
          await getValidAccessToken(session);
        accessToken = token;
        if (updatedSession) {
          refreshedSessionCookie = encodeSession(updatedSession);
        }
      } catch {
        // Refresh failed — fall back to anonymous (will likely fail for domain-restricted files)
      }
    }

    // ---- Try the fetch ----
    const fetched = await fetchDriveFile(driveLink, accessToken);

    if (!fetched.ok || !fetched.data) {
      const resp = NextResponse.json({
        ok: false,
        status: statusFromErrorType(fetched.errorType),
        error: fetched.error || "Drive fetch failed",
      });
      if (refreshedSessionCookie) {
        attachRefreshedCookie(resp, refreshedSessionCookie);
      }
      return resp;
    }

    const filename = fetched.filename || "drive_submission";

    let parsedFiles;
    try {
      parsedFiles = await parseUploadedFile(fetched.data, filename);
    } catch (e) {
      const resp = NextResponse.json({
        ok: false,
        status: "Could not parse file",
        error: e instanceof Error ? e.message : "Parse failed",
      });
      if (refreshedSessionCookie)
        attachRefreshedCookie(resp, refreshedSessionCookie);
      return resp;
    }

    if (!parsedFiles || parsedFiles.length === 0) {
      const resp = NextResponse.json({
        ok: false,
        status: "Unsupported file type",
        error: `No parseable content in ${filename}`,
      });
      if (refreshedSessionCookie)
        attachRefreshedCookie(resp, refreshedSessionCookie);
      return resp;
    }

    const evaluation = await evaluateSubmission(
      parsedFiles,
      category,
      projectId || undefined
    );

    // Use the email as the submission name when present — that way the PDF
    // cover page AND the download filename are both identified by email,
    // matching the Drive upload / ZIP / email-attachment filenames.
    const validEmail =
      email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    if (validEmail) {
      evaluation.submissionName = validEmail;
    } else if (identifier) {
      evaluation.submissionName = identifier;
    }

    const resp = NextResponse.json({
      ok: true,
      status: "Evaluation done",
      result: evaluation,
      downloadedFilename: filename,
    });
    if (refreshedSessionCookie)
      attachRefreshedCookie(resp, refreshedSessionCookie);
    return resp;
  } catch (error) {
    console.error("Drive row evaluation error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({
      ok: false,
      status: "Evaluation failed",
      error: message,
    });
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
