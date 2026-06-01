"use client";

import { useEffect, useRef, useState } from "react";
import FileUpload from "./FileUpload";
import GoogleSignIn, { AuthStatus } from "./GoogleSignIn";
import { ProjectCategory, EvaluationResult } from "@/lib/types";
import {
  parseDriveSheet,
  buildUpdatedWorkbook,
  reportFilenameBase,
  computeSheetUpdateColumns,
  ParsedDriveSheet,
  RowUpdate,
} from "@/lib/driveSheetClient";

/** Where the input sheet came from — affects how results are written back. */
export interface SourceSheetMeta {
  /** "upload" (downloadable xlsx) or "google-sheet" (we can update in place). */
  kind: "upload" | "google-sheet";
  spreadsheetId?: string; // only for google-sheet
}

interface DriveSheetModeProps {
  category: ProjectCategory;
  projectId?: string;
  stepNumber: number;
  initialFile?: File | null;
  /** If the parent resolved a folder URL (user pasted a folder), pre-fill the
      PDF-output field with it so they don't have to paste it twice. */
  initialFolderUrl?: string | null;
  sourceMeta?: SourceSheetMeta;
  onReset?: () => void;
}

type Phase = "upload" | "preview" | "evaluating" | "done";

interface RowProgress {
  rowIndex: number;
  identifier: string;
  email: string | null;
  driveLink: string;
  state: "pending" | "running" | "success" | "skipped" | "failed";
  status: string;
  score?: string;
  scorePct?: number;
  reportLink?: string;
  uploadError?: string;
  /** Email-send outcome: "Sent" | "Sending..." | "Failed - reason" | "No email" | undefined */
  emailed?: string;
  emailFailed?: boolean;
  error?: string;
  /** Held on success so the "Send Reports" step can regenerate the PDF. */
  result?: EvaluationResult;
}

const SUCCESS_STATUS = "Evaluation done";

export default function DriveSheetMode({
  category,
  projectId,
  stepNumber,
  initialFile,
  initialFolderUrl,
  sourceMeta,
  onReset,
}: DriveSheetModeProps) {
  const [files, setFiles] = useState<File[]>(initialFile ? [initialFile] : []);
  const [phase, setPhase] = useState<Phase>(initialFile ? "preview" : "upload");
  const [parsed, setParsed] = useState<ParsedDriveSheet | null>(null);
  const [rowProgress, setRowProgress] = useState<RowProgress[]>([]);
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedXlsxBlob, setUpdatedXlsxBlob] = useState<Blob | null>(null);
  const [building, setBuilding] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  // PDF upload to Drive — optional. Pre-filled if the parent resolved a
  // folder URL when the user pasted one in the main input.
  const [folderUrl, setFolderUrl] = useState(initialFolderUrl || "");
  // Email send is a separate verified action triggered AFTER review.
  const [emailSending, setEmailSending] = useState(false);
  const [emailingDone, setEmailingDone] = useState(false);
  const [sheetUpdateStatus, setSheetUpdateStatus] = useState<
    "idle" | "running" | "ok" | "error"
  >("idle");
  const [sheetUpdateError, setSheetUpdateError] = useState<string | null>(null);

  const previewedRef = useRef(false);

  useEffect(() => {
    if (initialFile && !previewedRef.current) {
      previewedRef.current = true;
      void doParse(initialFile);
    }
  }, [initialFile]);

  // Independent auth-status fetch so the Email button state never relies on
  // an upstream UI piece being mounted/visible. Refreshed on mount and after
  // operations that might consume the session.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/google/status", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: AuthStatus) => {
        if (!cancelled) setAuthStatus(data);
      })
      .catch(() => {
        if (!cancelled)
          setAuthStatus({ signedIn: false, configured: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------- parsing
  const doParse = async (file: File) => {
    setError(null);
    try {
      const buf = await file.arrayBuffer();
      const p = parseDriveSheet(buf);
      setParsed(p);
      setRowProgress(
        p.rows.map((r) => ({
          rowIndex: r.rowIndex,
          identifier: r.identifier,
          email: r.email,
          driveLink: r.driveLink,
          state: r.shouldSkip ? "skipped" : "pending",
          status: r.shouldSkip ? r.skipReason || "Skipped" : "",
        }))
      );
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse spreadsheet");
      setPhase("upload");
    }
  };

  const handlePreview = async () => {
    if (files.length === 0) {
      setError("Please upload the Drive Links spreadsheet first.");
      return;
    }
    await doParse(files[0]);
  };

  // ------------------------------------------------------- main run loop
  const handleRunAll = async () => {
    if (!parsed) return;
    setError(null);
    setPhase("evaluating");

    const wantsDriveUpload = folderUrl.trim().length > 0;

    const newResults: EvaluationResult[] = [];
    const updated: RowProgress[] = rowProgress.map((r) => ({ ...r }));
    setRowProgress(updated);

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      if (row.shouldSkip) continue;

      updated[i] = {
        ...updated[i],
        state: "running",
        status: "Evaluating...",
      };
      setRowProgress([...updated]);

      try {
        const response = await fetch("/api/evaluate/drive-row", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            driveLink: row.driveLink,
            category,
            projectId: projectId || undefined,
            identifier: row.identifier,
            email: row.email || undefined,
          }),
        });
        const data = await response.json();

        if (data.ok && data.result) {
          const result = data.result as EvaluationResult;
          newResults.push(result);
          updated[i] = {
            ...updated[i],
            state: "success",
            status: SUCCESS_STATUS,
            score: `${result.percentageScore}%`,
            scorePct: result.percentageScore,
            // Hold the result so the (post-verification) email step can
            // re-generate the PDF without redoing the OpenAI call.
            result,
          };
          setRowProgress([...updated]);

          // Generate PDF and optionally upload to Drive. Email is NOT sent
          // here — it's a separate, explicit step on the done screen so the
          // user can verify the report before anything customer-facing.
          if (wantsDriveUpload) {
            try {
              const pdfResp = await fetch("/api/generate-report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ result }),
              });
              if (pdfResp.ok) {
                const pdfBlob = await pdfResp.blob();
                const pdfBase64 = await blobToBase64(pdfBlob);
                const filenameBase = reportFilenameBase(
                  row.email,
                  row.identifier,
                  row.rowIndex
                );
                const upResp = await fetch("/api/drive/upload-pdf", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    folderUrl: folderUrl.trim(),
                    filename: `${filenameBase}.pdf`,
                    pdfBase64,
                  }),
                });
                const upData = await upResp.json();
                if (upData.ok && upData.webViewLink) {
                  updated[i] = {
                    ...updated[i],
                    reportLink: upData.webViewLink,
                  };
                } else {
                  updated[i] = {
                    ...updated[i],
                    uploadError: upData.error || "Upload failed",
                  };
                }
              }
            } catch (e) {
              updated[i] = {
                ...updated[i],
                uploadError:
                  e instanceof Error ? e.message : "Upload failed",
              };
            }
            setRowProgress([...updated]);
          }
        } else {
          updated[i] = {
            ...updated[i],
            state: "failed",
            status: data.status || "Evaluation failed",
            error: data.error,
          };
        }
      } catch (e) {
        updated[i] = {
          ...updated[i],
          state: "failed",
          status: "Network error",
          error: e instanceof Error ? e.message : "Unknown error",
        };
      }
      setRowProgress([...updated]);
    }

    setResults(newResults);
    await buildDownloads(updated, newResults);

    // Update the source Google Sheet in place (if input was a Sheet link)
    if (sourceMeta?.kind === "google-sheet" && sourceMeta.spreadsheetId) {
      await updateSourceSheet(updated);
    }

    setPhase("done");
  };

  // --------------------------------------------------- build zip + xlsx
  const buildDownloads = async (
    finalRowProgress: RowProgress[],
    finalResults: EvaluationResult[]
  ) => {
    if (!parsed) return;
    setBuilding(true);
    try {
      const sheetUpdates: RowUpdate[] = finalRowProgress
        .filter((r) => r.state === "success" || r.state === "failed")
        .map((r) => ({
          rowIndex: r.rowIndex,
          status: r.status,
          score: r.score,
          reportLink: r.reportLink,
          emailed: r.emailed,
        }));

      // Only generate a downloadable xlsx for uploaded files (for Google
      // Sheet input we write back in place via the API instead).
      if (sourceMeta?.kind !== "google-sheet") {
        const xlsxBuf = buildUpdatedWorkbook(parsed, sheetUpdates);
        setUpdatedXlsxBlob(
          new Blob([xlsxBuf], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          })
        );
      }

      // PDF ZIP no longer built — every PDF is already uploaded to the
      // user's Drive folder during the eval loop, so an offline ZIP would
      // just duplicate that. Drops both the build time and the memory cost.
    } finally {
      setBuilding(false);
    }
  };

  // ------------------------- send emails (post-verification, opt-in click)
  const handleSendEmails = async () => {
    if (!parsed) return;
    setEmailSending(true);

    const updated = rowProgress.map((r) => ({ ...r }));

    for (let i = 0; i < updated.length; i++) {
      const row = updated[i];
      if (row.state !== "success" || !row.result) continue;

      if (!row.email) {
        updated[i] = {
          ...row,
          emailed: "No email in row",
          emailFailed: true,
        };
        setRowProgress([...updated]);
        continue;
      }

      // mark sending
      updated[i] = { ...row, emailed: "Sending..." };
      setRowProgress([...updated]);

      try {
        const pdfResp = await fetch("/api/generate-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ result: row.result }),
        });
        if (!pdfResp.ok) throw new Error("PDF generation failed");
        const pdfBlob = await pdfResp.blob();
        const pdfBase64 = await blobToBase64(pdfBlob);

        const filenameBase = reportFilenameBase(
          row.email,
          row.identifier,
          row.rowIndex
        );

        const emResp = await fetch("/api/email/send-report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toEmail: row.email,
            pdfBase64,
            pdfFilename: `${filenameBase}.pdf`,
            context: {
              projectName: row.result.detectedProject || "Your Project",
              percentage: row.result.percentageScore,
              rating: row.result.overallRating,
            },
          }),
        });
        const emData = await emResp.json();

        if (emData.ok) {
          updated[i] = { ...updated[i], emailed: "Sent", emailFailed: false };
        } else {
          updated[i] = {
            ...updated[i],
            emailed: shortenError(emData.error || "Email failed"),
            emailFailed: true,
          };
        }
      } catch (e) {
        updated[i] = {
          ...updated[i],
          emailed: shortenError(
            e instanceof Error ? e.message : "Email failed"
          ),
          emailFailed: true,
        };
      }
      setRowProgress([...updated]);
    }

    // Re-write Emailed column into the source Sheet if applicable
    if (sourceMeta?.kind === "google-sheet" && sourceMeta.spreadsheetId) {
      await updateSourceSheet(updated);
    }

    setEmailSending(false);
    setEmailingDone(true);
  };

  // -------------------------------------------- update source Sheet in place
  const updateSourceSheet = async (finalRowProgress: RowProgress[]) => {
    if (!parsed || !sourceMeta?.spreadsheetId) return;
    setSheetUpdateStatus("running");
    setSheetUpdateError(null);
    try {
      const cols = computeSheetUpdateColumns(parsed);

      const updates = finalRowProgress
        .filter((r) => r.state === "success" || r.state === "failed")
        .map((r) => ({
          rowIndex: r.rowIndex,
          status: r.status,
          score: r.score,
          reportLink: r.reportLink,
          emailed: r.emailed,
        }));

      if (updates.length === 0) {
        setSheetUpdateStatus("idle");
        return;
      }

      const resp = await fetch("/api/sheets/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spreadsheetId: sourceMeta.spreadsheetId,
          sheetName: parsed.sheetName,
          updates,
          cols,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        setSheetUpdateStatus("error");
        setSheetUpdateError(data.error || "Sheet update failed");
        return;
      }
      setSheetUpdateStatus("ok");
    } catch (e) {
      setSheetUpdateStatus("error");
      setSheetUpdateError(
        e instanceof Error ? e.message : "Sheet update failed"
      );
    }
  };

  // ------------------------------------------------------------ downloads
  const triggerDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadXlsx = () => {
    if (updatedXlsxBlob) {
      const base = files[0]?.name.replace(/\.xlsx?$/i, "") || "submissions";
      triggerDownload(updatedXlsxBlob, `${base}_evaluated.xlsx`);
    }
  };

  /** Inline-download fallback: generate the PDF for one row's result and
      trigger a browser download. Used when there's no Drive folder set or
      the Drive upload failed — gives the user a way to actually see the
      report instead of a dead "—" in the Report column. */
  const handleDownloadRowPdf = async (row: RowProgress) => {
    if (!row.result) return;
    try {
      const pdfResp = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: row.result }),
      });
      if (!pdfResp.ok) throw new Error("PDF generation failed");
      const pdfBlob = await pdfResp.blob();
      const url = URL.createObjectURL(pdfBlob);
      const a = document.createElement("a");
      a.href = url;
      const name = reportFilenameBase(row.email, row.identifier, row.rowIndex);
      a.download = `${name}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not generate PDF for download"
      );
    }
  };

  const handleReset = () => {
    setFiles([]);
    setPhase("upload");
    setParsed(null);
    setRowProgress([]);
    setResults([]);
    setError(null);
    setUpdatedXlsxBlob(null);
    setFolderUrl("");
    setEmailSending(false);
    setEmailingDone(false);
    setSheetUpdateStatus("idle");
    setSheetUpdateError(null);
    previewedRef.current = false;
    onReset?.();
  };

  // ------------------------------------------------------------------ derived
  const totalRows = parsed?.rows.length || 0;
  const toEvaluate = parsed?.rows.filter((r) => !r.shouldSkip).length || 0;
  const toSkip = totalRows - toEvaluate;
  const completed = rowProgress.filter(
    (r) => r.state === "success" || r.state === "failed" || r.state === "skipped"
  ).length;
  const runningRow = rowProgress.find((r) => r.state === "running");
  const successCount = rowProgress.filter((r) => r.state === "success").length;
  const failedCount = rowProgress.filter((r) => r.state === "failed").length;
  const uploadedCount = rowProgress.filter((r) => r.reportLink).length;
  const uploadErrorCount = rowProgress.filter((r) => r.uploadError).length;
  const emailedCount = rowProgress.filter(
    (r) => r.emailed === "Sent"
  ).length;
  const emailErrorCount = rowProgress.filter(
    (r) => r.emailFailed
  ).length;

  const isGoogleSheetSource = sourceMeta?.kind === "google-sheet";
  const wantsDriveUpload = folderUrl.trim().length > 0;
  const needsSignInForUploads = wantsDriveUpload && !authStatus?.signedIn;
  const needsSignInForSheetUpdate =
    isGoogleSheetSource && !authStatus?.signedIn;
  const showSignInNudge =
    !!authStatus &&
    authStatus.configured &&
    !authStatus.signedIn &&
    (needsSignInForUploads || needsSignInForSheetUpdate || phase === "preview");

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-6">
      {phase === "upload" && (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h3 className="font-semibold text-gray-800 mb-2">
              {stepNumber}. Upload Drive Links Spreadsheet
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              An <code className="bg-gray-100 px-1 rounded">.xlsx</code> where each row
              contains a Google Drive link to a single submission file. Auto-detects
              link / identifier / email / status / score columns.
            </p>
            <FileUpload
              files={files}
              onFilesChange={setFiles}
              accept=".xlsx,.xls"
              label="Upload .xlsx with Drive links (one file)"
              multiple={false}
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <button
            type="button"
            onClick={handlePreview}
            disabled={files.length === 0}
            className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-semibold text-sm hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
          >
            Inspect Sheet
          </button>
        </>
      )}

      {(phase === "preview" || phase === "evaluating" || phase === "done") &&
        parsed && (
          <div className="space-y-6">
            <SignInBanner show={showSignInNudge} onAuthChange={setAuthStatus} />

            <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-800">Sheet Detected</h3>
                {phase !== "evaluating" && (
                  <button
                    type="button"
                    onClick={handleReset}
                    className="text-xs text-gray-500 hover:text-gray-800"
                  >
                    Upload a different sheet
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <DetectedField label="Sheet" value={parsed.sheetName} />
                <DetectedField
                  label="Drive link column"
                  value={parsed.columns.linkCol}
                />
                <DetectedField
                  label="Identifier column"
                  value={parsed.columns.idCol || "(none — using row #)"}
                />
                <DetectedField
                  label="Email column"
                  value={
                    parsed.columns.emailCol ||
                    "(none — PDF names use identifier)"
                  }
                />
                <DetectedField
                  label="Score column"
                  value={`${parsed.columns.scoreCol}${
                    parsed.columns.scoreColIsNew ? " (will add)" : ""
                  }`}
                />
                <DetectedField
                  label="Status column"
                  value={`${parsed.columns.statusCol}${
                    parsed.columns.statusColIsNew ? " (will add)" : ""
                  }`}
                />
                <DetectedField
                  label="Report Link column"
                  value={`${parsed.columns.reportLinkCol}${
                    parsed.columns.reportLinkColIsNew ? " (will add)" : ""
                  }`}
                />
                <DetectedField label="To evaluate" value={String(toEvaluate)} />
              </div>
              <div className="text-xs text-gray-400 mt-3">
                {totalRows} rows total · {toSkip} skipped (already done / no link)
                {isGoogleSheetSource && (
                  <span className="ml-2 text-blue-600">
                    · source is a Google Sheet — will write Status / Score /
                    Report Link back in place
                  </span>
                )}
              </div>
            </div>

            {phase === "preview" && (
              <>
                <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-800">
                      Upload PDF reports to Drive{" "}
                      <span className="text-xs font-normal text-gray-400">
                        (optional)
                      </span>
                    </h3>
                  </div>
                  <p className="text-xs text-gray-500">
                    Paste a Drive folder URL. We&apos;ll upload one PDF per
                    successful evaluation named after the submitter&apos;s
                    email. Re-runs overwrite existing files so the Drive URL
                    stays stable. Needs Google sign-in.
                  </p>
                  {initialFolderUrl && folderUrl === initialFolderUrl && (
                    <p className="text-xs text-blue-600 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                      ✓ Pre-filled from the folder you pasted earlier. Change
                      it if you want PDFs to land somewhere else.
                    </p>
                  )}
                  <input
                    type="url"
                    value={folderUrl}
                    onChange={(e) => setFolderUrl(e.target.value)}
                    placeholder="https://drive.google.com/drive/folders/..."
                    className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none text-gray-800"
                  />
                  {wantsDriveUpload && !authStatus?.signedIn && (
                    <p className="text-xs text-amber-700">
                      Sign in with Google to enable uploads.
                    </p>
                  )}
                </div>

                <RowList
                  rows={rowProgress}
                  emailEnabled={false}
                  onDownloadRow={handleDownloadRowPdf}
                />

                {error && (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                    <p className="text-sm text-red-700">{error}</p>
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleRunAll}
                  disabled={toEvaluate === 0}
                  className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-semibold text-sm hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
                >
                  Evaluate {toEvaluate} Submission{toEvaluate !== 1 ? "s" : ""}
                  {toSkip > 0 && (
                    <span className="opacity-80 font-normal ml-2">
                      ({toSkip} skipped)
                    </span>
                  )}
                </button>
              </>
            )}

            {phase === "evaluating" && (
              <>
                <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-semibold text-gray-800">Evaluating...</h3>
                    <div className="text-xs text-gray-500">
                      {completed} / {totalRows} processed · {successCount} ok ·{" "}
                      {failedCount} failed
                      {wantsDriveUpload && (
                        <> · {uploadedCount} uploaded</>
                      )}
                    </div>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
                    <div
                      className="bg-gradient-to-r from-blue-600 to-indigo-600 h-2 rounded-full transition-all duration-500"
                      style={{
                        width: `${
                          totalRows > 0 ? (completed / totalRows) * 100 : 0
                        }%`,
                      }}
                    />
                  </div>
                  {runningRow && (
                    <p className="text-xs text-gray-500">
                      Now evaluating:{" "}
                      <span className="font-medium text-gray-700">
                        {runningRow.identifier}
                      </span>
                    </p>
                  )}
                </div>

                <RowList
                  rows={rowProgress}
                  emailEnabled={false}
                  onDownloadRow={handleDownloadRowPdf}
                />
              </>
            )}

            {phase === "done" && (
              <>
                <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                  <h3 className="font-semibold text-gray-800 mb-4">
                    Evaluation Summary
                  </h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
                    <StatTile label="Evaluated" value={successCount} tone="success" />
                    <StatTile label="Failed" value={failedCount} tone="danger" />
                    <StatTile
                      label="Skipped"
                      value={rowProgress.filter((r) => r.state === "skipped").length}
                      tone="muted"
                    />
                    {wantsDriveUpload && (
                      <StatTile
                        label="Uploaded to Drive"
                        value={uploadedCount}
                        tone={
                          uploadErrorCount > 0 ? "danger" : "success"
                        }
                      />
                    )}
                    {emailingDone && (
                      <StatTile
                        label="Emails sent"
                        value={emailedCount}
                        tone={emailErrorCount > 0 ? "danger" : "success"}
                      />
                    )}
                  </div>
                </div>


                {isGoogleSheetSource && (
                  <div
                    className={`rounded-2xl border p-4 text-sm ${
                      sheetUpdateStatus === "ok"
                        ? "bg-green-50 border-green-200 text-green-800"
                        : sheetUpdateStatus === "error"
                          ? "bg-red-50 border-red-200 text-red-800"
                          : "bg-gray-50 border-gray-200 text-gray-700"
                    }`}
                  >
                    {sheetUpdateStatus === "running" && "Updating source Google Sheet..."}
                    {sheetUpdateStatus === "ok" &&
                      "Source Google Sheet updated with Score / Status / Report Link."}
                    {sheetUpdateStatus === "error" && (
                      <>
                        Source sheet update failed:{" "}
                        <span className="font-mono text-xs">
                          {sheetUpdateError}
                        </span>
                      </>
                    )}
                    {sheetUpdateStatus === "idle" && (
                      <>No rows to write back to the source sheet.</>
                    )}
                  </div>
                )}

                {/* PDFs are auto-uploaded to the Drive folder — no need for
                    a ZIP. Only show the xlsx download for non-Google-Sheet
                    inputs (Google Sheet inputs are updated in place). */}
                {!isGoogleSheetSource && (
                  <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                    <button
                      type="button"
                      onClick={handleDownloadXlsx}
                      disabled={!updatedXlsxBlob || building}
                      className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      <DownloadIcon />
                      Download Updated Sheet (.xlsx)
                    </button>
                  </div>
                )}

                <RowList
                  rows={rowProgress}
                  emailEnabled={emailSending || emailingDone}
                  onDownloadRow={handleDownloadRowPdf}
                />

                {/* Prominent Send Email Reports panel — replaces both the old
                    Actions row's email button and the "Start a New Sheet"
                    reset button. The red note enforces a manual verification
                    step before anything customer-facing goes out. */}
                {(() => {
                  const sendable = rowProgress.filter(
                    (r) => r.state === "success" && r.email
                  ).length;
                  const noEmailColumn = !parsed.columns.emailCol;
                  return (
                    <div className="bg-white rounded-2xl border-2 border-indigo-200 p-6 shadow-sm space-y-3">
                      <button
                        type="button"
                        onClick={handleSendEmails}
                        disabled={
                          emailSending ||
                          emailingDone ||
                          successCount === 0 ||
                          !authStatus?.signedIn
                        }
                        className="w-full flex items-center justify-center gap-2 px-4 py-3.5 bg-indigo-600 text-white rounded-xl text-sm font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-md shadow-indigo-100"
                      >
                        <EmailIcon />
                        {emailSending
                          ? "Sending..."
                          : emailingDone
                            ? `Emails sent (${emailedCount})`
                            : sendable > 0
                              ? `Send Email Reports (${sendable})`
                              : "Send Email Reports"}
                      </button>

                      <div className="bg-red-50 border border-red-300 rounded-lg px-4 py-3">
                        <p className="text-sm text-red-700 font-medium">
                          ⚠ Please verify all the report PDFs in your Drive
                          folder before sending the emails. Once sent, the
                          messages go out from your Google account to the
                          submitters and cannot be recalled.
                        </p>
                      </div>

                      {successCount > 0 && sendable === 0 && (
                        <p className="text-xs text-amber-700">
                          {noEmailColumn
                            ? `No email column was detected in your sheet (header didn't match "Email" / "E-mail" / "Email Address" / etc.). Add or rename a column so the app can pick it up, then re-run.`
                            : `The detected email column "${parsed.columns.emailCol}" has no values for the evaluated rows.`}
                        </p>
                      )}
                      {!authStatus?.signedIn && (
                        <p className="text-xs text-amber-700">
                          Sign in with Google (top right) to enable sending.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}
    </div>
  );
}

// ----------------------------------------------------------------- helpers

function shortenError(s: string): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > 80 ? trimmed.slice(0, 77) + "..." : trimmed;
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  // Chunk to avoid stack overflow on large arrays
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ----------------------------------------------------------------- subviews

function SignInBanner({
  show,
  onAuthChange,
}: {
  show: boolean;
  onAuthChange: (s: AuthStatus) => void;
}) {
  return (
    <div
      className={`${
        show ? "" : "hidden"
      } bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center justify-between gap-3`}
    >
      <div className="text-sm text-amber-800">
        Sign in with Google to access domain-restricted Drive links, upload
        report PDFs, and update Google Sheets in place.
      </div>
      <GoogleSignIn onChange={onAuthChange} compact />
    </div>
  );
}

function DetectedField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-gray-400">
        {label}
      </div>
      <div className="text-gray-800 font-medium mt-0.5 truncate">{value}</div>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "success" | "danger" | "muted";
}) {
  const toneClasses = {
    success: "bg-green-50 text-green-700 border-green-200",
    danger: "bg-red-50 text-red-700 border-red-200",
    muted: "bg-gray-50 text-gray-700 border-gray-200",
  }[tone];
  return (
    <div className={`rounded-xl border p-3 ${toneClasses}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs mt-0.5">{label}</div>
    </div>
  );
}

function RowList({
  rows,
  emailEnabled = false,
  onDownloadRow,
}: {
  rows: RowProgress[];
  emailEnabled?: boolean;
  onDownloadRow?: (r: RowProgress) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden shadow-sm">
      <div className="max-h-[420px] overflow-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">
                #
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">
                Identifier
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">
                Status
              </th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">
                Score
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">
                Report
              </th>
              {emailEnabled && (
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-600 uppercase">
                  Email
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.rowIndex}
                className="border-t border-gray-100 hover:bg-gray-50"
              >
                <td className="px-4 py-2 text-gray-500">{r.rowIndex + 2}</td>
                <td className="px-4 py-2 text-gray-800 max-w-xs truncate">
                  {r.identifier}
                  {r.email && r.email !== r.identifier && (
                    <span className="block text-[10px] text-gray-400 truncate">
                      {r.email}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <StatusBadge state={r.state} text={r.status || "—"} />
                  {r.error && (
                    <span className="block text-[10px] text-red-500 mt-0.5 truncate max-w-xs">
                      {r.error}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-right font-medium text-gray-700">
                  {r.score || "—"}
                </td>
                <td className="px-4 py-2 text-xs">
                  {r.reportLink ? (
                    <a
                      href={r.reportLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline truncate inline-block max-w-[200px] align-bottom"
                    >
                      Open
                    </a>
                  ) : r.state === "success" && r.result && onDownloadRow ? (
                    <button
                      type="button"
                      onClick={() => onDownloadRow(r)}
                      className="text-blue-600 hover:underline cursor-pointer bg-transparent border-0 p-0"
                      title={
                        r.uploadError
                          ? `Drive upload failed (${r.uploadError}). Click to download the PDF directly.`
                          : "No Drive folder set — click to download the PDF directly"
                      }
                    >
                      Download
                    </button>
                  ) : r.uploadError ? (
                    <span
                      className="text-red-500 truncate inline-block max-w-[200px]"
                      title={r.uploadError}
                    >
                      Upload err
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                {emailEnabled && (
                  <td className="px-4 py-2 text-xs">
                    {r.emailed === "Sent" ? (
                      <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 px-2 py-0.5 rounded-full">
                        ✓ Sent
                      </span>
                    ) : r.emailed ? (
                      <span
                        className="inline-flex items-center gap-1 text-red-700 bg-red-50 px-2 py-0.5 rounded-full truncate max-w-[200px]"
                        title={r.emailed}
                      >
                        {r.emailed}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({
  state,
  text,
}: {
  state: RowProgress["state"];
  text: string;
}) {
  const palette: Record<RowProgress["state"], string> = {
    pending: "bg-gray-100 text-gray-600",
    running: "bg-blue-100 text-blue-700 animate-pulse",
    success: "bg-green-100 text-green-700",
    skipped: "bg-amber-100 text-amber-700",
    failed: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`inline-block text-xs px-2 py-0.5 rounded-full ${palette[state]}`}
    >
      {text}
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
      />
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 8l9 6 9-6M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
      />
    </svg>
  );
}
