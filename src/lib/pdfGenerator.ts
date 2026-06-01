import PDFDocument from "pdfkit";
import { EvaluationResult, EvaluationSection, CATEGORY_LABELS } from "./types";

/**
 * 3-page PDF layout (a few criteria-heavy capstones may spill to 4 pages —
 * unavoidable when there are 13 rubric criteria).
 *
 * Page 1 — Cover banner + summary + score breakdown bar + summary paragraph
 * Page 2 — All criteria (compact rows) + Overall pros/cons + Scope + Bonus
 * Page 3 — Interviewer feedback + disclaimer
 */

const COLORS = {
  primary: "#1a365d",
  secondary: "#2b6cb0",
  accent: "#3182ce",
  success: "#276749",
  warning: "#c05621",
  danger: "#c53030",
  lightBg: "#f7fafc",
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
      margins: { top: 35, bottom: 35, left: 40, right: 40 },
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

    const pageWidth = doc.page.width - 80;

    // Page 1 — Cover + summary
    renderPage1(doc, result, pageWidth);

    // Page 2 — All criteria + overall feedback / scope / bonus
    doc.addPage();
    renderPage2(doc, result, pageWidth);

    // Page 3 — Interviewer feedback
    doc.addPage();
    renderPage3(doc, result, pageWidth);

    // Footer page numbers
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(7)
        .fillColor(COLORS.muted)
        .text(
          `Page ${i + 1} of ${totalPages}`,
          40,
          doc.page.height - 22,
          { align: "center", width: pageWidth }
        );
    }

    doc.end();
  });
}

// ================================================== Page 1 — Cover banner

function renderPage1(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  // Dark banner (top 220px) — title + project + score circle
  const bannerH = 220;
  doc.rect(0, 0, doc.page.width, bannerH).fill(COLORS.primary);
  doc.rect(0, 0, doc.page.width, 6).fill(COLORS.accent);

  // Title row
  doc
    .fontSize(20)
    .fillColor(COLORS.white)
    .text("PROJECT EVALUATION REPORT", 40, 25, {
      align: "center",
      width: pageWidth,
    });

  // Project name + category
  doc
    .fontSize(12)
    .fillColor("#bee3f8")
    .text(result.detectedProject, 40, 60, {
      align: "center",
      width: pageWidth,
    });
  doc
    .fontSize(9)
    .fillColor("#a0aec0")
    .text(
      `Category: ${CATEGORY_LABELS[result.category] || result.category}`,
      40,
      78,
      { align: "center", width: pageWidth }
    );

  // Score circle on the right
  const scoreColor = getScoreColor(result.percentageScore);
  const cx = doc.page.width / 2;
  const cy = 145;
  const radius = 38;

  doc.circle(cx, cy, radius).lineWidth(3).strokeColor(scoreColor).stroke();
  doc
    .fontSize(22)
    .fillColor(COLORS.white)
    .text(`${result.percentageScore}%`, cx - 30, cy - 14, {
      width: 60,
      align: "center",
    });
  doc
    .fontSize(7)
    .fillColor("#a0aec0")
    .text("OVERALL", cx - 30, cy + 11, { width: 60, align: "center" });

  // Submission name + timestamp at banner bottom
  doc
    .fontSize(8)
    .fillColor("#cbd5e0")
    .text(
      `Submission: ${result.submissionName}   ·   Evaluated: ${new Date(
        result.timestamp
      ).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })}`,
      40,
      bannerH - 28,
      { align: "center", width: pageWidth }
    );

  // White content area below banner
  doc.y = bannerH + 18;

  // Headline stats row
  doc
    .fontSize(9)
    .fillColor(COLORS.muted)
    .text(
      `Score ${result.overallScore} / ${result.maxPossibleScore}   ·   Rating ${result.overallRating}   ·   Bonus ${result.bonusPoints.score}/${result.bonusPoints.maxScore}`,
      40,
      doc.y,
      { align: "center", width: pageWidth }
    );
  doc.moveDown(0.5);

  // Score bar
  const barH = 10;
  const barY = doc.y;
  doc.rect(40, barY, pageWidth, barH).fill("#e2e8f0");
  doc
    .rect(40, barY, (result.percentageScore / 100) * pageWidth, barH)
    .fill(getScoreColor(result.percentageScore));
  doc.y = barY + barH + 16;

  // Executive summary
  if (result.summary?.trim()) {
    sectionTitle(doc, "Executive Summary", pageWidth);
    doc
      .fontSize(10)
      .fillColor(COLORS.text)
      .text(result.summary.trim(), 40, doc.y, {
        width: pageWidth,
        align: "justify",
      });
    doc.moveDown(0.6);
  }

  // Quick per-criterion score table (compact rows, score only)
  sectionTitle(doc, "Score Summary by Criterion", pageWidth);
  result.sections.forEach((section) => {
    const rowY = doc.y;
    doc
      .rect(40, rowY, 3, 12)
      .fill(getRatingColor(section.rating));
    doc
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(section.criterionName, 50, rowY, {
        width: pageWidth - 130,
        ellipsis: true,
      });
    doc
      .fontSize(9)
      .fillColor(getRatingColor(section.rating))
      .text(
        `${section.score}/${section.maxScore}   ${section.rating}`,
        40,
        rowY,
        { width: pageWidth, align: "right" }
      );
    doc.y = rowY + 14;
  });
}

// ================================================ Page 2 — Detailed feedback

function renderPage2(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  sectionTitle(doc, "Criterion-by-Criterion Details", pageWidth);
  result.sections.forEach((section, index) => {
    renderCompactSection(doc, section, index + 1, pageWidth);
  });

  // Strengths/weaknesses side-by-side
  if (result.pros.length > 0 || result.cons.length > 0) {
    doc.moveDown(0.4);
    sectionTitle(doc, "Overall Strengths & Areas for Growth", pageWidth);

    const colW = (pageWidth - 12) / 2;
    const startY = doc.y;

    doc.rect(40, startY, colW, 16).fill(COLORS.success);
    doc
      .fontSize(8.5)
      .fillColor(COLORS.white)
      .text("STRENGTHS", 47, startY + 3.5, { width: colW - 14 });

    let pY = startY + 21;
    result.pros.forEach((pro) => {
      doc
        .fontSize(7.5)
        .fillColor(COLORS.text)
        .text(`+ ${pro}`, 47, pY, { width: colW - 14 });
      pY = doc.y + 1;
    });

    doc.rect(40 + colW + 12, startY, colW, 16).fill(COLORS.danger);
    doc
      .fontSize(8.5)
      .fillColor(COLORS.white)
      .text("AREAS FOR GROWTH", 47 + colW + 12, startY + 3.5, {
        width: colW - 14,
      });

    let cY = startY + 21;
    doc.y = cY;
    result.cons.forEach((con) => {
      doc
        .fontSize(7.5)
        .fillColor(COLORS.text)
        .text(`- ${con.issue}`, 47 + colW + 12, cY, { width: colW - 14 });
      cY = doc.y + 0.5;
      if (con.suggestion?.trim()) {
        doc
          .fontSize(7)
          .fillColor(COLORS.accent)
          .text(`  → ${con.suggestion}`, 47 + colW + 12, cY, {
            width: colW - 14,
          });
        cY = doc.y + 2;
      } else {
        cY += 2;
      }
    });

    doc.y = Math.max(pY, cY) + 4;
  }

  // Scope for Improvement (inline numbered list)
  if (result.scopeForImprovement.length > 0) {
    doc.moveDown(0.3);
    sectionTitle(doc, "Scope for Improvement", pageWidth);
    result.scopeForImprovement.forEach((item, idx) => {
      doc
        .fontSize(8)
        .fillColor(COLORS.text)
        .text(`${idx + 1}. ${item}`, 50, doc.y, { width: pageWidth - 10 });
      doc.moveDown(0.1);
    });
  }

  // Bonus points (compact)
  if (result.bonusPoints.details.length > 0) {
    doc.moveDown(0.3);
    sectionTitle(
      doc,
      `Bonus Points (+${result.bonusPoints.score}/${result.bonusPoints.maxScore})`,
      pageWidth
    );
    result.bonusPoints.details.forEach((detail) => {
      doc
        .fontSize(8)
        .fillColor(COLORS.primary)
        .text(`${detail.feature}  (+${detail.points} pts)`, 50, doc.y, {
          width: pageWidth - 10,
        });
      if (detail.comment?.trim()) {
        doc
          .fontSize(7.5)
          .fillColor(COLORS.muted)
          .text(detail.comment, 56, doc.y, { width: pageWidth - 16 });
      }
      doc.moveDown(0.1);
    });
  }
}

function renderCompactSection(
  doc: PDFKit.PDFDocument,
  section: EvaluationSection,
  index: number,
  pageWidth: number
) {
  // Target: ~55-75px per criterion so 7 fit in ~500px, 13 fit in ~1000px
  const startY = doc.y;
  const ratingColor = getRatingColor(section.rating);

  // Side accent bar
  doc.rect(40, startY, 3, 14).fill(ratingColor);

  // Header row: name + score
  doc
    .fontSize(9.5)
    .fillColor(COLORS.primary)
    .text(`${index}. ${section.criterionName}`, 50, startY, {
      width: pageWidth - 110,
    });
  doc
    .fontSize(8.5)
    .fillColor(ratingColor)
    .text(
      `${section.score}/${section.maxScore} · ${section.rating}`,
      40,
      startY + 1,
      { width: pageWidth, align: "right" }
    );

  doc.y = startY + 14;

  // Feedback (justified, tight font)
  if (section.feedback?.trim()) {
    doc
      .fontSize(8)
      .fillColor(COLORS.text)
      .text(section.feedback.trim(), 50, doc.y, {
        width: pageWidth - 10,
        align: "justify",
      });
    doc.moveDown(0.1);
  }

  // Strengths — single inline line
  if (section.strengths.length > 0) {
    const text = section.strengths.map((s) => `+ ${s}`).join("   ");
    doc
      .fontSize(7)
      .fillColor(COLORS.success)
      .text(text, 50, doc.y, { width: pageWidth - 10 });
  }

  // Shortcomings with arrow-fix
  if (section.shortcomings.length > 0) {
    section.shortcomings.forEach((sc) => {
      doc
        .fontSize(7)
        .fillColor(COLORS.danger)
        .text(
          `- ${sc.issue}${sc.suggestion ? `  →  ${sc.suggestion}` : ""}`,
          50,
          doc.y,
          { width: pageWidth - 10 }
        );
    });
  }

  // Thin separator
  doc.moveDown(0.1);
  doc
    .moveTo(50, doc.y)
    .lineTo(40 + pageWidth - 10, doc.y)
    .lineWidth(0.3)
    .strokeColor("#e2e8f0")
    .stroke();
  doc.moveDown(0.15);
}

// ============================================ Page 3 — Interviewer feedback

function renderPage3(
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
      .text(
        "(No interviewer feedback was returned for this evaluation.)",
        50,
        doc.y,
        { width: pageWidth - 10 }
      );
  } else {
    paragraphs.forEach((p) => {
      const startY = doc.y;
      doc
        .fontSize(10)
        .fillColor(COLORS.text)
        .text(p.trim(), 50, startY, {
          width: pageWidth - 10,
          align: "justify",
        });
      const endY = doc.y;
      doc
        .rect(40, startY, 3, Math.max(10, endY - startY))
        .fill(COLORS.accent);
      doc.moveDown(0.5);
    });
  }

  doc.moveDown(1);
  doc
    .moveTo(40, doc.y)
    .lineTo(40 + pageWidth, doc.y)
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
      40,
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
    .moveTo(40, doc.y)
    .lineTo(40 + pageWidth, doc.y)
    .strokeColor(COLORS.primary)
    .lineWidth(1.2)
    .stroke();
  doc.moveDown(0.25);
  doc
    .fontSize(11)
    .fillColor(COLORS.primary)
    .text(title.toUpperCase(), 40, doc.y, { width: pageWidth });
  doc.moveDown(0.3);
}
