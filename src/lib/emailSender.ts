/**
 * Send an evaluation PDF as a Gmail attachment using the signed-in user's
 * account (gmail.send scope). The recipient gets an email from the IK staff
 * member who ran the evaluation, with the PDF inline as an attachment.
 *
 * Implementation: build a raw RFC 2822 multipart/mixed message, base64url
 * encode it, and POST to gmail.users.messages.send.
 */

export interface SendEvalEmailOptions {
  toEmail: string;
  fromName?: string; // optional display name; address is implied by access token
  subject: string;
  htmlBody: string;
  pdfBase64: string;
  pdfFilename: string;
}

export interface EvalEmailContext {
  projectName: string;
  percentage: number;
  rating: string;
}

/** Build a sensible default subject + body if the caller doesn't override. */
export function defaultEmailSubject(ctx: EvalEmailContext): string {
  return `Your Project Evaluation Report — ${ctx.projectName}`;
}

export function defaultEmailHtml(ctx: EvalEmailContext): string {
  const safeProject = escapeHtml(ctx.projectName);
  return `<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #1f2937; max-width: 620px; margin: 0 auto; padding: 0 16px;">
  <h2 style="color: #1e40af; margin-top: 24px;">Your Project Evaluation Report</h2>
  <p>Hi,</p>
  <p>Thank you for submitting your project. Your evaluation is complete and the detailed report is attached as a PDF.</p>
  <table style="border-collapse: collapse; margin: 20px 0;">
    <tr>
      <td style="padding: 8px 16px 8px 0; color: #6b7280;">Project</td>
      <td style="padding: 8px 0; font-weight: 600;">${safeProject}</td>
    </tr>
    <tr>
      <td style="padding: 8px 16px 8px 0; color: #6b7280;">Score</td>
      <td style="padding: 8px 0; font-weight: 600;">${ctx.percentage}% (${escapeHtml(ctx.rating)})</td>
    </tr>
  </table>
  <p>The attached PDF includes:</p>
  <ul>
    <li>Section-by-section breakdown against the rubric, with strengths and gaps</li>
    <li>Concrete, actionable suggestions for every shortcoming</li>
    <li>Bonus point details</li>
    <li>Interviewer-style feedback designed to help you grow</li>
  </ul>
  <p>If you have any questions about the evaluation, just reply to this email.</p>
  <p style="margin-top: 32px;">Best,<br>Interview Kickstart</p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function encodeRfc2047(s: string): string {
  // Only encode if it contains non-ASCII; keep it simple for our case.
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf-8").toString("base64")}?=`;
}

/** Build an RFC 2822 multipart/mixed message with a single PDF attachment. */
function buildRawMessage(opts: SendEvalEmailOptions): string {
  const boundary = `mixed_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const safeFilename = opts.pdfFilename.replace(/[\r\n"]/g, "_");
  const fromHeader = opts.fromName ? `${encodeRfc2047(opts.fromName)} ` : "";

  // Split base64 into 76-char lines per RFC 2045
  const chunkedPdf = opts.pdfBase64.replace(/.{76}/g, (m) => `${m}\r\n`);

  const lines: string[] = [];
  if (fromHeader) lines.push(`From: ${fromHeader}`);
  lines.push(`To: ${opts.toEmail}`);
  lines.push(`Subject: ${encodeRfc2047(opts.subject)}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  lines.push(``);
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: text/html; charset=UTF-8`);
  lines.push(`Content-Transfer-Encoding: 7bit`);
  lines.push(``);
  lines.push(opts.htmlBody);
  lines.push(``);
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: application/pdf; name="${safeFilename}"`);
  lines.push(`Content-Transfer-Encoding: base64`);
  lines.push(`Content-Disposition: attachment; filename="${safeFilename}"`);
  lines.push(``);
  lines.push(chunkedPdf);
  lines.push(`--${boundary}--`);

  return lines.join("\r\n");
}

export async function sendEvalEmail(
  opts: SendEvalEmailOptions,
  accessToken: string
): Promise<{ messageId: string; threadId?: string }> {
  const raw = Buffer.from(buildRawMessage(opts), "utf-8").toString("base64url");

  const resp = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    if (resp.status === 403) {
      throw new Error(
        "Gmail API access denied. Make sure the Gmail API is enabled in your Google Cloud project and the OAuth consent screen includes the gmail.send scope, then sign out and sign back in."
      );
    }
    throw new Error(`Gmail send failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as { messageId: string; threadId?: string };
}
