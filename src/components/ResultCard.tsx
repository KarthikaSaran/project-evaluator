"use client";

import { EvaluationResult, CATEGORY_LABELS } from "@/lib/types";
import { useState } from "react";

interface ResultCardProps {
  result: EvaluationResult;
  onDownloadPDF: (result: EvaluationResult) => void;
  isDownloading: boolean;
}

export default function ResultCard({
  result,
  onDownloadPDF,
  isDownloading,
}: ResultCardProps) {
  const [expanded, setExpanded] = useState(false);

  const getScoreGradient = (pct: number) => {
    if (pct >= 85) return "from-green-500 to-emerald-600";
    if (pct >= 70) return "from-blue-500 to-indigo-600";
    if (pct >= 50) return "from-yellow-500 to-orange-500";
    return "from-red-500 to-rose-600";
  };

  const getRatingBadge = (rating: string) => {
    const colors: Record<string, string> = {
      Excellent: "bg-green-100 text-green-800 border-green-200",
      Good: "bg-blue-100 text-blue-800 border-blue-200",
      Fair: "bg-yellow-100 text-yellow-800 border-yellow-200",
      Poor: "bg-red-100 text-red-800 border-red-200",
    };
    return colors[rating] || "bg-gray-100 text-gray-800 border-gray-200";
  };

  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div
        className={`h-1.5 bg-gradient-to-r ${getScoreGradient(result.percentageScore)}`}
      />

      <div className="p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-800 truncate">
              {result.submissionName}
            </h3>
            <p className="text-sm text-gray-500 mt-0.5">
              {result.detectedProject} ·{" "}
              {CATEGORY_LABELS[result.category]}
            </p>
          </div>

          <div className="flex items-center gap-3 flex-shrink-0">
            <div
              className={`w-16 h-16 rounded-full bg-gradient-to-br ${getScoreGradient(result.percentageScore)} flex items-center justify-center`}
            >
              <span className="text-white font-bold text-lg">
                {result.percentageScore}%
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${getRatingBadge(result.overallRating)}`}
          >
            {result.overallRating}
          </span>
          <span className="text-xs text-gray-400">
            {result.overallScore}/{result.maxPossibleScore} points
          </span>
          {result.bonusPoints.score > 0 && (
            <span className="text-xs text-green-600">
              +{result.bonusPoints.score} bonus
            </span>
          )}
        </div>

        <p className="text-sm text-gray-600 mt-3 line-clamp-2">
          {result.summary}
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4">
          {result.sections.slice(0, 4).map((section) => (
            <div
              key={section.criterionName}
              className="bg-gray-50 rounded-lg p-2.5"
            >
              <p className="text-[10px] text-gray-500 uppercase tracking-wide truncate">
                {section.criterionName}
              </p>
              <p className="text-sm font-semibold text-gray-700 mt-0.5">
                {section.score}/{section.maxScore}
              </p>
            </div>
          ))}
        </div>

        {expanded && (
          <div className="mt-6 space-y-4">
            <div>
              <h4 className="text-sm font-semibold text-green-700 mb-2">
                Strengths
              </h4>
              <ul className="space-y-1">
                {result.pros.map((pro, i) => (
                  <li
                    key={i}
                    className="text-sm text-gray-600 flex items-start gap-2"
                  >
                    <span className="text-green-500 mt-0.5 flex-shrink-0">+</span>
                    {pro}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4 className="text-sm font-semibold text-red-700 mb-2">
                Areas for Growth
              </h4>
              <ul className="space-y-2">
                {result.cons.map((con, i) => (
                  <li key={i} className="text-sm">
                    <p className="text-gray-600 flex items-start gap-2">
                      <span className="text-red-500 mt-0.5 flex-shrink-0">-</span>
                      {con.issue}
                    </p>
                    <p className="text-blue-600 text-xs ml-5 mt-0.5">
                      Suggestion: {con.suggestion}
                    </p>
                  </li>
                ))}
              </ul>
            </div>

            {result.bonusPoints.details.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-purple-700 mb-2">
                  Bonus Points
                </h4>
                {result.bonusPoints.details.map((d, i) => (
                  <div key={i} className="text-sm text-gray-600 mb-1">
                    <span className="text-purple-600 font-medium">
                      +{d.points}
                    </span>{" "}
                    {d.feature}: {d.comment}
                  </div>
                ))}
              </div>
            )}

            <div className="bg-blue-50 rounded-xl p-4 border border-blue-100">
              <h4 className="text-sm font-semibold text-blue-800 mb-2">
                Interviewer Feedback
              </h4>
              <p className="text-sm text-gray-700 whitespace-pre-line">
                {result.interviewerFeedback}
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 mt-4 pt-4 border-t border-gray-100">
          <button
            type="button"
            onClick={() => onDownloadPDF(result)}
            disabled={isDownloading}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDownloading ? (
              <>
                <svg
                  className="animate-spin h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
                Generating...
              </>
            ) : (
              <>
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
                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
                Download PDF
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="px-4 py-2 text-gray-600 border border-gray-200 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            {expanded ? "Show Less" : "View Details"}
          </button>
        </div>
      </div>
    </div>
  );
}
