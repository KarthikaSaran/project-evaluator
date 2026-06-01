import PDFDocument from "pdfkit";
import { EvaluationResult, EvaluationSection, CATEGORY_LABELS } from "./types";

/**
 * Compact PDF layout — targets 4-5 pages for a typical 7-criterion evaluation,
 * even for 13-criterion capstone rubrics. The previous design used a 200-300px
 * card per criterion; this version packs each criterion into ~90px.
 *
 * Page 1 — Cover (full bleed, score circle)
 * Page 2 — Score bar + summary + compact per-criterion breakdown
 * Page 3 — Strengths/weaknesses side-by-side + Scope for Improvement + Bonus
 * Page 4 — Interviewer feedback + disclaimer
 */

const COLORS = {
  primary: "#1a365d",
  secondary: "#2b6cb0",
  accent: "#3182ce",
  success: "#276749",
  warning: "#c05621",
  danger: "#c53030",
  lightBg: "#f7fafc",
  sectionBg: "#ebf4ff",
  text: "#1a202c",
  muted: "#718096",
  border: "#cbd5e0",
  white: "#ffffff",
};

function getRatingColor(rating: string): string {
  switch (rating) {
    case "Excellent":
      return COLORS.success;
    case "Good":
      return COLORS.secondary;
    case "Fair":
      return COLORS.warning;
    case "Poor":
      return COLORS.danger;
    default:
      return COLORS.muted;
  }
}

function getScoreColor(percentage: number): string {
  if (percentage >= 85) return COLORS.success;
  if (percentage >= 70) return COLORS.secondary;
  if (percentage >= 50) return COLORS.warning;
  return COLORS.danger;
}

export async function generatePDFReport(
  result: EvaluationResult
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 40, bottom: 40, left: 45, right: 45 },
      bufferPages: true,
      info: {
        Title: `Evaluation Report - ${result.submissionName}`,
        Author: "Project Evaluator",
        Subject: "Submission Evaluation Report",
      },
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width - 90;

    // Page 1
    renderCoverPage(doc, result, pageWidth);

    // Page 2 — summary + per-criterion compact list
    doc.addPage();
    renderSummaryAndBreakdown(doc, result, pageWidth);

    // Page 3 — strengths/weaknesses/scope/bonus
    doc.addPage();
    renderOverview(doc, result, pageWidth);

    // Page 4 — interviewer feedback
    doc.addPage();
    renderInterviewerFeedback(doc, result, pageWidth);

    // Footer (page X of Y) on every page that exists
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(7)
        .fillColor(i === 0 ? "#a0aec0" : COLORS.muted)
        .text(
          `Page ${i + 1} of ${totalPages}`,
          45,
          doc.page.height - 25,
          { align: "center", width: pageWidth }
        );
    }

    doc.end();
  });
}

// ============================================================ Page 1 — Cover

function renderCoverPage(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.primary);
  doc.rect(0, 0, doc.page.width, 8).fill(COLORS.accent);

  doc.y = 170;
  doc
    .fontSize(28)
    .fillColor(COLORS.white)
    .text("PROJECT EVALUATION", 45, doc.y, {
      align: "center",
      width: pageWidth,
    });

  doc.moveDown(0.3);
  doc.fontSize(14).text("REPORT", 45, doc.y, {
    align: "center",
    width: pageWidth,
  });

  doc.moveDown(1.5);
  doc
    .moveTo(doc.page.width / 2 - 50, doc.y)
    .lineTo(doc.page.width / 2 + 50, doc.y)
    .strokeColor(COLORS.accent)
    .lineWidth(2)
    .stroke();

  doc.moveDown(1.5);
  doc
    .fontSize(13)
    .fillColor("#bee3f8")
    .text(result.detectedProject, 45, doc.y, {
      align: "center",
      width: pageWidth,
    });

  doc.moveDown(0.6);
  doc
    .fontSize(10)
    .fillColor("#a0aec0")
    .text(
      `Category: ${CATEGORY_LABELS[result.category] || result.category}`,
      45,
      doc.y,
      { align: "center", width: pageWidth }
    );

  doc.moveDown(2.5);

  // Score circle
  const scoreColor = getScoreColor(result.percentageScore);
  const cx = doc.page.width / 2;
  const cy = doc.y + 45;
  const radius = 42;

  doc.circle(cx, cy, radius).lineWidth(3).strokeColor(scoreColor).stroke();

  doc
    .fontSize(26)
    .fillColor(COLORS.white)
    .text(`${result.percentageScore}%`, cx - 35, cy - 16, {
      width: 70,
      align: "center",
    });

  doc
    .fontSize(8)
    .fillColor("#a0aec0")
    .text("OVERALL", cx - 35, cy + 14, { width: 70, align: "center" });

  doc.y = cy + radius + 22;
  doc
    .fontSize(10)
    .fillColor("#a0aec0")
    .text(
      `Score: ${result.overallScore} / ${result.maxPossibleScore}  |  Rating: ${result.overallRating}`,
      45,
      doc.y,
      { align: "center", width: pageWidth }
    );

  doc.y = doc.page.height - 100;
  doc
    .fontSize(9)
    .fillColor("#a0aec0")
    .text(`Submission: ${result.submissionName}`, 45, doc.y, {
      align: "center",
      width: pageWidth,
    });
  doc.moveDown(0.4);
  doc.text(
    `Evaluated: ${new Date(result.timestamp).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    })}`,
    45,
    doc.y,
    { align: "center", width: pageWidth }
  );
}

// ====================================================== Page 2 — Breakdown

function renderSummaryAndBreakdown(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  // Title
  sectionTitle(doc, "Evaluation Summary", pageWidth);

  // Score bar
  doc
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(
      `Overall  ·  ${result.overallScore} / ${result.maxPossibleScore} (${result.percentageScore}%)  ·  ${result.overallRating}  ·  Bonus ${result.bonusPoints.score}/${result.bonusPoints.maxScore}`,
      45,
      doc.y,
      { width: pageWidth }
    );
  doc.moveDown(0.4);

  // Score bar visualization
  const barH = 8;
  const barY = doc.y;
  doc.rect(45, barY, pageWidth, barH).fill("#e2e8f0");
  doc
    .rect(45, barY, (result.percentageScore / 100) * pageWidth, barH)
    .fill(getScoreColor(result.percentageScore));
  doc.y = barY + barH + 10;

  // Executive summary
  if (result.summary?.trim()) {
    doc
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(result.summary.trim(), 45, doc.y, { width: pageWidth });
    doc.moveDown(0.6);
  }

  // Per-criterion breakdown — compact card per section
  sectionTitle(doc, "Criterion-by-Criterion Breakdown", pageWidth);

  result.sections.forEach((section, index) => {
    renderCompactSection(doc, section, index + 1, pageWidth);
  });
}

function renderCompactSection(
  doc: PDFKit.PDFDocument,
  section: EvaluationSection,
  index: number,
  pageWidth: number
) {
  // ~85-110px per section
  // Row 1: name + score, rating badge
  // Row 2: feedback (3-4 lines)
  // Row 3-N: combined inline strengths (+ ...) / issues (- ... → fix: ...)

  const startY = doc.y;
  const ratingColor = getRatingColor(section.rating);

  // Side accent bar based on rating
  doc.rect(45, startY, 3, 16).fill(ratingColor);

  // Header line
  doc
    .fontSize(10)
    .fillColor(COLORS.primary)
    .text(`${index}. ${section.criterionName}`, 55, startY + 1, {
      width: pageWidth - 110,
    });

  doc
    .fontSize(9)
    .fillColor(ratingColor)
    .text(
      `${section.score}/${section.maxScore}  ${section.rating}`,
      45,
      startY + 2,
      { width: pageWidth, align: "right" }
    );

  doc.y = startY + 18;

  // Feedback
  if (section.feedback?.trim()) {
    doc
      .fontSize(8.5)
      .fillColor(COLORS.text)
      .text(section.feedback.trim(), 55, doc.y, { width: pageWidth - 10 });
    doc.moveDown(0.2);
  }

  // Strengths — inline, no header
  if (section.strengths.length > 0) {
    const text = section.strengths.map((s) => `+ ${s}`).join("    ");
    doc
      .fontSize(7.5)
      .fillColor(COLORS.success)
      .text(text, 55, doc.y, { width: pageWidth - 10 });
    doc.moveDown(0.15);
  }

  // Shortcomings with paired suggestion — compact "- issue → fix"
  if (section.shortcomings.length > 0) {
    section.shortcomings.forEach((sc) => {
      doc
        .fontSize(7.5)
        .fillColor(COLORS.danger)
        .text(`- ${sc.issue}`, 55, doc.y, { width: pageWidth - 10 });
      if (sc.suggestion?.trim()) {
        doc
          .fontSize(7.5)
          .fillColor(COLORS.accent)
          .text(`  → ${sc.suggestion}`, 60, doc.y, {
            width: pageWidth - 15,
          });
      }
    });
    doc.moveDown(0.1);
  }

  // Thin separator
  doc.moveDown(0.15);
  doc
    .moveTo(55, doc.y)
    .lineTo(45 + pageWidth - 10, doc.y)
    .lineWidth(0.4)
    .strokeColor("#e2e8f0")
    .stroke();
  doc.moveDown(0.25);
}

// ====================================================== Page 3 — Overview

function renderOverview(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  // Strengths & weaknesses side-by-side
  if (result.pros.length > 0 || result.cons.length > 0) {
    sectionTitle(doc, "Overall Strengths & Areas for Growth", pageWidth);

    const colW = (pageWidth - 14) / 2;
    const startY = doc.y;

    // Strengths column
    doc.rect(45, startY, colW, 20).fill(COLORS.success);
    doc
      .fontSize(9)
      .fillColor(COLORS.white)
      .text("STRENGTHS", 53, startY + 5, { width: colW - 16 });

    let pY = startY + 26;
    result.pros.forEach((pro) => {
      doc
        .fontSize(8)
        .fillColor(COLORS.text)
        .text(`+ ${pro}`, 53, pY, { width: colW - 16 });
      pY = doc.y + 3;
    });

    // Weaknesses column
    doc.rect(45 + colW + 14, startY, colW, 20).fill(COLORS.danger);
    doc
      .fontSize(9)
      .fillColor(COLORS.white)
      .text("AREAS FOR GROWTH", 53 + colW + 14, startY + 5, {
        width: colW - 16,
      });

    let cY = startY + 26;
    doc.y = cY;
    result.cons.forEach((con) => {
      doc
        .fontSize(8)
        .fillColor(COLORS.text)
        .text(`- ${con.issue}`, 53 + colW + 14, cY, { width: colW - 16 });
      cY = doc.y + 1;
      if (con.suggestion?.trim()) {
        doc
          .fontSize(7.5)
          .fillColor(COLORS.accent)
          .text(`  → ${con.suggestion}`, 53 + colW + 14, cY, {
            width: colW - 16,
          });
        cY = doc.y + 4;
      } else {
        cY += 4;
      }
    });

    doc.y = Math.max(pY, cY) + 6;
  }

  // Scope for Improvement
  if (result.scopeForImprovement.length > 0) {
    doc.moveDown(0.4);
    sectionTitle(doc, "Scope for Improvement", pageWidth);
    result.scopeForImprovement.forEach((item, idx) => {
      const y = doc.y;
      doc.circle(54, y + 4, 6).fillAndStroke(COLORS.accent, COLORS.accent);
      doc
        .fontSize(7)
        .fillColor(COLORS.white)
        .text(`${idx + 1}`, 50, y + 1, { width: 8, align: "center" });
      doc
        .fontSize(8.5)
        .fillColor(COLORS.text)
        .text(item, 65, y, { width: pageWidth - 25 });
      doc.moveDown(0.2);
    });
  }

  // Bonus points
  if (result.bonusPoints.details.length > 0) {
    doc.moveDown(0.4);
    sectionTitle(
      doc,
      `Bonus Points & Creativity (+${result.bonusPoints.score}/${result.bonusPoints.maxScore})`,
      pageWidth
    );
    result.bonusPoints.details.forEach((detail) => {
      doc
        .fontSize(8.5)
        .fillColor(COLORS.primary)
        .text(`${detail.feature}  (+${detail.points} pts)`, 55, doc.y, {
          width: pageWidth - 10,
        });
      if (detail.comment?.trim()) {
        doc
          .fontSize(8)
          .fillColor(COLORS.muted)
          .text(detail.comment, 62, doc.y, { width: pageWidth - 17 });
      }
      doc.moveDown(0.2);
    });
  }
}

// ====================================================== Page 4 — Feedback

function renderInterviewerFeedback(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  sectionTitle(doc, "Interviewer Feedback", pageWidth);

  const paragraphs = (result.interviewerFeedback || "")
    .split("\n")
    .filter(Boolean);

  if (paragraphs.length === 0) {
    doc
      .fontSize(9)
      .fillColor(COLORS.muted)
      .text("(No interviewer feedback was returned for this evaluation.)", 55, doc.y, {
        width: pageWidth - 10,
      });
  } else {
    paragraphs.forEach((p) => {
      const startY = doc.y;
      doc
        .fontSize(9.5)
        .fillColor(COLORS.text)
        .text(p.trim(), 55, startY, {
          width: pageWidth - 10,
          align: "justify",
        });
      const endY = doc.y;
      // Per-paragraph accent bar (no cross-page bug)
      doc
        .rect(45, startY, 3, Math.max(10, endY - startY))
        .fill(COLORS.accent);
      doc.moveDown(0.5);
    });
  }

  doc.moveDown(1);
  doc
    .moveTo(45, doc.y)
    .lineTo(45 + pageWidth, doc.y)
    .strokeColor(COLORS.accent)
    .lineWidth(0.8)
    .stroke();
  doc.moveDown(0.4);
  doc
    .fontSize(7.5)
    .fillColor(COLORS.muted)
    .text(
      "This report was generated by Project Evaluator using AI-powered analysis. " +
        "Scores and feedback are intended to guide learning and improvement. " +
        "For questions about this evaluation, please reach out to your program coordinator.",
      45,
      doc.y,
      { align: "center", width: pageWidth }
    );
}

// ============================================================== helpers

function sectionTitle(
  doc: PDFKit.PDFDocument,
  title: string,
  pageWidth: number
) {
  doc
    .moveTo(45, doc.y)
    .lineTo(45 + pageWidth, doc.y)
    .strokeColor(COLORS.primary)
    .lineWidth(1.5)
    .stroke();
  doc.moveDown(0.3);
  doc
    .fontSize(12)
    .fillColor(COLORS.primary)
    .text(title.toUpperCase(), 45, doc.y, { width: pageWidth });
  doc.moveDown(0.4);
}
