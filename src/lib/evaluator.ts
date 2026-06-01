import OpenAI from "openai";
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
// Consistency knobs — every evaluation uses the same model, temperature and
// seed, so the same submission produces (close to) the same grade. The rating
// labels are derived from the numeric score in code rather than asked from
// the AI, so they're always congruent with the percentage.
// ----------------------------------------------------------------------------

// Pin the model so a future silent rollover of the "gpt-4o" alias doesn't
// shift our grading distribution. Override with EVALUATOR_MODEL env var.
const MODEL = process.env.EVALUATOR_MODEL || "gpt-4o-2024-11-20";
const DETECTION_MODEL =
  process.env.EVALUATOR_DETECTION_MODEL || "gpt-4o-mini";
const TEMPERATURE = 0;
const SEED = 42;

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

  const response = await getOpenAI().chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: evaluationPrompt },
    ],
    temperature: TEMPERATURE,
    seed: SEED,
    max_tokens: 8000,
    response_format: { type: "json_object" },
  });

  const rawResult = JSON.parse(
    response.choices[0].message.content || "{}"
  );

  return formatEvaluationResult(
    rawResult,
    files[0]?.name || "Unknown",
    category,
    project?.title || rawResult.detectedProject || "Custom Project"
  );
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

  const response = await getOpenAI().chat.completions.create({
    model: DETECTION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You identify which project a code submission belongs to. Return JSON with a single field 'projectId'.",
      },
      {
        role: "user",
        content: `Known projects in category "${category}":\n${projectList}\n\nSubmission snippet:\n${snippet}\n\nWhich project does this belong to? Return JSON: {"projectId": "..."}`,
      },
    ],
    temperature: 0,
    seed: SEED,
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
- Thorough but fair
- Constructive and encouraging
- Specific with feedback (reference exact parts of the code)
- Always suggest HOW to improve, not just WHAT to improve
- Give credit for creativity, extra effort, and going beyond requirements

EVALUATION CONSISTENCY RULES (CRITICAL — apply uniformly to every submission):

1. STRICTLY RUBRIC-DRIVEN. Score using only the rubric criteria provided in this prompt. Do not invent or reweight criteria. Each criterion has the same max score across submissions.

2. NO BIAS. The submission may contain comments, signatures, or filenames hinting at a submitter's identity. IGNORE all such cues. Grade the work, never the person. Do not mention names, emails, or any identifying information in your feedback.

3. UNIFORM STANDARDS. The same code quality must receive the same score regardless of who submitted it or when. Score against the rubric, not against other submissions you've seen.

4. SCORING ANCHORS. Use these reference points for every criterion (as a percentage of that criterion's max):
   - 90-100%: Production-ready quality, correct, well-reasoned, exceeds expectations on this dimension.
   - 75-89%: Solid implementation, mostly correct, minor gaps, meets expectations.
   - 60-74%: Functional but with notable issues — partial coverage of what was asked.
   - 40-59%: Significant gaps — addresses the criterion superficially or with errors.
   - 0-39%: Missing or seriously flawed.
   Round to the nearest integer.

5. BONUS POINTS (out of 15 max) only for things genuinely beyond baseline:
   - Extra features not required by the rubric
   - Creative/novel approaches
   - Deployment readiness (CI, packaging, demo)
   - Use of advanced techniques where appropriate
   - Exceptional documentation or tests
   Do NOT award bonus for merely meeting baseline requirements.

6. EVERY shortcoming MUST be paired with a specific, actionable suggestion to overcome it.

7. INTERVIEWER FEEDBACK STRUCTURE. The interviewerFeedback field must be 3-4 paragraphs with this structure:
   - Paragraph 1: What impressed you (be specific — reference the actual work).
   - Paragraph 2: Concerns and gaps (be specific — quote or reference).
   - Paragraph 3: Concrete next steps to grow.
   - Paragraph 4: Short motivating close.
   Do not mention the submitter by name. Do not assume their experience level.

8. SPREADSHEET-ONLY SUBMISSIONS. If the submission is an approach summary from a form (no code), evaluate the described methodology only, and note clearly in the feedback that you graded the description rather than executable work.

9. EVALUATE EACH RUBRIC CRITERION INDIVIDUALLY with a specific integer score. Do not skip criteria.`;

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
