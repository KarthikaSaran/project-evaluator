"use client";

import { useState } from "react";
import CategorySelector from "@/components/CategorySelector";
import FileUpload from "@/components/FileUpload";
import ResultCard from "@/components/ResultCard";
import DriveSheetMode from "@/components/DriveSheetMode";
import GoogleSignIn from "@/components/GoogleSignIn";
import { ProjectCategory, EvaluationResult } from "@/lib/types";
import rawProjectData from "@/lib/projectData.json";
import { parseDriveSheet } from "@/lib/driveSheetClient";
import { extractSpreadsheetId } from "@/lib/driveUpload";
import type { SourceSheetMeta } from "@/components/DriveSheetMode";

const ALL_PROJECTS = rawProjectData as Array<{ id: string }>;

type AppState = "upload" | "evaluating" | "drive-sheet" | "results";

export default function Home() {
  const [state, setState] = useState<AppState>("upload");
  const [category, setCategory] = useState<ProjectCategory>("ml-mini-project");
  const [files, setFiles] = useState<File[]>([]);
  const [problemStatementFile, setProblemStatementFile] = useState<File[]>([]);
  const [problemStatementText, setProblemStatementText] = useState("");
  const [results, setResults] = useState<EvaluationResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [driveSheetFile, setDriveSheetFile] = useState<File | null>(null);
  const [sourceMeta, setSourceMeta] = useState<SourceSheetMeta>({
    kind: "upload",
  });
  const [sheetLink, setSheetLink] = useState("");
  const [fetchingSheet, setFetchingSheet] = useState(false);

  const handleCategoryChange = (cat: ProjectCategory) => {
    setCategory(cat);
  };

  /**
   * Fetch an xlsx or Google Sheet from a Drive link and return it as a File.
   * For Google Sheets the server exports to xlsx via the Drive API (needs sign-in).
   */
  const fetchSheetFromDriveLink = async (link: string): Promise<File> => {
    const response = await fetch("/api/fetch-sheet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ driveLink: link }),
    });
    const data = await response.json();
    if (!data.ok || !data.contentBase64) {
      throw new Error(
        data.error || data.status || "Could not fetch sheet from Drive link"
      );
    }
    const binary = atob(data.contentBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new File([bytes], data.filename || "drive_sheet.xlsx", {
      type:
        data.mimeType ||
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  };

  // ----- Decide drive-sheet vs files mode on the client by peeking at xlsx -----
  const looksLikeDriveSheet = async (file: File): Promise<boolean> => {
    try {
      const buf = await file.arrayBuffer();
      // parseDriveSheet throws if no link column can be detected
      const parsed = parseDriveSheet(buf);
      // Require at least one row with an actual Drive-looking URL
      const hits = parsed.rows.filter((r) =>
        /drive\.google\.com|colab\.research\.google\.com|docs\.google\.com/.test(
          r.driveLink
        )
      ).length;
      return hits > 0;
    } catch {
      return false;
    }
  };

  const isXlsx = (f: File) => /\.(xlsx|xls)$/i.test(f.name);

  // ------------------------------------------------------------ submit
  const handleSubmit = async () => {
    const hasFiles = files.length > 0;
    const hasLink = sheetLink.trim().length > 0;

    if (!hasFiles && !hasLink) {
      setError("Upload a file or paste a Drive link to a sheet.");
      return;
    }
    if (hasFiles && hasLink) {
      setError(
        "Either upload files OR paste a Drive link, not both. Clear one and try again."
      );
      return;
    }
    setError(null);

    let inputFiles: File[] = files;

    // -- Drive link mode: fetch the xlsx/Google Sheet first --
    if (hasLink) {
      setFetchingSheet(true);
      try {
        const file = await fetchSheetFromDriveLink(sheetLink.trim());
        inputFiles = [file];

        // If the link pointed to a Google Sheet, remember the spreadsheet ID
        // so DriveSheetMode can write Score/Status/Report Link back in place.
        const spreadsheetId = extractSpreadsheetId(sheetLink.trim());
        setSourceMeta(
          spreadsheetId
            ? { kind: "google-sheet", spreadsheetId }
            : { kind: "upload" }
        );
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Could not fetch sheet from Drive"
        );
        setFetchingSheet(false);
        return;
      }
      setFetchingSheet(false);
    } else {
      setSourceMeta({ kind: "upload" });
    }

    // Auto-detect Drive Links Spreadsheet — single .xlsx whose cells look like Drive URLs
    if (inputFiles.length === 1 && isXlsx(inputFiles[0])) {
      const isDriveSheet = await looksLikeDriveSheet(inputFiles[0]);
      if (isDriveSheet) {
        setDriveSheetFile(inputFiles[0]);
        setState("drive-sheet");
        return;
      }
    }

    // Otherwise: standard per-file evaluation flow (project auto-detected server-side)
    setState("evaluating");
    setResults([]);

    try {
      const totalFiles = inputFiles.length;
      setProgress({ current: 0, total: totalFiles });

      const allResults: EvaluationResult[] = [];

      for (let i = 0; i < inputFiles.length; i++) {
        setProgress({ current: i + 1, total: totalFiles });

        const formData = new FormData();
        formData.append("files", inputFiles[i]);
        formData.append("category", category);

        if (category === "bring-your-own") {
          if (problemStatementFile.length > 0) {
            const reader = new FileReader();
            const psText = await new Promise<string>((resolve) => {
              reader.onload = () => resolve(reader.result as string);
              reader.readAsText(problemStatementFile[0]);
            });
            formData.append("problemStatement", psText);
          } else if (problemStatementText) {
            formData.append("problemStatement", problemStatementText);
          }
        }

        const response = await fetch("/api/evaluate", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Evaluation failed");
        }

        const data = await response.json();
        allResults.push(...data.results);
      }

      setResults(allResults);
      setState("results");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred"
      );
      setState("upload");
    }
  };

  const handleDownloadPDF = async (result: EvaluationResult) => {
    setDownloadingId(result.id);
    try {
      const response = await fetch("/api/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result }),
      });
      if (!response.ok) throw new Error("PDF generation failed");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Evaluation_Report_${result.submissionName
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 50)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "PDF download failed"
      );
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDownloadAll = async () => {
    for (const result of results) {
      await handleDownloadPDF(result);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  const handleReset = () => {
    setState("upload");
    setFiles([]);
    setProblemStatementFile([]);
    setProblemStatementText("");
    setResults([]);
    setError(null);
    setProgress({ current: 0, total: 0 });
    setDriveSheetFile(null);
    setSheetLink("");
    setFetchingSheet(false);
  };

  const hasBYOPStep = category === "bring-your-own";
  const uploadStepNumber = 1 + (hasBYOPStep ? 1 : 0) + 1; // category + (BYOP) + upload

  return (
    <main className="min-h-screen">
      <header className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white font-bold text-lg">
              PE
            </div>
            <div>
              <h1 className="font-bold text-gray-900 text-lg">
                Project Evaluator
              </h1>
              <p className="text-xs text-gray-500">
                AI-Powered Submission Analysis
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <GoogleSignIn />
            {(state === "results" || state === "drive-sheet") && (
              <button
                type="button"
                onClick={handleReset}
                className="text-sm text-gray-600 hover:text-gray-900 flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                New Evaluation
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        {state === "upload" && (
          <div className="space-y-8">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900">
                Evaluate Project Submissions
              </h2>
              <p className="text-gray-500 mt-2 max-w-2xl mx-auto">
                Upload submission files or a spreadsheet of Drive links. The AI
                figures out which of the {ALL_PROJECTS.length} known projects
                each submission belongs to and grades it.
              </p>
            </div>

            {/* Step 1: Category */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
              <h3 className="font-semibold text-gray-800 mb-4">
                1. Select Project Category
              </h3>
              <CategorySelector value={category} onChange={handleCategoryChange} />
            </div>

            {/* BYOP problem statement (only for "bring your own") */}
            {hasBYOPStep && (
              <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
                <h3 className="font-semibold text-gray-800 mb-4">
                  2. Provide Problem Statement
                </h3>
                <div className="space-y-4">
                  <FileUpload
                    files={problemStatementFile}
                    onFilesChange={setProblemStatementFile}
                    accept=".docx,.txt,.pdf,.md"
                    label="Upload problem statement file"
                    multiple={false}
                  />
                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-gray-200" />
                    </div>
                    <div className="relative flex justify-center text-xs">
                      <span className="bg-white px-3 text-gray-400">or paste below</span>
                    </div>
                  </div>
                  <textarea
                    value={problemStatementText}
                    onChange={(e) => setProblemStatementText(e.target.value)}
                    placeholder="Paste your problem statement here..."
                    rows={6}
                    className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none resize-none text-gray-800"
                  />
                </div>
              </div>
            )}

            {/* Upload — accepts files or a Drive-links spreadsheet */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
              <h3 className="font-semibold text-gray-800 mb-2">
                {uploadStepNumber}. Upload Submissions
              </h3>
              <p className="text-xs text-gray-500 mb-4">
                Drop individual files (<code className="bg-gray-100 px-1 rounded">.ipynb</code>,{" "}
                <code className="bg-gray-100 px-1 rounded">.py</code>,{" "}
                <code className="bg-gray-100 px-1 rounded">.zip</code>) or a single{" "}
                <code className="bg-gray-100 px-1 rounded">.xlsx</code> containing Google
                Drive links — the app detects which mode to use. For domain-restricted
                Drive links (e.g. shared with @interviewkickstart.com), sign in first
                using the button in the top right.
              </p>
              <FileUpload
                files={files}
                onFilesChange={setFiles}
                accept=".ipynb,.py,.zip,.xlsx,.xls"
                label="Drop submission files or a Drive-links .xlsx"
              />

              <div className="relative my-5">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200" />
                </div>
                <div className="relative flex justify-center text-xs">
                  <span className="bg-white px-3 text-gray-400">
                    or paste a Drive link to an xlsx / Google Sheet
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <input
                  type="url"
                  value={sheetLink}
                  onChange={(e) => setSheetLink(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/... or https://drive.google.com/file/d/..."
                  className="w-full rounded-xl border border-gray-200 px-4 py-3 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none text-gray-800"
                />
                <p className="text-xs text-gray-400">
                  Google Sheets are exported as .xlsx automatically (needs sign-in).
                  Plain .xlsx Drive files work either signed in or via public sharing.
                </p>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
                <svg
                  className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleSubmit}
              disabled={(files.length === 0 && !sheetLink.trim()) || fetchingSheet}
              className="w-full py-3.5 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-semibold text-sm hover:from-blue-700 hover:to-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
            >
              {fetchingSheet
                ? "Fetching sheet from Drive..."
                : files.length > 0
                  ? `Evaluate ${files.length} Submission${files.length !== 1 ? "s" : ""}`
                  : sheetLink.trim()
                    ? "Fetch & Evaluate Sheet"
                    : "Evaluate"}
            </button>
          </div>
        )}

        {state === "drive-sheet" && driveSheetFile && (
          <DriveSheetMode
            category={category}
            initialFile={driveSheetFile}
            stepNumber={uploadStepNumber}
            sourceMeta={sourceMeta}
            onReset={handleReset}
          />
        )}

        {state === "evaluating" && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="relative w-20 h-20 mb-6">
              <div className="absolute inset-0 rounded-full border-4 border-blue-100" />
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-600 animate-spin" />
              <div
                className="absolute inset-3 rounded-full border-4 border-transparent border-t-indigo-500 animate-spin"
                style={{ animationDirection: "reverse", animationDuration: "1.5s" }}
              />
            </div>
            <h3 className="text-xl font-semibold text-gray-800 mb-2">
              Evaluating Submissions
            </h3>
            <p className="text-gray-500 text-sm mb-4">
              {progress.current > 0
                ? `Processing file ${progress.current} of ${progress.total}...`
                : "Preparing evaluation..."}
            </p>
            <div className="w-64 bg-gray-200 rounded-full h-2">
              <div
                className="bg-gradient-to-r from-blue-600 to-indigo-600 h-2 rounded-full transition-all duration-500"
                style={{
                  width: `${
                    progress.total > 0 ? (progress.current / progress.total) * 100 : 0
                  }%`,
                }}
              />
            </div>
            <p className="text-xs text-gray-400 mt-6 max-w-sm text-center">
              AI is analyzing code quality, methodology, and generating detailed feedback.
              This may take a few minutes per submission.
            </p>
          </div>
        )}

        {state === "results" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-2xl font-bold text-gray-900">Evaluation Results</h2>
                <p className="text-gray-500 text-sm mt-1">
                  {results.length} submission{results.length !== 1 ? "s" : ""} evaluated
                </p>
              </div>
              {results.length > 1 && (
                <button
                  type="button"
                  onClick={handleDownloadAll}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition-colors"
                >
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                    />
                  </svg>
                  Download All PDFs
                </button>
              )}
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            <div className="space-y-4">
              {results.map((result) => (
                <ResultCard
                  key={result.id}
                  result={result}
                  onDownloadPDF={handleDownloadPDF}
                  isDownloading={downloadingId === result.id}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
