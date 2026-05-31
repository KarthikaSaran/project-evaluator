"use client";

import { useCallback, useState } from "react";

interface FileUploadProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
  accept: string;
  label: string;
  multiple?: boolean;
}

export default function FileUpload({
  files,
  onFilesChange,
  accept,
  label,
  multiple = true,
}: FileUploadProps) {
  const [isDragging, setIsDragging] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const dropped = Array.from(e.dataTransfer.files);
      if (multiple) {
        onFilesChange([...files, ...dropped]);
      } else {
        onFilesChange(dropped.slice(0, 1));
      }
    },
    [files, onFilesChange, multiple]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selected = Array.from(e.target.files || []);
      if (multiple) {
        onFilesChange([...files, ...selected]);
      } else {
        onFilesChange(selected.slice(0, 1));
      }
    },
    [files, onFilesChange, multiple]
  );

  const removeFile = (index: number) => {
    onFilesChange(files.filter((_, i) => i !== index));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const getFileIcon = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase();
    switch (ext) {
      case "ipynb":
        return "📓";
      case "py":
        return "🐍";
      case "zip":
        return "📦";
      case "xlsx":
      case "xls":
        return "📊";
      case "docx":
        return "📄";
      default:
        return "📎";
    }
  };

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl p-8 text-center transition-all duration-200 cursor-pointer ${
          isDragging
            ? "border-blue-500 bg-blue-50"
            : "border-gray-300 hover:border-gray-400 bg-gray-50"
        }`}
        onClick={() => document.getElementById(`file-input-${label}`)?.click()}
      >
        <input
          id={`file-input-${label}`}
          type="file"
          accept={accept}
          multiple={multiple}
          onChange={handleFileInput}
          className="hidden"
        />
        <div className="text-4xl mb-3">
          {isDragging ? "📥" : "☁️"}
        </div>
        <p className="text-gray-600 font-medium">{label}</p>
        <p className="text-sm text-gray-400 mt-1">
          Drag & drop or click to browse
        </p>
        <p className="text-xs text-gray-400 mt-1">
          Supported: .ipynb, .py, .zip, .xlsx
        </p>
      </div>

      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, idx) => (
            <div
              key={`${file.name}-${idx}`}
              className="flex items-center justify-between bg-white border border-gray-200 rounded-lg px-4 py-2.5"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-xl flex-shrink-0">
                  {getFileIcon(file.name)}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-700 truncate">
                    {file.name}
                  </p>
                  <p className="text-xs text-gray-400">
                    {formatSize(file.size)}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(idx);
                }}
                className="text-gray-400 hover:text-red-500 transition-colors ml-3 flex-shrink-0"
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
