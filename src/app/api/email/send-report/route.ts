import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  decodeSession,
  encodeSession,
  getValidAccessToken,
} from "@/lib/googleOAuth";
import {
  sendEvalEmail,
  defaultEmailSubject,
  defaultEmailHtml,
  EvalEmailContext,
} from "@/lib/emailSender";

export const maxDuration = 30;

interface RequestBody {
  toEmail: string;
  pdfBase64: string;
  pdfFilename: string;
  context: EvalEmailContext;
  subject?: string; // optional override
  htmlBody?: string; // optional override
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const {
      toEmail,
      pdfBase64,
      pdfFilename,
      context,
      subject,
      htmlBody,
    } = body;

    if (!toEmail || !pdfBase64 || !pdfFilename || !context) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "toEmail, pdfBase64, pdfFilename and context are required",
        },
        { status: 400 }
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
      return NextResponse.json(
        { ok: false, error: `Recipient is not a valid email: ${toEmail}` },
        { status: 400 }
      );
    }

    // ---- Auth ----
    const sessionToken = request.cookies.get(SESSION_COOKIE)?.value;
    const session = decodeSession(sessionToken);
    if (!session) {
      return NextResponse.json(
        { ok: false, error: "Sign in with Google to send emails" },
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

    // ---- Send ----
    const sent = await sendEvalEmail(
      {
        toEmail,
        subject: subject || defaultEmailSubject(context),
        htmlBody: htmlBody || defaultEmailHtml(context),
        pdfBase64,
        pdfFilename,
      },
      accessToken
    );

    const resp = NextResponse.json({
      ok: true,
      messageId: sent.messageId,
      threadId: sent.threadId,
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
    console.error("email/send-report error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
