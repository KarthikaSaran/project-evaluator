"use client";

import { ProjectCategory, CATEGORY_LABELS } from "@/lib/types";

interface CategorySelectorProps {
  value: ProjectCategory;
  onChange: (category: ProjectCategory) => void;
}

const CATEGORY_ICONS: Record<ProjectCategory, string> = {
  "ml-mini-project": "🤖",
  "dl-mini-project": "🧠",
  "case-study-1": "📊",
  "case-study-2": "🎬",
  capstone: "🎓",
  "bring-your-own": "📁",
};

const CATEGORY_DESCRIPTIONS: Record<ProjectCategory, string> = {
  "ml-mini-project": "Lending Club Loan Approval & similar ML projects",
  "dl-mini-project": "Deep learning projects with neural networks",
  "case-study-1": "Business case study analysis",
  "case-study-2": "IMDB CineBot & similar NLP/chatbot projects",
  capstone: "End-to-end capstone projects",
  "bring-your-own": "Custom project with your own problem statement",
};

export default function CategorySelector({
  value,
  onChange,
}: CategorySelectorProps) {
  const categories = Object.keys(CATEGORY_LABELS) as ProjectCategory[];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      {categories.map((cat) => (
        <button
          key={cat}
          type="button"
          onClick={() => onChange(cat)}
          className={`relative p-4 rounded-xl border-2 text-left transition-all duration-200 ${
            value === cat
              ? "border-blue-500 bg-blue-50 shadow-md shadow-blue-100"
              : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm"
          }`}
        >
          <div className="text-2xl mb-2">{CATEGORY_ICONS[cat]}</div>
          <div
            className={`font-semibold text-sm ${value === cat ? "text-blue-700" : "text-gray-800"}`}
          >
            {CATEGORY_LABELS[cat]}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {CATEGORY_DESCRIPTIONS[cat]}
          </div>
          {value === cat && (
            <div className="absolute top-2 right-2">
              <svg
                className="w-5 h-5 text-blue-500"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
