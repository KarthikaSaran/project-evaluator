import { NextRequest, NextResponse } from "next/server";
import { generatePDFReport } from "@/lib/pdfGenerator";
import { EvaluationResult } from "@/lib/types";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result: EvaluationResult = body.result;

    if (!result) {
      return NextResponse.json(
        { error: "Evaluation result is required" },
        { status: 400 }
      );
    }

    const pdfBuffer = await generatePDFReport(result);

    const sanitizedName = result.submissionName
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 50);

    return new NextResponse(new Uint8Array(pdfBuffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Evaluation_Report_${sanitizedName}.pdf"`,
        "Content-Length": pdfBuffer.length.toString(),
      },
    });
  } catch (error) {
    console.error("PDF generation error:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `PDF generation failed: ${message}` },
      { status: 500 }
    );
  }
}
