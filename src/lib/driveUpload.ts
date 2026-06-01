/**
 * Server-side helpers for *writing* to Drive and Sheets:
 *   - uploadPdfToFolder()  — multipart upload of a PDF into a Drive folder.
 *                            If a file with the same name already exists in
 *                            that folder, overwrites it (so re-runs are
 *                            idempotent and the Drive URL is stable).
 *   - updateGoogleSheet()  — writes Score / Status / Report Link cells back
 *                            into a Google Sheet via the Sheets API,
 *                            appending new columns if needed.
 *
 * Both require an access token with the matching scope (drive.file for
 * uploads, spreadsheets for sheet updates).
 */

import { parseDriveLink } from "./driveFetch";

export interface UploadedPdf {
  fileId: string;
  webViewLink: string;
  filename: string;
}

export function extractFolderId(folderUrl: string): string | null {
  if (!folderUrl) return null;
  const trimmed = folderUrl.trim();

  // /drive/folders/{ID} (with optional /u/0/)
  let m = trimmed.match(
    /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/
  );
  if (m) return m[1];

  // ?id={ID}
  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];

  // Bare folder ID
  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;

  return null;
}

export function extractSpreadsheetId(sheetUrl: string): string | null {
  const parsed = parseDriveLink(sheetUrl);
  if (parsed.kind === "google-doc" && parsed.docType === "spreadsheets") {
    return parsed.id || null;
  }
  return null;
}

// ---------------------------------------------------------------- PDF upload

async function findFileInFolder(
  folderId: string,
  filename: string,
  accessToken: string
): Promise<string | null> {
  // Escape ' in filename for the search query
  const escapedName = filename.replace(/'/g, "\\'");
  const q = encodeURIComponent(
    `'${folderId}' in parents and name='${escapedName}' and trashed=false`
  );
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) return null;
  const data = (await resp.json()) as { files?: Array<{ id: string }> };
  return data.files?.[0]?.id || null;
}

export async function uploadPdfToFolder(
  folderId: string,
  filename: string,
  pdfBuffer: Buffer,
  accessToken: string
): Promise<UploadedPdf> {
  // If a file with the same name already exists in the folder, overwrite it
  // by updating its content (keeps the same Drive URL across re-runs).
  const existingId = await findFileInFolder(folderId, filename, accessToken);

  if (existingId) {
    return updateExistingPdf(existingId, pdfBuffer, accessToken);
  }
  return createNewPdf(folderId, filename, pdfBuffer, accessToken);
}

async function createNewPdf(
  folderId: string,
  filename: string,
  pdfBuffer: Buffer,
  accessToken: string
): Promise<UploadedPdf> {
  const metadata = {
    name: filename,
    parents: [folderId],
    mimeType: "application/pdf",
  };
  const boundary = `boundary${Math.random().toString(36).slice(2)}`;

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`, "utf-8"),
    Buffer.from(
      `Content-Type: application/json; charset=UTF-8\r\n\r\n`,
      "utf-8"
    ),
    Buffer.from(JSON.stringify(metadata), "utf-8"),
    Buffer.from(`\r\n--${boundary}\r\n`, "utf-8"),
    Buffer.from(`Content-Type: application/pdf\r\n\r\n`, "utf-8"),
    pdfBuffer,
    Buffer.from(`\r\n--${boundary}--`, "utf-8"),
  ]);

  const resp = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Drive upload failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as {
    id: string;
    webViewLink?: string;
  };
  return {
    fileId: data.id,
    webViewLink:
      data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    filename,
  };
}

async function updateExistingPdf(
  fileId: string,
  pdfBuffer: Buffer,
  accessToken: string
): Promise<UploadedPdf> {
  const resp = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=id,name,webViewLink&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/pdf",
      },
      body: new Uint8Array(pdfBuffer),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Drive PDF update failed (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as {
    id: string;
    name: string;
    webViewLink?: string;
  };
  return {
    fileId: data.id,
    webViewLink:
      data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`,
    filename: data.name,
  };
}

// ---------------------------------------------------------------- Sheets update

/** Column-letter encoding: 0 -> A, 25 -> Z, 26 -> AA, ... */
export function columnLetter(idx: number): string {
  let n = idx;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export interface SheetUpdate {
  /** 0-based data row index (row 0 = the row right under the header). */
  rowIndex: number;
  status: string;
  score?: string;
  reportLink?: string;
  emailed?: string;
}

export interface SheetUpdateColumns {
  /** 0-based column indices in the existing sheet (or to-be-added at the end). */
  statusColIdx: number;
  scoreColIdx: number;
  reportLinkColIdx: number;
  emailedColIdx: number;
  /** Whether each column needed to be appended (and so its header row needs writing). */
  statusIsNew: boolean;
  scoreIsNew: boolean;
  reportLinkIsNew: boolean;
  emailedIsNew: boolean;
  /** Final header text for new columns. */
  statusHeader: string;
  scoreHeader: string;
  reportLinkHeader: string;
  emailedHeader: string;
}

async function getFirstSheetName(
  spreadsheetId: string,
  accessToken: string
): Promise<string> {
  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets(properties(title))`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Could not read sheet metadata (${resp.status}): ${text}`);
  }
  const data = (await resp.json()) as {
    sheets?: Array<{ properties?: { title?: string } }>;
  };
  const title = data.sheets?.[0]?.properties?.title;
  if (!title) throw new Error("No sheets in spreadsheet");
  return title;
}

export async function updateGoogleSheet(
  spreadsheetId: string,
  sheetName: string | null,
  updates: SheetUpdate[],
  cols: SheetUpdateColumns,
  accessToken: string
): Promise<void> {
  const tab = sheetName || (await getFirstSheetName(spreadsheetId, accessToken));
  // Use single quotes around tab name for safety with spaces/special chars
  const tabRef = `'${tab.replace(/'/g, "''")}'`;

  const valueRanges: Array<{ range: string; values: string[][] }> = [];

  // Write headers for any newly-appended columns
  if (cols.statusIsNew) {
    valueRanges.push({
      range: `${tabRef}!${columnLetter(cols.statusColIdx)}1`,
      values: [[cols.statusHeader]],
    });
  }
  if (cols.scoreIsNew) {
    valueRanges.push({
      range: `${tabRef}!${columnLetter(cols.scoreColIdx)}1`,
      values: [[cols.scoreHeader]],
    });
  }
  if (cols.reportLinkIsNew) {
    valueRanges.push({
      range: `${tabRef}!${columnLetter(cols.reportLinkColIdx)}1`,
      values: [[cols.reportLinkHeader]],
    });
  }
  if (cols.emailedIsNew) {
    valueRanges.push({
      range: `${tabRef}!${columnLetter(cols.emailedColIdx)}1`,
      values: [[cols.emailedHeader]],
    });
  }

  // Write the per-row cells
  for (const u of updates) {
    const sheetRow = u.rowIndex + 2; // +1 for header, +1 because Sheets is 1-based
    valueRanges.push({
      range: `${tabRef}!${columnLetter(cols.statusColIdx)}${sheetRow}`,
      values: [[u.status]],
    });
    if (u.score !== undefined) {
      valueRanges.push({
        range: `${tabRef}!${columnLetter(cols.scoreColIdx)}${sheetRow}`,
        values: [[u.score]],
      });
    }
    if (u.reportLink !== undefined) {
      valueRanges.push({
        range: `${tabRef}!${columnLetter(cols.reportLinkColIdx)}${sheetRow}`,
        values: [[u.reportLink]],
      });
    }
    if (u.emailed !== undefined) {
      valueRanges.push({
        range: `${tabRef}!${columnLetter(cols.emailedColIdx)}${sheetRow}`,
        values: [[u.emailed]],
      });
    }
  }

  if (valueRanges.length === 0) return;

  const resp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: valueRanges,
      }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Sheet update failed (${resp.status}): ${text}`);
  }
}
