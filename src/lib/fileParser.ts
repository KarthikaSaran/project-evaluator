import * as XLSX from "xlsx";
import JSZip from "jszip";
import { SubmissionFile, SpreadsheetSubmission } from "./types";

export async function parseUploadedFile(
  buffer: Buffer,
  fileName: string
): Promise<SubmissionFile[]> {
  const ext = fileName.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "ipynb":
      return [parseNotebook(buffer, fileName)];
    case "py":
      return [parsePythonFile(buffer, fileName)];
    case "zip":
      return await parseZipFile(buffer, fileName);
    case "xlsx":
    case "xls":
      return parseSpreadsheetAsSubmissions(buffer, fileName);
    case "txt":
    case "md":
      return [parseTextFile(buffer, fileName)];
    case "docx":
      return [parseDocxBasic(buffer, fileName)];
    default:
      return [
        {
          name: fileName,
          type: ext || "unknown",
          content: buffer.toString("utf-8").slice(0, 50000),
          size: buffer.length,
        },
      ];
  }
}

function parseNotebook(buffer: Buffer, fileName: string): SubmissionFile {
  const raw = buffer.toString("utf-8");
  const notebook = JSON.parse(raw);
  const cells = notebook.cells || [];

  let content = "";
  for (const cell of cells) {
    const source = Array.isArray(cell.source)
      ? cell.source.join("")
      : cell.source;
    const cellType = cell.cell_type;

    if (cellType === "markdown") {
      content += `\n### [Markdown Cell]\n${source}\n`;
    } else if (cellType === "code") {
      content += `\n### [Code Cell]\n\`\`\`python\n${source}\n\`\`\`\n`;
      if (cell.outputs && cell.outputs.length > 0) {
        content += `\n**Output:**\n`;
        for (const output of cell.outputs) {
          if (output.text) {
            const text = Array.isArray(output.text)
              ? output.text.join("")
              : output.text;
            content += text.slice(0, 2000) + "\n";
          } else if (output.data) {
            if (output.data["text/plain"]) {
              const text = Array.isArray(output.data["text/plain"])
                ? output.data["text/plain"].join("")
                : output.data["text/plain"];
              content += text.slice(0, 2000) + "\n";
            }
          }
        }
      }
    }
  }

  return {
    name: fileName,
    type: "ipynb",
    content: content.slice(0, 80000),
    size: buffer.length,
  };
}

function parsePythonFile(buffer: Buffer, fileName: string): SubmissionFile {
  return {
    name: fileName,
    type: "py",
    content: buffer.toString("utf-8").slice(0, 80000),
    size: buffer.length,
  };
}

function parseTextFile(buffer: Buffer, fileName: string): SubmissionFile {
  return {
    name: fileName,
    type: fileName.split(".").pop() || "txt",
    content: buffer.toString("utf-8").slice(0, 80000),
    size: buffer.length,
  };
}

function parseDocxBasic(buffer: Buffer, fileName: string): SubmissionFile {
  return {
    name: fileName,
    type: "docx",
    content:
      "[DOCX file - problem statement uploaded. Content will be extracted for evaluation.]",
    size: buffer.length,
  };
}

async function parseZipFile(
  buffer: Buffer,
  fileName: string
): Promise<SubmissionFile[]> {
  const zip = await JSZip.loadAsync(buffer);
  const files: SubmissionFile[] = [];

  for (const [path, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    if (path.startsWith("__MACOSX") || path.startsWith(".")) continue;

    const ext = path.split(".").pop()?.toLowerCase();
    if (!["py", "ipynb", "txt", "md", "csv", "json"].includes(ext || ""))
      continue;

    const content = await zipEntry.async("nodebuffer");
    if (ext === "ipynb") {
      files.push(parseNotebook(content, path));
    } else {
      files.push({
        name: path,
        type: ext || "unknown",
        content: content.toString("utf-8").slice(0, 50000),
        size: content.length,
      });
    }
  }

  return files;
}

function parseSpreadsheetAsSubmissions(
  buffer: Buffer,
  fileName: string
): SubmissionFile[] {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

  return rows.map((row, idx) => {
    const submission = extractSubmissionFromRow(row);
    const content = formatSubmissionContent(submission);
    return {
      name: `${fileName} - Submission ${idx + 1} (${submission.email || "unknown"})`,
      type: "xlsx-row",
      content,
      size: content.length,
    };
  });
}

function extractSubmissionFromRow(
  row: Record<string, unknown>
): SpreadsheetSubmission {
  const keys = Object.keys(row);
  const findKey = (patterns: string[]) =>
    keys.find((k) =>
      patterns.some((p) => k.toLowerCase().includes(p.toLowerCase()))
    );

  const emailKey = findKey(["email"]);
  const fileKey = findKey(["upload", "file", "python", "zip"]);
  const summaryKey = findKey(["summary", "approach"]);
  const challengeKey = findKey(["challenge", "improvement"]);
  const commentKey = findKey(["comment", "insight", "additional"]);
  const timeKey = findKey(["time", "hours"]);
  const ratingKey = findKey(["rating", "scale"]);
  const caseStudyKey = findKey(["case study", "select"]);

  return {
    email: emailKey ? String(row[emailKey] || "") : "",
    fileLink: fileKey ? String(row[fileKey] || "") : "",
    approachSummary: summaryKey ? String(row[summaryKey] || "") : "",
    challenges: challengeKey ? String(row[challengeKey] || "") : "",
    additionalComments: commentKey ? String(row[commentKey] || "") : "",
    timeSpent: timeKey ? Number(row[timeKey]) || null : null,
    rating: ratingKey ? Number(row[ratingKey]) || null : null,
    caseStudyType: caseStudyKey ? String(row[caseStudyKey] || "") : undefined,
  };
}

function formatSubmissionContent(sub: SpreadsheetSubmission): string {
  let content = "=== SUBMISSION FROM SPREADSHEET ===\n\n";
  if (sub.email) content += `Student Email: ${sub.email}\n`;
  if (sub.fileLink) content += `File Link: ${sub.fileLink}\n`;
  if (sub.caseStudyType) content += `Case Study Type: ${sub.caseStudyType}\n`;
  content += `\n--- Approach Summary ---\n${sub.approachSummary || "Not provided"}\n`;
  content += `\n--- Challenges & Future Improvements ---\n${sub.challenges || "Not provided"}\n`;
  content += `\n--- Additional Comments ---\n${sub.additionalComments || "Not provided"}\n`;
  if (sub.timeSpent) content += `\nTime Spent: ${sub.timeSpent} hours\n`;
  if (sub.rating) content += `Self Rating: ${sub.rating}/5\n`;
  return content;
}

export function extractProblemStatementFromDocx(buffer: Buffer): string {
  try {
    const text = buffer.toString("utf-8");
    const xmlContent = text.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
    if (xmlContent) {
      return xmlContent
        .map((t) => t.replace(/<[^>]+>/g, ""))
        .join(" ")
        .slice(0, 10000);
    }
    return text.slice(0, 10000);
  } catch {
    return buffer.toString("utf-8").slice(0, 10000);
  }
}
