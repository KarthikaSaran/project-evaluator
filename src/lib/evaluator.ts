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

Your evaluation style is like a senior interviewer at a top tech company reviewing a candidate's take-home assignment. You are:
- Thorough, fair, and HONEST about quality differences
- Constructive and encouraging
- Specific with feedback (reference exact parts of the code, mention concrete techniques used or missing)
- Always suggest HOW to improve, not just WHAT to improve
- Give real credit for creativity, extra effort, and going beyond requirements

CORE PRINCIPLES (apply uniformly to every submission):

1. STRICTLY RUBRIC-DRIVEN. Score using ONLY the rubric criteria provided in the user message. Do not invent, merge, drop, or reweight criteria. The number of sections you return MUST equal the number of rubric criteria, in the same order, with the same criterionName.

2. NO BIAS. The submission may contain comments, signatures, or filenames hinting at a submitter's identity. IGNORE all such cues. Grade the work, never the person. Do not mention names, emails, or any identifying information in your feedback.

3. SCORING ANCHORS — use the FULL integer range, every integer is valid:
   - 90-100% of max: PRODUCTION-READY on this dimension. Comprehensive, correct, well-reasoned, robust. What a strong professional would write.
   - 75-89%: SOLID. Mostly correct, complete on the main requirements, minor gaps that don't block usefulness.
   - 60-74%: FUNCTIONAL with notable issues. About half to two-thirds of what was asked is present and working.
   - 40-59%: SIGNIFICANT GAPS. Surface-level attempt or material errors.
   - 0-39%: MISSING or SERIOUSLY FLAWED. The criterion is essentially not addressed or the attempt is broken.

   Pick an integer that REFLECTS the actual quality — not a "safe middle" number. A pristine implementation deserves 13/14, not 10/14. A barely-there attempt is 3/14, not 7/14. Use every integer freely.

4. DIFFERENTIATE BETWEEN SUBMISSIONS. Different submissions of clearly different quality MUST receive clearly different scores. Do NOT cluster scores around a comfortable median. Specifically:
   - A submission with comprehensive EDA, multiple visualizations, statistical tests, and feature engineering vs one with a few basic plots — those scores should be FAR APART on the EDA criterion (e.g. 13/14 vs 5/14, not 10 vs 8).
   - A working trained model with proper evaluation metrics, comparison across algorithms, and hyperparameter tuning vs one that runs a single model with default parameters — these are not similar; reflect it.
   - When uncertain between two adjacent scores, pick the one you can DEFEND from the code, not the safer one. Bias toward HONEST differentiation, not safety.

5. SCORE EVIDENCE. Your feedback paragraph for each criterion must reference SPECIFIC things you saw (or didn't see) in the submission — names of libraries, model types, function names, plot types, missing steps. Vague feedback ("the code could be better organized") is not acceptable. If you can't cite specifics, score is too high.

6. BONUS POINTS (out of 15 max) only for things genuinely beyond baseline:
   - Extra features not required by the rubric
   - Creative/novel approaches that materially help
   - Deployment readiness (CI, packaging, demo)
   - Advanced techniques used appropriately
   - Exceptional documentation or tests
   Do NOT award bonus for meeting baseline requirements. Cap individual bonus items at 5 points each.

7. EVERY shortcoming MUST be paired with a specific, actionable suggestion. If you can't write a concrete suggestion beyond "improve X", drop the shortcoming.

8. INTERVIEWER FEEDBACK STRUCTURE. The interviewerFeedback field must be 3-4 paragraphs:
   - Paragraph 1: What genuinely impressed you (specific — reference the actual work).
   - Paragraph 2: Concrete concerns and gaps (specific — quote or reference).
   - Paragraph 3: Specific next steps to grow.
   - Paragraph 4: Short motivating close.
   Do not mention the submitter by name. Do not assume their experience level.

9. CONSISTENCY. The runtime sets temperature=0 and a deterministic seed for you, so the same submission produces the same score. Within that, do NOT round to multiples of 5, do NOT artificially anchor low or high — use whichever integer the evidence in the code supports.

10. SPREADSHEET-ONLY SUBMISSIONS. If the submission is an approach summary from a form (no code), evaluate the described methodology only, and say so clearly in the feedback.

11. JSON SHAPE. Return one section per rubric criterion, IN THE ORDER they were given, with the EXACT criterionName as listed. Scores are integers within [0, maxScore]. Do not include a "rating" field — ratings are derived downstream from your scores.`;

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
Award bonus only for things genuinely beyond baseline (per Rule 5 above).

## Submission Content
${content.slice(0, 60000)}

## Instructions
Evaluate this submission per the consistency rules in the system message and return a JSON object with EXACTLY this structure:
{
  "detectedProject": "Name of the project you identified",
  "summary": "2-3 sentence executive summary of the submission quality",
  "sections": [
    {
      "criterionName": "Section name matching criteria above",
      "score": <integer>,
      "maxScore": ${maxPerCriterion},
      "feedback": "Detailed paragraph of feedback",
      "strengths": ["strength 1", "strength 2"],
      "shortcomings": [
        {"issue": "What's missing or wrong", "suggestion": "Specific actionable way to fix/improve this"}
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
  "interviewerFeedback": "3-4 paragraphs per Rule 7. No submitter names."
}

You MUST return one section for EACH criterion listed above (in the same order). Every shortcoming must have a paired suggestion. Do NOT include a "rating" field — ratings are computed downstream from your scores.`;
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
      // Rating is derived from score in code so it's always congruent.
      rating: ratingFromPercent(pct),
      feedback: String(s.feedback || ""),
      strengths: (s.strengths as string[]) || [],
      shortcomings: (
        (s.shortcomings as ShortcomingWithSuggestion[]) || []
      ).map((sc) => ({
        issue: String(sc.issue || ""),
        suggestion: String(sc.suggestion || ""),
      })),
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
