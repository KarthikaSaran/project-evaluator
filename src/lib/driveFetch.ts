/**
 * Google Drive file fetcher.
 *
 * Supports two modes:
 *
 *   1. Authenticated (accessToken provided)
 *      - Uses Drive API v3: works for files the signed-in user has view access
 *        to, including domain-restricted shares like @interviewkickstart.com.
 *      - Returns Drive's actual filename and mimeType via the metadata call.
 *
 *   2. Anonymous fallback (no token)
 *      - Hits drive.usercontent.google.com — works ONLY for files set to
 *        "Anyone with the link can view".
 *
 * Folders and Google Docs/Sheets/Slides links are not supported in either mode
 * (folders need a separate list call; Docs need an export-as-binary call).
 */

export type DriveErrorType =
  | "folder"
  | "google-doc"
  | "no-access"
  | "invalid-url"
  | "unsupported-type"
  | "auth-required"
  | "other";

export interface DriveFetchResult {
  ok: boolean;
  data?: Buffer;
  filename?: string;
  mimeType?: string;
  error?: string;
  errorType?: DriveErrorType;
}

export interface ParsedDriveLink {
  kind: "file" | "folder" | "google-doc" | "invalid";
  id?: string;
  docType?: "document" | "spreadsheets" | "presentation";
}

export function parseDriveLink(url: string): ParsedDriveLink {
  if (!url || typeof url !== "string") return { kind: "invalid" };
  const trimmed = url.trim();
  if (!trimmed) return { kind: "invalid" };

  let m = trimmed.match(
    /drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/
  );
  if (m) return { kind: "folder", id: m[1] };

  m = trimmed.match(
    /docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/
  );
  if (m) {
    return {
      kind: "google-doc",
      id: m[2],
      docType: m[1] as "document" | "spreadsheets" | "presentation",
    };
  }

  m = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: "file", id: m[1] };

  m = trimmed.match(/colab\.research\.google\.com\/drive\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: "file", id: m[1] };

  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && /drive\.google\.com/.test(trimmed)) return { kind: "file", id: m[1] };

  return { kind: "invalid" };
}

function extractFilenameFromDisposition(disposition: string): string | null {
  if (!disposition) return null;
  const star = disposition.match(/filename\*=(?:UTF-8'')?([^;\n]+)/i);
  if (star) {
    try {
      return decodeURIComponent(star[1].replace(/^["']|["']$/g, ""));
    } catch {
      return star[1].replace(/^["']|["']$/g, "");
    }
  }
  const plain = disposition.match(/filename=("([^"]+)"|([^;\n]+))/i);
  if (plain) {
    return (plain[2] || plain[3] || "").trim() || null;
  }
  return null;
}

const SUPPORTED_EXTENSIONS = new Set([
  "ipynb",
  "py",
  "zip",
  "txt",
  "md",
  "json",
  "csv",
  "html",
]);

const COLAB_MIME = "application/vnd.google.colaboratory";
const GSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Fetch a spreadsheet for use as INPUT (the Drive-links sheet itself).
 *
 * Unlike fetchDriveFile (which is for individual submission files), this
 * accepts Google Sheets — exporting them as .xlsx via the Drive API.
 * Anything else (Docs, Slides, folders) is rejected.
 */
export async function fetchDriveSpreadsheet(
  url: string,
  accessToken?: string
): Promise<DriveFetchResult> {
  const parsed = parseDriveLink(url);

  if (parsed.kind === "invalid") {
    return { ok: false, error: "Invalid Drive URL", errorType: "invalid-url" };
  }
  if (parsed.kind === "folder") {
    return {
      ok: false,
      error: "Folder link not supported - share a single sheet",
      errorType: "folder",
    };
  }

  if (parsed.kind === "google-doc") {
    if (parsed.docType !== "spreadsheets") {
      return {
        ok: false,
        error: "Only Google Sheets are supported as input, not Docs/Slides",
        errorType: "google-doc",
      };
    }
    if (!accessToken) {
      return {
        ok: false,
        error:
          "Sign in with Google to access Google Sheets links (anonymous access only works for .xlsx files set to 'Anyone with the link').",
        errorType: "auth-required",
      };
    }
    return exportGoogleSheetAsXlsx(parsed.id!, accessToken);
  }

  // Regular Drive file — reuse the normal file fetch path
  return fetchDriveFile(url, accessToken);
}

async function exportGoogleSheetAsXlsx(
  id: string,
  accessToken: string
): Promise<DriveFetchResult> {
  // 1) Confirm access + grab the real filename
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,trashed&supportsAllDrives=true`;
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!metaResp.ok) {
    return mapDriveApiError(metaResp.status, await metaResp.text());
  }
  const meta = (await metaResp.json()) as DriveMetadata;
  if (meta.trashed) {
    return { ok: false, error: "Sheet is in trash", errorType: "no-access" };
  }
  if (meta.mimeType !== GSHEET_MIME) {
    return {
      ok: false,
      error: `Expected a Google Sheet but got ${meta.mimeType}`,
      errorType: "unsupported-type",
    };
  }

  // 2) Export as xlsx
  const exportUrl = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(
    XLSX_MIME
  )}`;
  const dlResp = await fetch(exportUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!dlResp.ok) {
    return mapDriveApiError(dlResp.status, await dlResp.text());
  }

  const buf = Buffer.from(await dlResp.arrayBuffer());
  const filename = ensureExtension(meta.name || `sheet_${id}`, ".xlsx");

  return { ok: true, data: buf, filename, mimeType: XLSX_MIME };
}

export async function fetchDriveFile(
  url: string,
  accessToken?: string
): Promise<DriveFetchResult> {
  const parsed = parseDriveLink(url);

  if (parsed.kind === "invalid") {
    return { ok: false, error: "Invalid Drive URL", errorType: "invalid-url" };
  }
  if (parsed.kind === "folder") {
    return {
      ok: false,
      error: "Folder link not supported - share a single file",
      errorType: "folder",
    };
  }
  if (parsed.kind === "google-doc") {
    return {
      ok: false,
      error: `${parsed.docType} link not supported - export as .ipynb/.py/.zip and share that`,
      errorType: "google-doc",
    };
  }

  const id = parsed.id!;
  return accessToken
    ? fetchViaDriveApi(id, accessToken)
    : fetchAnonymous(id);
}

// -------------------------------------------------------- authenticated mode

interface DriveMetadata {
  name?: string;
  mimeType?: string;
  size?: string;
  trashed?: boolean;
}

async function fetchViaDriveApi(
  id: string,
  accessToken: string
): Promise<DriveFetchResult> {
  // 1) Get metadata first — confirms access and gives us the real filename
  const metaUrl = `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size,trashed&supportsAllDrives=true`;
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!metaResp.ok) {
    return mapDriveApiError(metaResp.status, await metaResp.text());
  }

  const meta = (await metaResp.json()) as DriveMetadata;
  if (meta.trashed) {
    return { ok: false, error: "File is in trash", errorType: "no-access" };
  }

  const rawName = meta.name || `drive_${id}`;
  const mimeType = meta.mimeType || "application/octet-stream";

  // Colab notebooks: export as .ipynb (otherwise alt=media returns nothing useful)
  if (mimeType === COLAB_MIME) {
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=application/vnd.google.colaboratory`;
    const expResp = await fetch(exportUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (expResp.ok) {
      const buf = Buffer.from(await expResp.arrayBuffer());
      const filename = ensureExtension(rawName, ".ipynb");
      return { ok: true, data: buf, filename, mimeType: "application/json" };
    }
    // fall through to alt=media — Drive sometimes lets us download directly
  }

  // 2) Download the bytes
  const downloadUrl = `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`;
  const dlResp = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!dlResp.ok) {
    return mapDriveApiError(dlResp.status, await dlResp.text());
  }

  const buf = Buffer.from(await dlResp.arrayBuffer());

  let filename = rawName;
  if (mimeType === COLAB_MIME && !filename.toLowerCase().endsWith(".ipynb")) {
    filename = ensureExtension(filename, ".ipynb");
  }

  return { ok: true, data: buf, filename, mimeType };
}

function mapDriveApiError(status: number, body: string): DriveFetchResult {
  if (status === 401) {
    return {
      ok: false,
      error: "Session expired — sign in again",
      errorType: "auth-required",
    };
  }
  if (status === 403) {
    return {
      ok: false,
      error:
        "Signed-in account doesn't have view access to this file (check sharing)",
      errorType: "no-access",
    };
  }
  if (status === 404) {
    return {
      ok: false,
      error: "File not found - link may be wrong or file deleted",
      errorType: "no-access",
    };
  }
  return {
    ok: false,
    error: `Drive API error (HTTP ${status}): ${body.slice(0, 200)}`,
    errorType: "other",
  };
}

function ensureExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

// --------------------------------------------------------- anonymous fallback

async function fetchAnonymous(id: string): Promise<DriveFetchResult> {
  const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=0&confirm=t`;

  try {
    const response = await fetch(downloadUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ProjectEvaluator/1.0)",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        error: `Drive returned HTTP ${response.status} - file may be private or removed. Sign in if it's a domain-restricted share.`,
        errorType: "no-access",
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const contentDisp = response.headers.get("content-disposition") || "";

    if (contentType.includes("text/html") && !contentDisp) {
      return {
        ok: false,
        error:
          "File is not publicly accessible. Sign in with the account that has view access, or set sharing to 'Anyone with the link'.",
        errorType: "auth-required",
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 2000) {
      const head = buffer.slice(0, 200).toString("utf-8").toLowerCase();
      if (head.includes("<!doctype html") || head.includes("<html")) {
        return {
          ok: false,
          error:
            "File is not publicly accessible. Sign in with the account that has view access.",
          errorType: "auth-required",
        };
      }
    }

    let filename =
      extractFilenameFromDisposition(contentDisp) || `drive_${id}`;
    filename = filename.replace(/[\r\n]/g, "").trim();

    const ext = filename.split(".").pop()?.toLowerCase() || "";
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return {
        ok: true,
        data: buffer,
        filename,
        mimeType: contentType,
      };
    }

    return {
      ok: true,
      data: buffer,
      filename,
      mimeType: contentType,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Drive fetch failed",
      errorType: "other",
    };
  }
}

export function statusFromErrorType(t: DriveErrorType | undefined): string {
  switch (t) {
    case "folder":
      return "Folder link not supported";
    case "google-doc":
      return "Google Docs not supported - export the file";
    case "no-access":
      return "No drive access";
    case "auth-required":
      return "Sign in required";
    case "invalid-url":
      return "Invalid Drive URL";
    case "unsupported-type":
      return "Unsupported file type";
    default:
      return "Drive fetch failed";
  }
}
