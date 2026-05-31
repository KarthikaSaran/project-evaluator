import OpenAI from "openai";
import {
  EvaluationResult,
  SubmissionFile,
  ProblemStatement,
  ProjectCategory,
  EvaluationSection,
  ShortcomingWithSuggestion,
  BonusPoints,
} from "./types";
import { PROBLEM_STATEMENTS } from "./problemStatements";

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

export async function evaluateSubmission(
  files: SubmissionFile[],
  category: ProjectCategory,
  customProblemStatement?: string
): Promise<EvaluationResult> {
  const combinedContent = files
    .map((f) => `=== File: ${f.name} (${f.type}) ===\n${f.content}`)
    .join("\n\n");

  let problemStatement: ProblemStatement | undefined;
  let problemContext: string;

  if (category === "bring-your-own" && customProblemStatement) {
    problemContext = customProblemStatement;
  } else {
    problemStatement = PROBLEM_STATEMENTS.find(
      (ps) => ps.category === category
    );
    if (!problemStatement) {
      problemStatement = await autoDetectProject(combinedContent);
    }
    problemContext = problemStatement
      ? `Title: ${problemStatement.title}\nDescription: ${problemStatement.description}\nExpected Deliverables: ${problemStatement.deliverables.join(", ")}`
      : "Unable to detect specific project. Evaluate as a general data science / ML project.";
  }

  const criteria = problemStatement?.evaluationCriteria || getGenericCriteria();

  const evaluationPrompt = buildEvaluationPrompt(
    combinedContent,
    problemContext,
    criteria,
    category
  );

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: evaluationPrompt,
      },
    ],
    temperature: 0.3,
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
    problemStatement?.title || rawResult.detectedProject || "Custom Project"
  );
}

async function autoDetectProject(
  content: string
): Promise<ProblemStatement | undefined> {
  const snippet = content.slice(0, 3000);

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You identify which project a code submission belongs to. Return JSON with a single field 'projectId' matching one of the known projects, or 'unknown'.",
      },
      {
        role: "user",
        content: `Known projects:\n${PROBLEM_STATEMENTS.map((ps) => `- ${ps.id}: ${ps.title}`).join("\n")}\n\nSubmission snippet:\n${snippet}\n\nWhich project does this belong to? Return JSON: {"projectId": "..."}`,
      },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(
    response.choices[0].message.content || '{"projectId": "unknown"}'
  );
  return PROBLEM_STATEMENTS.find((ps) => ps.id === result.projectId);
}

const SYSTEM_PROMPT = `You are an expert technical evaluator and interviewer who reviews take-home assignments for data science, machine learning, and deep learning projects.

Your evaluation style is like a senior interviewer at a top tech company reviewing a candidate's take-home assignment. You are:
- Thorough but fair
- Constructive and encouraging
- Specific with feedback (reference exact parts of the code)
- Always suggest HOW to improve, not just WHAT to improve
- Give credit for creativity, extra effort, and going beyond requirements

IMPORTANT RULES:
1. Every shortcoming MUST be paired with a specific, actionable suggestion to overcome it
2. Score generously for genuine effort but accurately for technical quality
3. Award bonus points for: extra features, creative approaches, clean code, good documentation, deployment readiness, use of advanced techniques
4. The feedback should help the learner grow — be the mentor they need
5. If the submission is from a spreadsheet (approach summary only, no code), evaluate based on the described approach and methodology`;

function buildEvaluationPrompt(
  content: string,
  problemContext: string,
  criteria: { name: string; description: string; maxScore: number }[],
  category: ProjectCategory
): string {
  const criteriaList = criteria
    .map(
      (c) =>
        `- ${c.name} (max ${c.maxScore} points): ${c.description}`
    )
    .join("\n");

  const maxTotal = criteria.reduce((sum, c) => sum + c.maxScore, 0);

  return `## Problem Statement
${problemContext}

## Evaluation Criteria (Total: ${maxTotal} points + up to 15 bonus points)
${criteriaList}

## Bonus Points (up to 15 points)
Award bonus for: extra features beyond requirements, creative/innovative approaches, clean & well-documented code, deployment readiness, use of advanced techniques, comprehensive error handling, good software engineering practices.

## Submission Content
${content.slice(0, 60000)}

## Instructions
Evaluate this submission and return a JSON object with EXACTLY this structure:
{
  "detectedProject": "Name of the project you identified",
  "summary": "2-3 sentence executive summary of the submission quality",
  "overallRating": "Excellent" | "Good" | "Fair" | "Poor",
  "sections": [
    {
      "criterionName": "Section name matching criteria above",
      "score": <number>,
      "maxScore": <number>,
      "rating": "Excellent" | "Good" | "Fair" | "Poor",
      "feedback": "Detailed paragraph of feedback",
      "strengths": ["strength 1", "strength 2"],
      "shortcomings": [
        {"issue": "What's missing or wrong", "suggestion": "Specific actionable way to fix/improve this"}
      ]
    }
  ],
  "pros": ["Overall strength 1", "Overall strength 2", ...],
  "cons": [
    {"issue": "Overall weakness", "suggestion": "How to overcome this"},
    ...
  ],
  "scopeForImprovement": ["Specific improvement area 1", "Specific improvement area 2", ...],
  "bonusPoints": {
    "score": <number 0-15>,
    "details": [
      {"feature": "What was impressive", "points": <number>, "comment": "Why this deserves bonus points"}
    ]
  },
  "interviewerFeedback": "A 3-4 paragraph interviewer-style feedback as if you're sitting across the table from the candidate. Be encouraging but honest. Highlight what impressed you, what concerned you, and specific next steps for growth. End with a motivating note."
}

Be thorough, fair, and constructive. Every shortcoming must have a paired suggestion.`;
}

function getGenericCriteria() {
  return [
    {
      name: "Problem Understanding & Dataset Overview",
      description:
        "Understanding of the problem, dataset exploration, feature documentation",
      maxScore: 15,
    },
    {
      name: "Data Preprocessing & Feature Engineering",
      description:
        "Data cleaning, missing values, encoding, scaling, feature creation",
      maxScore: 15,
    },
    {
      name: "Exploratory Data Analysis",
      description:
        "Visualizations, statistical analysis, pattern identification",
      maxScore: 15,
    },
    {
      name: "Model Implementation",
      description:
        "Algorithm selection, implementation quality, technical correctness",
      maxScore: 20,
    },
    {
      name: "Evaluation & Results",
      description:
        "Metrics selection, model comparison, interpretation of results",
      maxScore: 15,
    },
    {
      name: "Code Quality & Documentation",
      description:
        "Code organization, readability, comments, reproducibility",
      maxScore: 10,
    },
    {
      name: "Conclusions & Future Work",
      description:
        "Insights, recommendations, identified improvements",
      maxScore: 10,
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
  ).map(
    (s): EvaluationSection => ({
      criterionName: String(s.criterionName || ""),
      score: Number(s.score) || 0,
      maxScore: Number(s.maxScore) || 0,
      rating: (s.rating as EvaluationSection["rating"]) || "Fair",
      feedback: String(s.feedback || ""),
      strengths: (s.strengths as string[]) || [],
      shortcomings: (
        (s.shortcomings as ShortcomingWithSuggestion[]) || []
      ).map((sc) => ({
        issue: String(sc.issue || ""),
        suggestion: String(sc.suggestion || ""),
      })),
    })
  );

  const sectionTotal = sections.reduce((sum, s) => sum + s.score, 0);
  const maxSectionTotal = sections.reduce((sum, s) => sum + s.maxScore, 0);

  const bonus: BonusPoints = {
    score: Number(
      (raw.bonusPoints as Record<string, unknown>)?.score
    ) || 0,
    maxScore: 15,
    details: (
      ((raw.bonusPoints as Record<string, unknown>)?.details as Array<Record<string, unknown>>) || []
    ).map((d) => ({
      feature: String(d.feature || ""),
      points: Number(d.points) || 0,
      comment: String(d.comment || ""),
    })),
  };

  const overallScore = sectionTotal + bonus.score;
  const maxPossible = maxSectionTotal + bonus.maxScore;

  return {
    id: generateId(),
    submissionName,
    detectedProject,
    category,
    timestamp: new Date().toISOString(),
    overallScore,
    maxPossibleScore: maxPossible,
    percentageScore: Math.round((overallScore / maxPossible) * 100),
    overallRating: String(raw.overallRating || "Fair"),
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
