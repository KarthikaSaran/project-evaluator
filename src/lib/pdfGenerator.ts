import PDFDocument from "pdfkit";
import { EvaluationResult, EvaluationSection, CATEGORY_LABELS } from "./types";

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
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
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

    const pageWidth = doc.page.width - 100;

    renderCoverPage(doc, result, pageWidth);
    doc.addPage();

    renderScoreSummary(doc, result, pageWidth);
    checkPageBreak(doc, 300);

    renderSectionEvaluations(doc, result, pageWidth);

    renderProsAndCons(doc, result, pageWidth);

    renderScopeForImprovement(doc, result, pageWidth);

    if (result.bonusPoints.details.length > 0) {
      renderBonusPoints(doc, result, pageWidth);
    }

    renderInterviewerFeedback(doc, result, pageWidth);

    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc
        .fontSize(8)
        .fillColor(COLORS.muted)
        .text(
          `Page ${i + 1} of ${totalPages}`,
          50,
          doc.page.height - 30,
          { align: "center", width: pageWidth }
        );

      if (i > 0) {
        doc
          .fontSize(7)
          .fillColor(COLORS.muted)
          .text(
            "Project Evaluator | Confidential",
            50,
            doc.page.height - 30,
            { align: "right", width: pageWidth }
          );
      }
    }

    doc.end();
  });
}

function renderCoverPage(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  doc.rect(0, 0, doc.page.width, doc.page.height).fill(COLORS.primary);

  doc.rect(0, 0, doc.page.width, 8).fill(COLORS.accent);

  doc.y = 180;
  doc
    .fontSize(32)
    .fillColor(COLORS.white)
    .text("PROJECT EVALUATION", 50, doc.y, {
      align: "center",
      width: pageWidth,
    });

  doc.moveDown(0.3);
  doc.fontSize(16).text("REPORT", 50, doc.y, {
    align: "center",
    width: pageWidth,
  });

  doc.moveDown(2);
  doc
    .moveTo(doc.page.width / 2 - 60, doc.y)
    .lineTo(doc.page.width / 2 + 60, doc.y)
    .strokeColor(COLORS.accent)
    .lineWidth(2)
    .stroke();

  doc.moveDown(2);
  doc.fontSize(14).fillColor("#bee3f8").text(result.detectedProject, 50, doc.y, {
    align: "center",
    width: pageWidth,
  });

  doc.moveDown(1);
  doc
    .fontSize(11)
    .fillColor("#a0aec0")
    .text(
      `Category: ${CATEGORY_LABELS[result.category] || result.category}`,
      50,
      doc.y,
      { align: "center", width: pageWidth }
    );

  doc.moveDown(3);

  const scoreColor = getScoreColor(result.percentageScore);
  const cx = doc.page.width / 2;
  const cy = doc.y + 50;
  const radius = 45;

  doc.circle(cx, cy, radius).lineWidth(4).strokeColor(scoreColor).stroke();

  doc
    .fontSize(28)
    .fillColor(COLORS.white)
    .text(`${result.percentageScore}%`, cx - 35, cy - 18, {
      width: 70,
      align: "center",
    });

  doc
    .fontSize(9)
    .fillColor("#a0aec0")
    .text("OVERALL", cx - 35, cy + 14, { width: 70, align: "center" });

  doc.y = cy + radius + 30;
  doc
    .fontSize(10)
    .fillColor("#a0aec0")
    .text(
      `Score: ${result.overallScore} / ${result.maxPossibleScore} | Rating: ${result.overallRating}`,
      50,
      doc.y,
      { align: "center", width: pageWidth }
    );

  doc.y = doc.page.height - 120;
  doc
    .fontSize(10)
    .fillColor("#a0aec0")
    .text(`Submission: ${result.submissionName}`, 50, doc.y, {
      align: "center",
      width: pageWidth,
    });
  doc.moveDown(0.5);
  doc.text(
    `Evaluated: ${new Date(result.timestamp).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}`,
    50,
    doc.y,
    { align: "center", width: pageWidth }
  );
}

function renderScoreSummary(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  renderSectionHeader(doc, "SCORE SUMMARY", pageWidth);
  doc.moveDown(0.5);

  doc
    .fontSize(10)
    .fillColor(COLORS.text)
    .text(result.summary, 50, doc.y, { width: pageWidth });
  doc.moveDown(1);

  const colWidth = pageWidth / 4;
  const startY = doc.y;

  const metrics = [
    {
      label: "Overall Score",
      value: `${result.overallScore}/${result.maxPossibleScore}`,
    },
    { label: "Percentage", value: `${result.percentageScore}%` },
    { label: "Rating", value: result.overallRating },
    {
      label: "Bonus Points",
      value: `${result.bonusPoints.score}/${result.bonusPoints.maxScore}`,
    },
  ];

  metrics.forEach((m, i) => {
    const x = 50 + i * colWidth;
    doc
      .rect(x + 2, startY, colWidth - 4, 50)
      .fillAndStroke(COLORS.lightBg, COLORS.border);
    doc
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(m.label, x + 10, startY + 10, { width: colWidth - 20 });
    doc
      .fontSize(14)
      .fillColor(COLORS.primary)
      .text(m.value, x + 10, startY + 26, {
        width: colWidth - 20,
      });
  });

  doc.y = startY + 60;
  doc.moveDown(0.5);

  renderScoreBar(doc, result, pageWidth);
}

function renderScoreBar(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  const barHeight = 14;
  const startX = 50;
  const y = doc.y;

  doc.rect(startX, y, pageWidth, barHeight).fill("#e2e8f0");

  const fillWidth = (result.percentageScore / 100) * pageWidth;
  const color = getScoreColor(result.percentageScore);
  doc.rect(startX, y, fillWidth, barHeight).fill(color);

  doc
    .fontSize(8)
    .fillColor(COLORS.white)
    .text(`${result.percentageScore}%`, startX + 5, y + 2, {
      width: fillWidth - 10,
    });

  doc.y = y + barHeight + 15;
}

function renderSectionEvaluations(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  renderSectionHeader(doc, "DETAILED EVALUATION", pageWidth);

  result.sections.forEach((section, index) => {
    checkPageBreak(doc, 200);
    renderEvaluationSection(doc, section, index + 1, pageWidth);
  });
}

function renderEvaluationSection(
  doc: PDFKit.PDFDocument,
  section: EvaluationSection,
  index: number,
  pageWidth: number
) {
  doc.moveDown(0.5);

  const headerY = doc.y;
  doc.rect(50, headerY, pageWidth, 28).fill(COLORS.sectionBg);

  doc
    .fontSize(11)
    .fillColor(COLORS.primary)
    .text(`${index}. ${section.criterionName}`, 58, headerY + 7, {
      width: pageWidth - 120,
    });

  const ratingColor = getRatingColor(section.rating);
  const scoreText = `${section.score}/${section.maxScore} - ${section.rating}`;
  doc
    .fontSize(10)
    .fillColor(ratingColor)
    .text(scoreText, 50, headerY + 8, {
      width: pageWidth - 8,
      align: "right",
    });

  doc.y = headerY + 34;

  const pct = section.maxScore > 0 ? (section.score / section.maxScore) * 100 : 0;
  const barY = doc.y;
  doc.rect(50, barY, pageWidth, 6).fill("#e2e8f0");
  doc
    .rect(50, barY, (pct / 100) * pageWidth, 6)
    .fill(getScoreColor(pct));
  doc.y = barY + 12;

  doc
    .fontSize(9)
    .fillColor(COLORS.text)
    .text(section.feedback, 58, doc.y, { width: pageWidth - 16 });
  doc.moveDown(0.5);

  if (section.strengths.length > 0) {
    checkPageBreak(doc, 80);
    doc.fontSize(9).fillColor(COLORS.success).text("Strengths:", 58, doc.y);
    doc.moveDown(0.2);
    section.strengths.forEach((s) => {
      checkPageBreak(doc, 20);
      doc
        .fontSize(8)
        .fillColor(COLORS.text)
        .text(`  +  ${s}`, 66, doc.y, { width: pageWidth - 24 });
      doc.moveDown(0.15);
    });
  }

  if (section.shortcomings.length > 0) {
    checkPageBreak(doc, 80);
    doc.moveDown(0.3);
    doc.fontSize(9).fillColor(COLORS.danger).text("Areas to Improve:", 58, doc.y);
    doc.moveDown(0.2);
    section.shortcomings.forEach((sc) => {
      checkPageBreak(doc, 40);
      doc
        .fontSize(8)
        .fillColor(COLORS.text)
        .text(`  -  ${sc.issue}`, 66, doc.y, { width: pageWidth - 24 });
      doc.moveDown(0.1);
      doc
        .fontSize(8)
        .fillColor(COLORS.accent)
        .text(`     Suggestion: ${sc.suggestion}`, 66, doc.y, {
          width: pageWidth - 24,
        });
      doc.moveDown(0.2);
    });
  }

  doc.moveDown(0.5);
  doc
    .moveTo(70, doc.y)
    .lineTo(50 + pageWidth - 20, doc.y)
    .strokeColor("#e2e8f0")
    .lineWidth(0.5)
    .stroke();
  doc.moveDown(0.3);
}

function renderProsAndCons(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  checkPageBreak(doc, 250);
  renderSectionHeader(doc, "STRENGTHS & WEAKNESSES", pageWidth);

  const halfWidth = (pageWidth - 10) / 2;

  const prosStartY = doc.y;

  doc
    .rect(50, prosStartY, halfWidth, 24)
    .fill(COLORS.success);
  doc
    .fontSize(10)
    .fillColor(COLORS.white)
    .text("STRENGTHS", 58, prosStartY + 6, { width: halfWidth - 16 });

  let prosY = prosStartY + 30;
  result.pros.forEach((pro) => {
    doc
      .fontSize(8)
      .fillColor(COLORS.text)
      .text(`+  ${pro}`, 58, prosY, { width: halfWidth - 16 });
    prosY = doc.y + 6;
  });

  doc
    .rect(50 + halfWidth + 10, prosStartY, halfWidth, 24)
    .fill(COLORS.danger);
  doc
    .fontSize(10)
    .fillColor(COLORS.white)
    .text("AREAS FOR GROWTH", 58 + halfWidth + 10, prosStartY + 6, {
      width: halfWidth - 16,
    });

  let consY = prosStartY + 30;
  doc.y = consY;
  result.cons.forEach((con) => {
    doc
      .fontSize(8)
      .fillColor(COLORS.text)
      .text(`-  ${con.issue}`, 58 + halfWidth + 10, consY, {
        width: halfWidth - 16,
      });
    consY = doc.y + 2;
    doc
      .fontSize(7)
      .fillColor(COLORS.accent)
      .text(`   Fix: ${con.suggestion}`, 58 + halfWidth + 10, consY, {
        width: halfWidth - 16,
      });
    consY = doc.y + 6;
  });

  doc.y = Math.max(prosY, consY) + 10;
}

function renderScopeForImprovement(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  checkPageBreak(doc, 200);
  renderSectionHeader(doc, "SCOPE FOR IMPROVEMENT", pageWidth);

  result.scopeForImprovement.forEach((item, idx) => {
    checkPageBreak(doc, 30);
    const y = doc.y;
    doc
      .circle(62, y + 5, 8)
      .fillAndStroke(COLORS.accent, COLORS.accent);
    doc
      .fontSize(8)
      .fillColor(COLORS.white)
      .text(`${idx + 1}`, 57, y + 2, { width: 10, align: "center" });
    doc
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(item, 78, y, { width: pageWidth - 36 });
    doc.moveDown(0.5);
  });
}

function renderBonusPoints(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  checkPageBreak(doc, 180);
  renderSectionHeader(doc, "BONUS POINTS & CREATIVITY", pageWidth);

  doc
    .fontSize(11)
    .fillColor(COLORS.success)
    .text(
      `Bonus Score: ${result.bonusPoints.score} / ${result.bonusPoints.maxScore} points`,
      50,
      doc.y,
      { width: pageWidth }
    );
  doc.moveDown(0.5);

  result.bonusPoints.details.forEach((detail) => {
    checkPageBreak(doc, 40);
    const y = doc.y;
    doc
      .fontSize(9)
      .fillColor(COLORS.primary)
      .text(`${detail.feature} (+${detail.points} pts)`, 58, y, {
        width: pageWidth - 16,
      });
    doc.moveDown(0.15);
    doc
      .fontSize(8)
      .fillColor(COLORS.muted)
      .text(detail.comment, 66, doc.y, { width: pageWidth - 24 });
    doc.moveDown(0.4);
  });
}

function renderInterviewerFeedback(
  doc: PDFKit.PDFDocument,
  result: EvaluationResult,
  pageWidth: number
) {
  checkPageBreak(doc, 300);
  renderSectionHeader(doc, "INTERVIEWER FEEDBACK", pageWidth);

  doc.moveDown(0.3);

  const feedbackY = doc.y;
  doc.rect(50, feedbackY, 3, 0).fill(COLORS.accent);

  const paragraphs = result.interviewerFeedback.split("\n").filter(Boolean);
  let currentY = feedbackY;
  paragraphs.forEach((p) => {
    checkPageBreak(doc, 60);
    doc
      .fontSize(9)
      .fillColor(COLORS.text)
      .text(p.trim(), 62, doc.y, { width: pageWidth - 20 });
    doc.moveDown(0.5);
    currentY = doc.y;
  });

  doc.rect(50, feedbackY, 3, currentY - feedbackY).fill(COLORS.accent);

  doc.moveDown(1);
  checkPageBreak(doc, 60);

  doc
    .moveTo(50, doc.y)
    .lineTo(50 + pageWidth, doc.y)
    .strokeColor(COLORS.accent)
    .lineWidth(1)
    .stroke();
  doc.moveDown(0.5);

  doc
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(
      "This report was generated by Project Evaluator using AI-powered analysis. " +
        "Scores and feedback are meant to guide learning and improvement. " +
        "For questions about this evaluation, please contact your program coordinator.",
      50,
      doc.y,
      { align: "center", width: pageWidth }
    );
}

function renderSectionHeader(
  doc: PDFKit.PDFDocument,
  title: string,
  pageWidth: number
) {
  doc.moveDown(0.5);
  const y = doc.y;
  doc
    .moveTo(50, y)
    .lineTo(50 + pageWidth, y)
    .strokeColor(COLORS.primary)
    .lineWidth(2)
    .stroke();
  doc.moveDown(0.4);
  doc.fontSize(13).fillColor(COLORS.primary).text(title, 50, doc.y, {
    width: pageWidth,
  });
  doc.moveDown(0.5);
}

function checkPageBreak(doc: PDFKit.PDFDocument, requiredSpace: number) {
  if (doc.y + requiredSpace > doc.page.height - 60) {
    doc.addPage();
  }
}
