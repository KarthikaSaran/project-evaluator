"use client";

import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
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
  /** Email-send outcome: "Sent" | "Failed - reason" | "No email" | undefined */
  emailed?: string;
  emailFailed?: boolean;
  error?: string;
}

const SUCCESS_STATUS = "Evaluation done";

export default function DriveSheetMode({
  category,
  projectId,
  stepNumber,
  initialFile,
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
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);
  const [building, setBuilding] = useState(false);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);

  // PDF upload to Drive — optional
  const [folderUrl, setFolderUrl] = useState("");
  // Email submitters their report — optional
  const [emailReports, setEmailReports] = useState(false);
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
    const wantsEmail = emailReports;

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
          };
          setRowProgress([...updated]);

          // Generate PDF and (optionally) upload to Drive — inline so the
          // sheet update at the end has the report link for this row.
          let pdfBlob: Blob | null = null;
          try {
            const pdfResp = await fetch("/api/generate-report", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ result }),
            });
            if (pdfResp.ok) pdfBlob = await pdfResp.blob();
          } catch {
            // PDF generation failed — sheet still gets Status/Score
          }

          // We may need the base64 PDF for both upload and email — compute once.
          let pdfBase64: string | null = null;
          let pdfFilenameBase = "";
          if (pdfBlob && (wantsDriveUpload || wantsEmail)) {
            pdfFilenameBase = reportFilenameBase(
              row.email,
              row.identifier,
              row.rowIndex
            );
            pdfBase64 = await blobToBase64(pdfBlob);
          }

          if (wantsDriveUpload && pdfBlob && pdfBase64) {
            try {
              const filename = `${pdfFilenameBase}.pdf`;
              const upResp = await fetch("/api/drive/upload-pdf", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  folderUrl: folderUrl.trim(),
                  filename,
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
            } catch (e) {
              updated[i] = {
                ...updated[i],
                uploadError:
                  e instanceof Error ? e.message : "Upload failed",
              };
            }
            setRowProgress([...updated]);
          }

          if (wantsEmail) {
            if (!row.email) {
              updated[i] = {
                ...updated[i],
                emailed: "No email in row",
                emailFailed: true,
              };
            } else if (!pdfBase64) {
              updated[i] = {
                ...updated[i],
                emailed: "No PDF available",
                emailFailed: true,
              };
            } else {
              try {
                const emResp = await fetch("/api/email/send-report", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    toEmail: row.email,
                    pdfBase64,
                    pdfFilename: `${pdfFilenameBase}.pdf`,
                    context: {
                      projectName: result.detectedProject || "Your Project",
                      percentage: result.percentageScore,
                      rating: result.overallRating,
                    },
                  }),
                });
                const emData = await emResp.json();
                if (emData.ok) {
                  updated[i] = {
                    ...updated[i],
                    emailed: "Sent",
                    emailFailed: false,
                  };
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

      // ZIP of PDFs is still useful even when uploading to Drive (offline backup).
      if (finalResults.length > 0) {
        const zip = new JSZip();
        for (const result of finalResults) {
          try {
            const pdfResp = await fetch("/api/generate-report", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ result }),
            });
            if (!pdfResp.ok) continue;
            const pdfBuf = await pdfResp.arrayBuffer();
            const rp = finalRowProgress.find(
              (r) => r.identifier === result.submissionName
            );
            const baseName = reportFilenameBase(
              rp?.email || null,
              result.submissionName,
              rp?.rowIndex ?? 0
            );
            zip.file(`${baseName}.pdf`, pdfBuf);
          } catch {
            // skip individual failures
          }
        }
        const zipBuf = await zip.generateAsync({ type: "blob" });
        setZipBlob(zipBuf);
      } else {
        setZipBlob(null);
      }
    } finally {
      setBuilding(false);
    }
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

  const handleDownloadZip = () => {
    if (zipBlob) {
      triggerDownload(
        zipBlob,
        `Evaluation_Reports_${new Date().toISOString().slice(0, 10)}.zip`
      );
    }
  };

  const handleDownloadXlsx = () => {
    if (updatedXlsxBlob) {
      const base = files[0]?.name.replace(/\.xlsx?$/i, "") || "submissions";
      triggerDownload(updatedXlsxBlob, `${base}_evaluated.xlsx`);
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
    setZipBlob(null);
    setFolderUrl("");
    setEmailReports(false);
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

                <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm space-y-3">
                  <h3 className="font-semibold text-gray-800">
                    Email PDF reports to submitters{" "}
                    <span className="text-xs font-normal text-gray-400">
                      (optional)
                    </span>
                  </h3>
                  <label className="flex items-start gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={emailReports}
                      onChange={(e) => setEmailReports(e.target.checked)}
                      className="mt-0.5 w-4 h-4 accent-blue-600 cursor-pointer"
                    />
                    <span className="text-sm text-gray-700">
                      After each successful evaluation, email the PDF report
                      to the submitter&apos;s address from the sheet&apos;s
                      email column.{" "}
                      <span className="text-gray-400">
                        Email is sent from your signed-in Google account; the
                        recipient sees it as coming from you.
                      </span>
                    </span>
                  </label>
                  {emailReports && (
                    <ul className="text-xs text-gray-500 ml-7 space-y-1">
                      <li>
                        Detected email column:{" "}
                        <span className="font-medium text-gray-700">
                          {parsed.columns.emailCol || "(none — rows without email will be skipped)"}
                        </span>
                      </li>
                      <li>
                        Subject: <em>Your Project Evaluation Report — {`{project name}`}</em>
                      </li>
                      <li>
                        Attachment: the same PDF that goes to the Drive folder
                        (named after the submitter&apos;s email).
                      </li>
                    </ul>
                  )}
                  {emailReports && !authStatus?.signedIn && (
                    <p className="text-xs text-amber-700">
                      Sign in with Google to enable email sending.
                    </p>
                  )}
                </div>

                <RowList rows={rowProgress} emailEnabled={emailReports} />

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
                      {emailReports && <> · {emailedCount} emailed</>}
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

                <RowList rows={rowProgress} emailEnabled={emailReports} />
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
                    {emailReports && (
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

                <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm space-y-3">
                  <h3 className="font-semibold text-gray-800">Downloads</h3>
                  {building && (
                    <p className="text-xs text-gray-500">Building bundle...</p>
                  )}
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={handleDownloadZip}
                      disabled={!zipBlob || building}
                      className="flex items-center gap-2 px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
                    >
                      <DownloadIcon />
                      Download PDFs (ZIP) — {successCount} report
                      {successCount !== 1 ? "s" : ""}
                    </button>
                    {!isGoogleSheetSource && (
                      <button
                        type="button"
                        onClick={handleDownloadXlsx}
                        disabled={!updatedXlsxBlob || building}
                        className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
                      >
                        <DownloadIcon />
                        Download Updated Sheet (.xlsx)
                      </button>
                    )}
                  </div>
                </div>

                <RowList rows={rowProgress} />

                <button
                  type="button"
                  onClick={handleReset}
                  className="w-full py-2.5 border border-gray-300 text-gray-700 rounded-xl text-sm font-medium hover:bg-gray-50"
                >
                  Start a New Sheet
                </button>
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
}: {
  rows: RowProgress[];
  emailEnabled?: boolean;
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
                  ) : r.uploadError ? (
                    <span className="text-red-500 truncate inline-block max-w-[200px]">
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
