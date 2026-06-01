/**
 * Client-side parsing/updating of a "Drive Links Sheet" — an xlsx where each row
 * contains a Google Drive URL pointing to a single submission file.
 *
 * Auto-detects:
 *   - Drive link column (header match, with URL-sniff fallback)
 *   - Identifier column (name/email/id-like header)
 *   - Existing Status / Score columns (created fresh if missing)
 *
 * Rows are skipped (won't be re-evaluated) when their existing Status indicates
 * a successful prior run — "Evaluation done", "Complete", "Success", etc.
 * Failure statuses (No drive access, Folder not supported, ...) DO get re-tried.
 */

import * as XLSX from "xlsx";

export interface DriveSheetColumns {
  linkCol: string;
  idCol: string | null;
  /** Separately-detected email column (used for PDF filenames). May equal idCol. */
  emailCol: string | null;
  statusCol: string;
  scoreCol: string;
  /** Header name we'll use for the Report Link column. */
  reportLinkCol: string;
  /** Header name we'll use for the Emailed column. */
  emailedCol: string;
  statusColIsNew: boolean;
  scoreColIsNew: boolean;
  reportLinkColIsNew: boolean;
  emailedColIsNew: boolean;
}

export interface DriveSheetRow {
  rowIndex: number; // 0-based index into data rows
  identifier: string;
  email: string | null;
  driveLink: string;
  currentStatus: string;
  shouldSkip: boolean;
  skipReason?: string;
}

export interface ParsedDriveSheet {
  workbook: XLSX.WorkBook;
  sheetName: string;
  headers: string[];
  rowData: Record<string, unknown>[];
  columns: DriveSheetColumns;
  rows: DriveSheetRow[];
}

// "Done" / "Evaluation done" / "Complete" / "Success" — anything matching means SKIP
const SUCCESS_STATUS_PATTERNS = [
  /evaluation\s*done/i,
  /\bdone\b/i,
  /\bcomplete/i,
  /\bevaluated\b/i,
  /\bsuccess/i,
];

function looksLikeSuccessStatus(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  return SUCCESS_STATUS_PATTERNS.some((p) => p.test(trimmed));
}

function looksLikeDriveUrl(v: string): boolean {
  return /drive\.google\.com|colab\.research\.google\.com|docs\.google\.com/i.test(
    v
  );
}

export function parseDriveSheet(buffer: ArrayBuffer): ParsedDriveSheet {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error("The uploaded file has no sheets.");
  }
  const sheet = workbook.Sheets[sheetName];

  const rowData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });

  if (rowData.length === 0) {
    throw new Error("The first sheet has no data rows.");
  }

  const headers = Object.keys(rowData[0]);

  // --- Detect Drive link column ---------------------------------------------
  let linkCol =
    headers.find((h) =>
      /(drive|colab|submission|github)\s*(link|url)?|^link$|^url$/i.test(h)
    ) || "";

  if (!linkCol) {
    // Fallback: pick the column whose cells most look like Drive URLs
    let bestCol = "";
    let bestHits = 0;
    const sampleSize = Math.min(20, rowData.length);
    for (const h of headers) {
      const hits = rowData
        .slice(0, sampleSize)
        .filter((r) => looksLikeDriveUrl(String(r[h] || "")))
        .length;
      if (hits > bestHits) {
        bestHits = hits;
        bestCol = h;
      }
    }
    if (bestHits >= Math.max(1, Math.floor(sampleSize / 3))) {
      linkCol = bestCol;
    }
  }

  if (!linkCol) {
    throw new Error(
      "Could not detect a Drive link column. Add a column like 'Drive Link' or 'Submission URL' with Google Drive URLs."
    );
  }

  // --- Detect email column (separately, even when identifier is "Name") -----
  // Prefer columns whose header looks email-y; fall back to a column whose
  // cells look like email addresses.
  let emailCol =
    headers.find((h) => /e-?mail|^mail$/i.test(h)) || null;
  if (!emailCol) {
    const sampleSize = Math.min(10, rowData.length);
    for (const h of headers) {
      const hits = rowData
        .slice(0, sampleSize)
        .filter((r) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(r[h] || "").trim()))
        .length;
      if (hits >= Math.max(1, Math.floor(sampleSize / 2))) {
        emailCol = h;
        break;
      }
    }
  }

  // --- Detect identifier column (for display + filename fallback) ----------
  // Priority order so the fallback when email is missing is meaningful:
  //   1. A name-like header (Name, Full Name, Student Name, ...)
  //   2. An id-like header (ID, Student ID, Roll No)
  //   3. Any column that isn't the link/email/status/score/etc.
  // Crucially we exclude the email column — email is handled separately, so
  // idCol must point at *something else* (typically the Name) to be useful as
  // a "use the name" fallback for PDF naming and the cover page.
  let idCol =
    headers.find((h) =>
      /^(full\s*)?name\b|student\s*name|learner\s*name|candidate\s*name|user\s*name/i.test(
        h
      )
    ) || null;
  if (!idCol) {
    idCol =
      headers.find(
        (h) =>
          h !== emailCol &&
          /^(id|student\s*id|learner\s*id|candidate\s*id|user\s*id|roll(\s*no)?)$/i.test(
            h
          )
      ) || null;
  }
  if (!idCol) {
    idCol =
      headers.find(
        (h) =>
          h !== linkCol &&
          h !== emailCol &&
          !/status|score|%|percent|report|emailed/i.test(h)
      ) || null;
  }

  // --- Detect existing Status / Score / Report Link columns ----------------
  const existingStatus = headers.find((h) => /^status$|\bstatus\b/i.test(h));
  const existingScore = headers.find(
    (h) => /^score$|\bscore\b|\bpercent|%$/i.test(h)
  );
  const existingReportLink = headers.find((h) =>
    /report\s*link|pdf\s*link|report\s*url/i.test(h)
  );
  const existingEmailed = headers.find((h) =>
    /^emailed$|email\s*status|email\s*sent/i.test(h)
  );

  const columns: DriveSheetColumns = {
    linkCol,
    idCol,
    emailCol,
    statusCol: existingStatus || "Status",
    scoreCol: existingScore || "Score",
    reportLinkCol: existingReportLink || "Report Link",
    emailedCol: existingEmailed || "Emailed",
    statusColIsNew: !existingStatus,
    scoreColIsNew: !existingScore,
    reportLinkColIsNew: !existingReportLink,
    emailedColIsNew: !existingEmailed,
  };

  // --- Build per-row spec ---------------------------------------------------
  const rows: DriveSheetRow[] = rowData.map((r, idx) => {
    const identifier = idCol
      ? String(r[idCol] || `Row ${idx + 2}`).trim() || `Row ${idx + 2}`
      : `Row ${idx + 2}`;
    const email = emailCol ? String(r[emailCol] || "").trim() || null : null;
    const driveLink = String(r[linkCol] || "").trim();
    const currentStatus = existingStatus
      ? String(r[existingStatus] || "").trim()
      : "";

    let shouldSkip = false;
    let skipReason: string | undefined;
    if (looksLikeSuccessStatus(currentStatus)) {
      shouldSkip = true;
      skipReason = "Already evaluated";
    } else if (!driveLink) {
      shouldSkip = true;
      skipReason = "No Drive link in this row";
    }

    return {
      rowIndex: idx,
      identifier,
      email,
      driveLink,
      currentStatus,
      shouldSkip,
      skipReason,
    };
  });

  return {
    workbook,
    sheetName,
    headers,
    rowData,
    columns,
    rows,
  };
}

export interface RowUpdate {
  rowIndex: number;
  status: string;
  score?: string; // formatted like "87%"
  reportLink?: string;
  emailed?: string;
}

/**
 * Build an updated workbook with Status / Score / Report Link filled in.
 * Preserves all other columns and any extra sheets the workbook had.
 */
export function buildUpdatedWorkbook(
  parsed: ParsedDriveSheet,
  updates: RowUpdate[]
): ArrayBuffer {
  const { workbook, sheetName, rowData, columns, headers } = parsed;

  const updateByIndex = new Map<number, RowUpdate>();
  for (const u of updates) updateByIndex.set(u.rowIndex, u);

  const updatedRows = rowData.map((r, idx) => {
    const newRow: Record<string, unknown> = { ...r };
    const u = updateByIndex.get(idx);

    if (!(columns.scoreCol in newRow)) newRow[columns.scoreCol] = "";
    if (!(columns.statusCol in newRow)) newRow[columns.statusCol] = "";
    if (!(columns.reportLinkCol in newRow))
      newRow[columns.reportLinkCol] = "";
    if (!(columns.emailedCol in newRow)) newRow[columns.emailedCol] = "";

    if (u) {
      newRow[columns.statusCol] = u.status;
      if (u.score !== undefined) newRow[columns.scoreCol] = u.score;
      if (u.reportLink !== undefined)
        newRow[columns.reportLinkCol] = u.reportLink;
      if (u.emailed !== undefined) newRow[columns.emailedCol] = u.emailed;
    }
    return newRow;
  });

  const finalHeaders = [...headers];
  if (!finalHeaders.includes(columns.scoreCol)) {
    finalHeaders.push(columns.scoreCol);
  }
  if (!finalHeaders.includes(columns.statusCol)) {
    finalHeaders.push(columns.statusCol);
  }
  if (!finalHeaders.includes(columns.reportLinkCol)) {
    finalHeaders.push(columns.reportLinkCol);
  }
  if (!finalHeaders.includes(columns.emailedCol)) {
    finalHeaders.push(columns.emailedCol);
  }

  const newSheet = XLSX.utils.json_to_sheet(updatedRows, {
    header: finalHeaders,
  });

  const newWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWorkbook, newSheet, sheetName);

  for (const name of workbook.SheetNames) {
    if (name !== sheetName) {
      XLSX.utils.book_append_sheet(newWorkbook, workbook.Sheets[name], name);
    }
  }

  return XLSX.write(newWorkbook, {
    type: "array",
    bookType: "xlsx",
  }) as ArrayBuffer;
}

/**
 * Compute final column indices (0-based) for Status / Score / Report Link in
 * the underlying spreadsheet. Existing columns keep their position; new ones
 * get appended at the end in the order [Status, Score, Report Link] (only
 * those that weren't already present).
 */
export function computeSheetUpdateColumns(parsed: ParsedDriveSheet): {
  statusColIdx: number;
  scoreColIdx: number;
  reportLinkColIdx: number;
  emailedColIdx: number;
  statusIsNew: boolean;
  scoreIsNew: boolean;
  reportLinkIsNew: boolean;
  emailedIsNew: boolean;
  statusHeader: string;
  scoreHeader: string;
  reportLinkHeader: string;
  emailedHeader: string;
} {
  const { headers, columns } = parsed;
  let cursor = headers.length;

  const statusIsNew = columns.statusColIsNew;
  const scoreIsNew = columns.scoreColIsNew;
  const reportLinkIsNew = columns.reportLinkColIsNew;
  const emailedIsNew = columns.emailedColIsNew;

  const statusColIdx = statusIsNew
    ? cursor++
    : headers.indexOf(columns.statusCol);
  const scoreColIdx = scoreIsNew
    ? cursor++
    : headers.indexOf(columns.scoreCol);
  const reportLinkColIdx = reportLinkIsNew
    ? cursor++
    : headers.indexOf(columns.reportLinkCol);
  const emailedColIdx = emailedIsNew
    ? cursor++
    : headers.indexOf(columns.emailedCol);

  return {
    statusColIdx,
    scoreColIdx,
    reportLinkColIdx,
    emailedColIdx,
    statusIsNew,
    scoreIsNew,
    reportLinkIsNew,
    emailedIsNew,
    statusHeader: columns.statusCol,
    scoreHeader: columns.scoreCol,
    reportLinkHeader: columns.reportLinkCol,
    emailedHeader: columns.emailedCol,
  };
}

export function safeFilenameFromIdentifier(
  identifier: string,
  rowIndex: number
): string {
  const clean = identifier
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  if (!clean) return `Row_${rowIndex + 2}`;
  return clean;
}

/**
 * Build the PDF filename for a row. Prefers the user's email (per requirement),
 * falls back to the display identifier, and finally to a row number.
 * Returns a name WITHOUT the .pdf extension.
 */
export function reportFilenameBase(
  email: string | null,
  identifier: string,
  rowIndex: number
): string {
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Drive supports @ in filenames; keep email as-is.
    return email;
  }
  return safeFilenameFromIdentifier(identifier, rowIndex);
}
