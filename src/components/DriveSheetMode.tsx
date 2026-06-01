"use client";

import { useState } from "react";
import JSZip from "jszip";
import FileUpload from "./FileUpload";
import { ProjectCategory, EvaluationResult } from "@/lib/types";
import {
  parseDriveSheet,
  buildUpdatedWorkbook,
  safeFilenameFromIdentifier,
  ParsedDriveSheet,
  RowUpdate,
} from "@/lib/driveSheetClient";

interface DriveSheetModeProps {
  category: ProjectCategory;
  projectId: string;
  stepNumber: number;
}

type Phase = "upload" | "preview" | "evaluating" | "done";

interface RowProgress {
  rowIndex: number;
  identifier: string;
  driveLink: string;
  state: "pending" | "running" | "success" | "skipped" | "failed";
  status: string;
  score?: string;
  scorePct?: number;
  error?: string;
}

const SUCCESS_STATUS = "Evaluation done";

export default function DriveSheetMode({
  category,
  projectId,
  stepNumber,
}: DriveSheetModeProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>("upload");
  const [parsed, setParsed] = useState<ParsedDriveSheet | null>(null);
  const [rowProgress, setRowProgress] = useState<RowProgress[]>([]);
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updatedXlsxBlob, setUpdatedXlsxBlob] = useState<Blob | null>(null);
  const [zipBlob, setZipBlob] = useState<Blob | null>(null);
  const [building, setBuilding] = useState(false);

  // ------------------------------------------------------------- handle parse
  const handlePreview = async () => {
    setError(null);
    if (files.length === 0) {
      setError("Please upload the Drive Links spreadsheet first.");
      return;
    }
    try {
      const buf = await files[0].arrayBuffer();
      const p = parseDriveSheet(buf);
      setParsed(p);

      const initial: RowProgress[] = p.rows.map((r) => ({
        rowIndex: r.rowIndex,
        identifier: r.identifier,
        driveLink: r.driveLink,
        state: r.shouldSkip ? "skipped" : "pending",
        status: r.shouldSkip ? r.skipReason || "Skipped" : "",
      }));
      setRowProgress(initial);
      setPhase("preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not parse spreadsheet");
    }
  };

  // ------------------------------------------------------------- run all
  const handleRunAll = async () => {
    if (!parsed) return;
    setError(null);
    setPhase("evaluating");

    const newResults: EvaluationResult[] = [];
    const updated: RowProgress[] = rowProgress.map((r) => ({ ...r }));
    setRowProgress(updated);

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      if (row.shouldSkip) continue;

      // mark running
      updated[i] = { ...updated[i], state: "running", status: "Evaluating..." };
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
    setPhase("done");
  };

  // --------------------------------------------------- build zip + updated xlsx
  const buildDownloads = async (
    finalRowProgress: RowProgress[],
    finalResults: EvaluationResult[]
  ) => {
    if (!parsed) return;
    setBuilding(true);
    try {
      // 1) Build the updated workbook
      const sheetUpdates: RowUpdate[] = finalRowProgress
        .filter(
          (r) => r.state === "success" || r.state === "failed"
        )
        .map((r) => ({
          rowIndex: r.rowIndex,
          status: r.status,
          score: r.score,
        }));

      const xlsxBuf = buildUpdatedWorkbook(parsed, sheetUpdates);
      setUpdatedXlsxBlob(
        new Blob([xlsxBuf], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })
      );

      // 2) Build a ZIP of PDF reports (one per successful result)
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
            const baseName = safeFilenameFromIdentifier(
              result.submissionName,
              rp?.rowIndex ?? 0
            );
            zip.file(`Evaluation_Report_${baseName}.pdf`, pdfBuf);
          } catch {
            // skip individual PDF failures
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

  // ------------------------------------------------------------- downloads
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
  };

  // ----------------------------------------------------------------- render
  const totalRows = parsed?.rows.length || 0;
  const toEvaluate = parsed?.rows.filter((r) => !r.shouldSkip).length || 0;
  const toSkip = totalRows - toEvaluate;
  const completed = rowProgress.filter(
    (r) => r.state === "success" || r.state === "failed" || r.state === "skipped"
  ).length;
  const runningRow = rowProgress.find((r) => r.state === "running");
  const successCount = rowProgress.filter((r) => r.state === "success").length;
  const failedCount = rowProgress.filter((r) => r.state === "failed").length;

  return (
    <div className="space-y-6">
      {phase === "upload" && (
        <>
          <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <h3 className="font-semibold text-gray-800 mb-2">
              {stepNumber}. Upload Drive Links Spreadsheet
            </h3>
            <p className="text-xs text-gray-500 mb-4">
              An <code className="bg-gray-100 px-1 rounded">.xlsx</code> where each row contains a
              public Google Drive link (set to{" "}
              <em>Anyone with the link can view</em>) pointing to a single submission file
              (.ipynb, .py, .zip, etc.). The app will auto-detect link, identifier, status, and
              score columns. Folder links and Google Docs links are not supported (yet).
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

      {(phase === "preview" || phase === "evaluating" || phase === "done") && parsed && (
        <div className="space-y-6">
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
              <DetectedField label="Drive link column" value={parsed.columns.linkCol} />
              <DetectedField
                label="Identifier column"
                value={parsed.columns.idCol || "(none — using row #)"}
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
              <DetectedField label="Total rows" value={String(totalRows)} />
              <DetectedField label="To evaluate" value={String(toEvaluate)} />
              <DetectedField label="To skip (already done / no link)" value={String(toSkip)} />
            </div>
          </div>

          {phase === "preview" && (
            <>
              <RowList rows={rowProgress} />

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
                    {completed} / {totalRows} processed · {successCount} ok · {failedCount}{" "}
                    failed
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

              <RowList rows={rowProgress} />
            </>
          )}

          {phase === "done" && (
            <>
              <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                <h3 className="font-semibold text-gray-800 mb-4">Evaluation Summary</h3>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <StatTile label="Evaluated" value={successCount} tone="success" />
                  <StatTile label="Failed" value={failedCount} tone="danger" />
                  <StatTile
                    label="Skipped"
                    value={
                      rowProgress.filter((r) => r.state === "skipped").length
                    }
                    tone="muted"
                  />
                </div>
              </div>

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
                <p className="text-xs text-gray-500 mt-2">
                  Re-upload the updated sheet next time — rows marked &ldquo;{SUCCESS_STATUS}
                  &rdquo; will be skipped, and any failed/blank rows will be re-tried.
                </p>
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

// ----------------------------------------------------------------- subviews

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

function RowList({ rows }: { rows: RowProgress[] }) {
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
    <span className={`inline-block text-xs px-2 py-0.5 rounded-full ${palette[state]}`}>
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
