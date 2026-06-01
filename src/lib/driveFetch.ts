/**
 * Public Google Drive file fetcher.
 *
 * Works only for files set to "Anyone with the link can view" (no auth).
 * - Folders are NOT supported (would require Drive API key for listing).
 * - Google Docs / Sheets / Slides are NOT supported (can't be downloaded as binary
 *   without an OAuth/API key + export call).
 */

export type DriveErrorType =
  | "folder"
  | "google-doc"
  | "no-access"
  | "invalid-url"
  | "unsupported-type"
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

  // Drive folder
  let m = trimmed.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: "folder", id: m[1] };

  // Google Docs / Sheets / Slides — can't download as binary without auth
  m = trimmed.match(/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/);
  if (m) {
    return {
      kind: "google-doc",
      id: m[2],
      docType: m[1] as "document" | "spreadsheets" | "presentation",
    };
  }

  // Standard /file/d/ID
  m = trimmed.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: "file", id: m[1] };

  // Colab notebook (lives in Drive)
  m = trimmed.match(/colab\.research\.google\.com\/drive\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: "file", id: m[1] };

  // /open?id=ID or /uc?id=ID
  m = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m && /drive\.google\.com/.test(trimmed)) return { kind: "file", id: m[1] };

  return { kind: "invalid" };
}

function extractFilenameFromDisposition(disposition: string): string | null {
  if (!disposition) return null;
  // RFC 5987: filename*=UTF-8''encoded-name
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
    const name = (plain[2] || plain[3] || "").trim();
    return name || null;
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

/**
 * Try downloading a publicly-shared Drive file.
 *
 * We hit `drive.usercontent.google.com/download` which is Drive's modern direct-download
 * endpoint. For public files it returns the binary directly. If the file isn't public,
 * Google returns an HTML sign-in page — we detect that via Content-Type.
 */
export async function fetchDriveFile(url: string): Promise<DriveFetchResult> {
  const parsed = parseDriveLink(url);

  if (parsed.kind === "invalid") {
    return { ok: false, error: "Invalid Drive URL", errorType: "invalid-url" };
  }
  if (parsed.kind === "folder") {
    return {
      ok: false,
      error: "Folder links not supported - share a single file",
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
  const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=0&confirm=t`;

  try {
    const response = await fetch(downloadUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; ProjectEvaluator/1.0; +https://project-evaluator-gold.vercel.app)",
      },
    });

    if (!response.ok) {
      // 403/404 typically means private file
      return {
        ok: false,
        error: `Drive returned HTTP ${response.status} - file may be private or removed`,
        errorType: "no-access",
      };
    }

    const contentType = response.headers.get("content-type") || "";
    const contentDisp = response.headers.get("content-disposition") || "";

    // HTML response = sign-in page (file isn't public)
    if (contentType.includes("text/html") && !contentDisp) {
      return {
        ok: false,
        error:
          "File is not publicly accessible - set sharing to 'Anyone with the link can view'",
        errorType: "no-access",
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Additional check: small HTML pages slip through with non-html content-types occasionally
    if (buffer.length < 2000) {
      const head = buffer.slice(0, 200).toString("utf-8").toLowerCase();
      if (head.includes("<!doctype html") || head.includes("<html")) {
        return {
          ok: false,
          error:
            "File is not publicly accessible - set sharing to 'Anyone with the link can view'",
          errorType: "no-access",
        };
      }
    }

    let filename =
      extractFilenameFromDisposition(contentDisp) || `drive_${id}`;
    filename = filename.replace(/[\r\n]/g, "").trim();

    const ext = filename.split(".").pop()?.toLowerCase() || "";
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      // Best-effort: keep going, parser will handle as text. But warn.
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
    case "invalid-url":
      return "Invalid Drive URL";
    case "unsupported-type":
      return "Unsupported file type";
    default:
      return "Drive fetch failed";
  }
}
