"use client";

import { ProjectData, ProjectCategory } from "@/lib/types";

interface ProjectSelectorProps {
  projects: ProjectData[];
  category: ProjectCategory;
  selectedId: string;
  onChange: (projectId: string) => void;
}

export default function ProjectSelector({
  projects,
  selectedId,
  onChange,
}: ProjectSelectorProps) {
  if (projects.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
          Select specific project
        </span>
        <button
          type="button"
          onClick={() => onChange("")}
          className={`text-xs px-2 py-0.5 rounded-full transition-colors ${
            selectedId === ""
              ? "bg-blue-100 text-blue-700"
              : "bg-gray-100 text-gray-500 hover:bg-gray-200"
          }`}
        >
          Auto-detect
        </button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => onChange(project.id)}
            className={`text-left px-4 py-3 rounded-lg border transition-all duration-150 ${
              selectedId === project.id
                ? "border-blue-500 bg-blue-50 ring-1 ring-blue-200"
                : "border-gray-200 bg-white hover:border-gray-300"
            }`}
          >
            <div
              className={`text-sm font-medium ${
                selectedId === project.id ? "text-blue-700" : "text-gray-800"
              }`}
            >
              {project.title}
            </div>
            <div className="text-xs text-gray-500 mt-1 line-clamp-2">
              {project.description}
            </div>
            <div className="text-[10px] text-gray-400 mt-1">
              {project.criteria.length} evaluation criteria
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
