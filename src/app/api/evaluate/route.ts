import { NextRequest, NextResponse } from "next/server";
import { parseUploadedFile } from "@/lib/fileParser";
import { evaluateSubmission } from "@/lib/evaluator";
import { ProjectCategory, SubmissionFile } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const category = formData.get("category") as ProjectCategory;
    const customProblemStatement = formData.get("problemStatement") as
      | string
      | null;

    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: "No files uploaded" },
        { status: 400 }
      );
    }

    if (!category) {
      return NextResponse.json(
        { error: "Category is required" },
        { status: 400 }
      );
    }

    const results = [];

    for (const file of files) {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsedFiles: SubmissionFile[] = await parseUploadedFile(
        buffer,
        file.name
      );

      if (
        file.name.endsWith(".xlsx") ||
        file.name.endsWith(".xls")
      ) {
        for (const parsedFile of parsedFiles) {
          const evaluation = await evaluateSubmission(
            [parsedFile],
            category,
            customProblemStatement || undefined
          );
          results.push(evaluation);
        }
      } else {
        const evaluation = await evaluateSubmission(
          parsedFiles,
          category,
          customProblemStatement || undefined
        );
        results.push(evaluation);
      }
    }

    return NextResponse.json({ results });
  } catch (error) {
    console.error("Evaluation error:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Evaluation failed: ${message}` },
      { status: 500 }
    );
  }
}
