import OpenAI from "openai";
import crypto from "crypto";
import {
  EvaluationResult,
  SubmissionFile,
  ProjectData,
  ProjectCategory,
  EvaluationSection,
  ShortcomingWithSuggestion,
  BonusPoints,
  CriterionData,
} from "./types";
import { ALL_PROJECTS } from "./problemStatements";

// ----------------------------------------------------------------------------
// Consistency knobs — every evaluation uses the same model, temperature, and a
// CONTENT-DERIVED seed. Same submission + same project = same seed = (very
// close to) the same output. Rating labels are derived from the integer score
// in code so they're always congruent with the percentage.
// ----------------------------------------------------------------------------

// Default to the "gpt-4o" alias which every OpenAI project has access to.
// Pin to a snapshot via EVALUATOR_MODEL env var (e.g. "gpt-4o-2024-08-06") for
// maximum cross-run consistency once your project has access to that snapshot.
const MODEL = process.env.EVALUATOR_MODEL || "gpt-4o";
const DETECTION_MODEL =
  process.env.EVALUATOR_DETECTION_MODEL || "gpt-4o-mini";
const TEMPERATURE = 0;

/**
 * Deterministic seed derived from (project + submission content). OpenAI's
 * seed parameter is best-effort, but combining it with temperature=0 plus
 * identical inputs gives a very high probability of identical output.
 */
function contentSeed(projectKey: string, content: string): number {
  const hash = crypto
    .createHash("sha256")
    .update(`${projectKey}::${content}`)
    .digest("hex");
  // Use the first 8 hex chars → 32-bit int (OpenAI accepts 32-bit signed int)
  return parseInt(hash.slice(0, 8), 16);
}

type RatingLabel = "Excellent" | "Good" | "Fair" | "Poor";

function ratingFromPercent(pct: number): RatingLabel {
  if (pct >= 85) return "Excellent";
  if (pct >= 70) return "Good";
  if (pct >= 50) return "Fair";
  return "Poor";
}

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function evaluateSubmission(
  files: SubmissionFile[],
  category: ProjectCategory,
  projectId?: string,
  customProblemStatement?: string
): Promise<EvaluationResult> {
  // Hide submitter-identifying info (file names, paths) from the model — the
  // grade should depend on *what was written*, not *who* (or anything that
  // could leak from a filename like "john_doe_solution.ipynb").
  const combinedContent = files
    .map(
      (f, idx) =>
        `=== Submission File ${idx + 1} (type: ${f.type}) ===\n${f.content}`
    )
    .join("\n\n");

  let project: ProjectData | undefined;
  let problemContext: string;
  let criteria: CriterionData[];

  if (category === "bring-your-own" && customProblemStatement) {
    problemContext = customProblemStatement;
    criteria = getGenericCriteria();
  } else if (projectId) {
    project = ALL_PROJECTS.find((p) => p.id === projectId);
    if (project) {
      problemContext = `Title: ${project.title}\nDescription: ${project.description}\n\nFull Problem Statement:\n${project.fullContent}`;
      criteria =
        project.criteria.length > 0 ? project.criteria : getGenericCriteria();
    } else {
      problemContext =
        "Unknown project. Evaluate as a general data science / ML project.";
      criteria = getGenericCriteria();
    }
  } else {
    project = await autoDetectProject(combinedContent, category);
    if (project) {
      problemContext = `Title: ${project.title}\nDescription: ${project.description}\n\nFull Problem Statement:\n${project.fullContent}`;
      criteria =
        project.criteria.length > 0 ? project.criteria : getGenericCriteria();
    } else {
      problemContext =
        "Unable to detect specific project. Evaluate as a general data science / ML project.";
      criteria = getGenericCriteria();
    }
  }

  const evaluationPrompt = buildEvaluationPrompt(
    combinedContent,
    problemContext,
    criteria
  );

  const seed = contentSeed(
    project?.id || category || "generic",
    combinedContent
  );

  const rawResult = await callEvaluator(evaluationPrompt, seed, criteria);

  return formatEvaluationResult(
    rawResult as unknown as Record<string, unknown>,
    files[0]?.name || "Unknown",
    category,
    project?.title || rawResult.detectedProject || "Custom Project"
  );
}

interface RawEvaluation {
  detectedProject?: string;
  summary?: string;
  sections?: Array<{
    criterionName?: string;
    score?: number | string;
    maxScore?: number | string;
    feedback?: string;
    strengths?: string[];
    shortcomings?: ShortcomingWithSuggestion[];
    evidence?: string[];
    gaps?: string[];
  }>;
  pros?: string[];
  cons?: ShortcomingWithSuggestion[];
  scopeForImprovement?: string[];
  bonusPoints?: {
    score?: number;
    details?: Array<{ feature?: string; points?: number; comment?: string }>;
  };
  interviewerFeedback?: string;
}

/**
 * Call OpenAI once. If the response shape is obviously wrong (missing
 * sections, out-of-range scores, or shortcomings without suggestions), retry
 * EXACTLY once with the same seed and a tightened reminder appended. We never
 * loop indefinitely — one retry is the guardrail, not a regeneration loop.
 */
async function callEvaluator(
  evaluationPrompt: string,
  seed: number,
  criteria: CriterionData[]
): Promise<RawEvaluation> {
  const maxPerCriterion = Math.max(
    5,
    Math.round(100 / Math.max(criteria.length, 1))
  );

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: evaluationPrompt },
  ];

  const doCall = async () => {
    const response = await getOpenAI().chat.completions.create({
      model: MODEL,
      messages,
      temperature: TEMPERATURE,
      seed,
      max_tokens: 8000,
      response_format: { type: "json_object" },
    });
    // Observability: log model fingerprint so we can detect when OpenAI
    // silently rolls the gpt-4o alias to a new snapshot underneath us.
    if (process.env.NODE_ENV !== "test") {
      console.log(
        `[evaluator] model=${MODEL} fingerprint=${response.system_fingerprint || "<none>"} seed=${seed}`
      );
    }
    return JSON.parse(
      response.choices[0].message.content || "{}"
    ) as RawEvaluation;
  };

  const first = await doCall();
  const validation = validateRawResult(first, criteria, maxPerCriterion);
  if (validation.ok) return first;

  // One retry with an explicit tightening instruction. Same seed → still
  // deterministic per (input, seed) but with a stricter request.
  messages.push({
    role: "system" as const,
    content: `Your previous response had these problems: ${validation.problems.join(
      "; "
    )}. Return a CORRECTED JSON object that fixes them. All other rules from the original system message still apply.`,
  });
  const second = await doCall();
  return second;
}

interface Validation {
  ok: boolean;
  problems: string[];
}

function validateRawResult(
  raw: RawEvaluation,
  criteria: CriterionData[],
  maxPerCriterion: number
): Validation {
  const problems: string[] = [];

  const sections = raw.sections || [];
  if (sections.length !== criteria.length) {
    problems.push(
      `expected ${criteria.length} sections (one per rubric criterion) but got ${sections.length}`
    );
  }

  sections.forEach((s, i) => {
    const score = Number(s.score);
    const maxScore = Number(s.maxScore);
    if (Number.isNaN(score) || score < 0 || score > maxPerCriterion) {
      problems.push(
        `section ${i + 1} (${s.criterionName || "?"}) score ${s.score} is out of 0..${maxPerCriterion}`
      );
    }
    if (maxScore !== maxPerCriterion) {
      problems.push(
        `section ${i + 1} maxScore should be ${maxPerCriterion}, got ${s.maxScore}`
      );
    }
    if (!s.feedback || s.feedback.trim().length < 20) {
      problems.push(`section ${i + 1} feedback is too short or missing`);
    }
    // Encourage evidence/gaps presence (it makes the report richer) but
    // don't gate the score on it — that was forcing the model to give 0%
    // when it was being conservative about listing evidence items.
    (s.shortcomings || []).forEach((sc, j) => {
      if (!sc.suggestion || !sc.suggestion.trim()) {
        problems.push(
          `section ${i + 1} shortcoming ${j + 1} is missing a paired suggestion`
        );
      }
    });
  });

  const bonus = raw.bonusPoints?.score;
  if (typeof bonus === "number" && (bonus < 0 || bonus > 15)) {
    problems.push(`bonusPoints.score ${bonus} is out of 0..15`);
  }

  if (!raw.interviewerFeedback || raw.interviewerFeedback.trim().length < 100) {
    problems.push("interviewerFeedback is missing or too short");
  }

  return { ok: problems.length === 0, problems };
}

async function autoDetectProject(
  content: string,
  category: ProjectCategory
): Promise<ProjectData | undefined> {
  const snippet = content.slice(0, 3000);
  const candidates =
    category !== "bring-your-own"
      ? ALL_PROJECTS.filter((p) => p.category === category)
      : ALL_PROJECTS;

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];

  const projectList = candidates
    .map((p) => `- ${p.id}: ${p.title} (${p.description.slice(0, 80)})`)
    .join("\n");

  const detectionSeed = contentSeed(`detect:${category}`, snippet);
  const response = await getOpenAI().chat.completions.create({
    model: DETECTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You identify which project a code submission belongs to. Return JSON with a single field 'projectId'. Pick the projectId whose description best matches the submission. Be deterministic — if two projects feel equally plausible, pick the one listed FIRST in the user message.",
      },
      {
        role: "user",
        content: `Known projects in category "${category}":\n${projectList}\n\nSubmission snippet:\n${snippet}\n\nWhich project does this belong to? Return JSON: {"projectId": "..."}`,
      },
    ],
    temperature: 0,
    seed: detectionSeed,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(
    response.choices[0].message.content || '{"projectId": "unknown"}'
  );
  return candidates.find((p) => p.id === result.projectId);
}

// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert technical evaluator and interviewer who reviews take-home assignments for data science, machine learning, deep learning, NLP, computer vision, and Gen AI projects.

You are an evidence-driven grader. You look at the rubric, you scan the submission CAREFULLY (the full code, not just headers), you list what's there and what isn't, and you grade on actual quality.

CRITICAL: be GENEROUS in finding evidence. A submission that imports pandas, reads a CSV, and prints df.head() has evidence for "Dataset Overview". A submission that calls train_test_split and fits a model has evidence for "Model Implementation". Don't require perfection to count something as evidence — partial fulfillment is still evidence.

GRADING ALGORITHM — for every criterion:

  Step A. Read the criterion's description carefully. Identify what it asks for (e.g. "data cleaning, missing values, encoding, scaling, feature creation").
  Step B. Scan the WHOLE submission. Find artifacts that address the criterion: function calls (StandardScaler, get_dummies, fillna), library imports (sklearn, seaborn), plots (sns.heatmap, plt.boxplot), techniques used, metrics computed, etc.
  Step C. Populate "evidence" with concrete things found. Be liberal — every relevant artifact counts. Use 3-8 items per criterion. Be specific: "Used StandardScaler on numerical columns" not "applied scaling".
  Step D. Populate "gaps" with what's clearly missing or weak. Be honest but proportional. Use 1-5 items.
  Step E. Assign a score based on QUALITY OF WORK, calibrated to the bands:
       - 90-100% of maxScore: Comprehensive coverage with strong execution. Most/all sub-requirements addressed with good technique.
       - 75-89%: Solid. Main requirements covered, minor gaps in completeness or polish.
       - 60-74%: Functional but with notable issues. Half to two-thirds of what was asked is present and working.
       - 40-59%: Surface-level attempt. Some elements present but execution is shallow or has errors.
       - 0-39%: Missing or seriously flawed. Criterion essentially not addressed.

     Use the evidence vs gaps balance AS A GUIDE, but use judgment on QUALITY. A submission with many evidence items but poor execution might be 60-74%. A submission with fewer items but excellent execution might be 75-89%. DO NOT default to mid-range when uncertain — pick the band that honestly reflects what you see.

  Step F. The "feedback" paragraph cites evidence and gaps by name and explains the score in 2-3 sentences.

JSON SHAPE — return per-criterion:
  {
    "criterionName": "EXACT name from the rubric, same order",
    "evidence": ["specific artifact 1", "specific artifact 2", ...],
    "gaps": ["specific missing sub-requirement 1", ...],
    "score": <integer>,
    "maxScore": <given>,
    "feedback": "Paragraph that cites evidence and gaps by name and justifies the score.",
    "strengths": ["one-line strength", ...],
    "shortcomings": [{"issue": "specific issue", "suggestion": "specific actionable fix"}]
  }

HARD RULES (any violation = invalid response):

1. STRICTLY RUBRIC-DRIVEN. The number of sections MUST equal the number of rubric criteria, in the same order, with the EXACT criterionName. Do not invent, merge, drop, or reweight criteria.

2. NO BIAS. Ignore submitter identity / filenames / signatures. Grade the work, never the person.

3. SCORE EVIDENCE-DEFENSIBLE. Your feedback must cite specific things from the submission (functions, libraries, plots, techniques) by name. If you scored low, the feedback must name the gaps that drove the score down. If you scored high, the feedback must name what was impressive.

4. DIFFERENTIATE. Two submissions of clearly different quality MUST receive clearly different scores. Do NOT cluster around the median. A pristine implementation is 90-100%; a barely-there attempt is < 40%. Use the FULL range, every integer is valid.

5. EVERY shortcoming MUST be paired with a specific, actionable suggestion. If the suggestion would be "improve X" with no actionable detail, drop the shortcoming.

6. NO ROUNDING TO 5s. Use any integer the evidence supports — 13/14, 11/14, 7/14, etc.

7. INTERVIEWER FEEDBACK STRUCTURE. The interviewerFeedback field is 3-4 paragraphs:
   - Paragraph 1: What genuinely impressed you (reference SPECIFIC artifacts).
   - Paragraph 2: Concrete concerns and gaps (cite SPECIFIC missing pieces by name).
   - Paragraph 3: Specific next steps to grow.
   - Paragraph 4: Short motivating close.
   No submitter names. No assumptions about experience level.

8. BONUS POINTS (out of 15 max) ONLY for things genuinely beyond baseline (extra features, novel approaches that materially help, CI/packaging/demo deployment readiness, advanced techniques used appropriately, exceptional documentation/tests). Never for meeting baseline. Cap individual bonus items at 5 pts.

9. SPREADSHEET-ONLY SUBMISSIONS. If the submission is an approach summary from a form (no code), evaluate the described methodology only and say so explicitly. Evidence list captures what the description claims; gaps list captures what's not described.

10. NO "rating" FIELD IN OUTPUT. Ratings are derived downstream from your scores.

11. CONSISTENCY. The runtime sets temperature=0 and a deterministic content-hash seed, so the same submission produces the same scores. The grading algorithm above is your guarantee — follow it mechanically and the answer is reproducible by definition.`;

function buildEvaluationPrompt(
  content: string,
  problemContext: string,
  criteria: CriterionData[]
): string {
  const maxPerCriterion = Math.max(
    5,
    Math.round(100 / Math.max(criteria.length, 1))
  );
  const criteriaList = criteria
    .map(
      (c) =>
        `- ${c.name} (max ${maxPerCriterion} points): ${
          c.description || "Evaluate quality and completeness"
        }`
    )
    .join("\n");

  const maxTotal = maxPerCriterion * criteria.length;

  return `## Problem Statement
${problemContext}

## Evaluation Criteria (Total: ${maxTotal} points + up to 15 bonus points)
${criteriaList}

## Bonus Points (up to 15 points)
Award bonus only for things genuinely beyond baseline (per the system message).

## Submission Content
${content.slice(0, 100000)}

## Instructions
Evaluate this submission per the GRADING ALGORITHM in the system message. For each criterion, execute Steps A-F (read criterion → scan submission → list evidence → list gaps → compute score via mechanical mapping → write feedback citing both).

Return a JSON object with EXACTLY this structure:
{
  "detectedProject": "Name of the project you identified",
  "summary": "2-3 sentence executive summary of the submission quality",
  "sections": [
    {
      "criterionName": "EXACT criterion name from above, same order",
      "evidence": ["specific artifact found in submission (function/library/plot/technique name)", ...],
      "gaps": ["specific sub-requirement not addressed (named precisely)", ...],
      "score": <integer in [0, ${maxPerCriterion}]>,
      "maxScore": ${maxPerCriterion},
      "feedback": "Paragraph that cites evidence and gaps by name and justifies the score.",
      "strengths": ["strength 1", "strength 2"],
      "shortcomings": [
        {"issue": "Specific issue", "suggestion": "Specific actionable fix"}
      ]
    }
  ],
  "pros": ["Overall strength 1", "Overall strength 2"],
  "cons": [
    {"issue": "Overall weakness", "suggestion": "How to overcome this"}
  ],
  "scopeForImprovement": ["Specific improvement area 1", "Specific improvement area 2"],
  "bonusPoints": {
    "score": <integer 0-15>,
    "details": [
      {"feature": "What was impressive", "points": <integer>, "comment": "Why this deserves bonus points"}
    ]
  },
  "interviewerFeedback": "3-4 paragraphs per system message. No submitter names."
}

ONE section per criterion. SAME order. SAME criterionName. evidence/gaps are arrays of short specific strings (each ≤ 120 chars). Every shortcoming has a paired suggestion. Do NOT include a "rating" field.`;
}

function getGenericCriteria(): CriterionData[] {
  return [
    {
      name: "Problem Understanding & Dataset Overview",
      description:
        "Understanding of the problem, dataset exploration, feature documentation",
    },
    {
      name: "Data Preprocessing & Feature Engineering",
      description:
        "Data cleaning, missing values, encoding, scaling, feature creation",
    },
    {
      name: "Exploratory Data Analysis",
      description:
        "Visualizations, statistical analysis, pattern identification",
    },
    {
      name: "Model Implementation",
      description:
        "Algorithm selection, implementation quality, technical correctness",
    },
    {
      name: "Evaluation & Results",
      description:
        "Metrics selection, model comparison, interpretation of results",
    },
    {
      name: "Code Quality & Documentation",
      description:
        "Code organization, readability, comments, reproducibility",
    },
    {
      name: "Conclusions & Future Work",
      description: "Insights, recommendations, identified improvements",
    },
  ];
}

function formatEvaluationResult(
  raw: Record<string, unknown>,
  submissionName: string,
  category: ProjectCategory,
  detectedProject: string
): EvaluationResult {
  const sections = (
    (raw.sections as Record<string, unknown>[]) || []
  ).map((s): EvaluationSection => {
    const score = Math.max(0, Math.round(Number(s.score) || 0));
    const maxScore = Math.max(0, Math.round(Number(s.maxScore) || 0));
    const pct = maxScore > 0 ? (score / maxScore) * 100 : 0;
    return {
      criterionName: String(s.criterionName || ""),
      score,
      maxScore,
      rating: ratingFromPercent(pct),
      feedback: String(s.feedback || ""),
      strengths: (s.strengths as string[]) || [],
      shortcomings: (
        (s.shortcomings as ShortcomingWithSuggestion[]) || []
      ).map((sc) => ({
        issue: String(sc.issue || ""),
        suggestion: String(sc.suggestion || ""),
      })),
      evidence: ((s.evidence as string[]) || []).map((e) => String(e)),
      gaps: ((s.gaps as string[]) || []).map((g) => String(g)),
    };
  });

  const sectionTotal = sections.reduce((sum, s) => sum + s.score, 0);
  const maxSectionTotal = sections.reduce((sum, s) => sum + s.maxScore, 0);

  const bonus: BonusPoints = {
    score: Math.max(
      0,
      Math.min(
        15,
        Math.round(
          Number((raw.bonusPoints as Record<string, unknown>)?.score) || 0
        )
      )
    ),
    maxScore: 15,
    details: (
      ((raw.bonusPoints as Record<string, unknown>)?.details as Array<
        Record<string, unknown>
      >) || []
    ).map((d) => ({
      feature: String(d.feature || ""),
      points: Math.max(0, Math.round(Number(d.points) || 0)),
      comment: String(d.comment || ""),
    })),
  };

  const overallScore = sectionTotal + bonus.score;
  const maxPossible = maxSectionTotal + bonus.maxScore;
  const percentageScore =
    maxPossible > 0 ? Math.round((overallScore / maxPossible) * 100) : 0;

  return {
    id: generateId(),
    submissionName,
    detectedProject,
    category,
    timestamp: new Date().toISOString(),
    overallScore,
    maxPossibleScore: maxPossible,
    percentageScore,
    // Overall rating also derived from score, not from the model.
    overallRating: ratingFromPercent(percentageScore),
    sections,
    pros: (raw.pros as string[]) || [],
    cons: ((raw.cons as ShortcomingWithSuggestion[]) || []).map((c) => ({
      issue: String(c.issue || ""),
      suggestion: String(c.suggestion || ""),
    })),
    scopeForImprovement: (raw.scopeForImprovement as string[]) || [],
    bonusPoints: bonus,
    interviewerFeedback: String(raw.interviewerFeedback || ""),
    summary: String(raw.summary || ""),
  };
}

function generateId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
