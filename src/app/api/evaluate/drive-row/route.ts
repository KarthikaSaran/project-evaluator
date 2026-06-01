import { NextRequest, NextResponse } from "next/server";
import { parseUploadedFile } from "@/lib/fileParser";
import { evaluateSubmission } from "@/lib/evaluator";
import { fetchDriveFile, statusFromErrorType } from "@/lib/driveFetch";
import { ProjectCategory } from "@/lib/types";

export const maxDuration = 300;

interface RequestBody {
  driveLink: string;
  category: ProjectCategory;
  projectId?: string;
  identifier?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as RequestBody;
    const { driveLink, category, projectId, identifier } = body;

    if (!driveLink) {
      return NextResponse.json(
        { ok: false, status: "No Drive link", error: "driveLink is required" },
        { status: 400 }
      );
    }
    if (!category) {
      return NextResponse.json(
        { ok: false, status: "Missing category", error: "category is required" },
        { status: 400 }
      );
    }

    const fetched = await fetchDriveFile(driveLink);

    if (!fetched.ok || !fetched.data) {
      return NextResponse.json({
        ok: false,
        status: statusFromErrorType(fetched.errorType),
        error: fetched.error || "Drive fetch failed",
      });
    }

    const filename = fetched.filename || "drive_submission";

    let parsedFiles;
    try {
      parsedFiles = await parseUploadedFile(fetched.data, filename);
    } catch (e) {
      return NextResponse.json({
        ok: false,
        status: "Could not parse file",
        error: e instanceof Error ? e.message : "Parse failed",
      });
    }

    if (!parsedFiles || parsedFiles.length === 0) {
      return NextResponse.json({
        ok: false,
        status: "Unsupported file type",
        error: `No parseable content in ${filename}`,
      });
    }

    const evaluation = await evaluateSubmission(
      parsedFiles,
      category,
      projectId || undefined
    );

    if (identifier) {
      evaluation.submissionName = identifier;
    }

    return NextResponse.json({
      ok: true,
      status: "Evaluation done",
      result: evaluation,
      downloadedFilename: filename,
    });
  } catch (error) {
    console.error("Drive row evaluation error:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({
      ok: false,
      status: "Evaluation failed",
      error: message,
    });
  }
}
