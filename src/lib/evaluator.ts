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

function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

export async function evaluateSubmission(
  files: SubmissionFile[],
  category: ProjectCategory,
  projectId?: string,
  customProblemStatement?: string
): Promise<EvaluationResult> {
  const combinedContent = files
    .map((f) => `=== File: ${f.name} (${f.type}) ===\n${f.content}`)
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
      criteria = project.criteria.length > 0 ? project.criteria : getGenericCriteria();
    } else {
      problemContext = "Unknown project. Evaluate as a general data science / ML project.";
      criteria = getGenericCriteria();
    }
  } else {
    project = await autoDetectProject(combinedContent, category);
    if (project) {
      problemContext = `Title: ${project.title}\nDescription: ${project.description}\n\nFull Problem Statement:\n${project.fullContent}`;
      criteria = project.criteria.length > 0 ? project.criteria : getGenericCriteria();
    } else {
      problemContext = "Unable to detect specific project. Evaluate as a general data science / ML project.";
      criteria = getGenericCriteria();
    }
  }

  const evaluationPrompt = buildEvaluationPrompt(
    combinedContent,
    problemContext,
    criteria
  );

  const response = await getOpenAI().chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: evaluationPrompt },
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
    model: "gpt-4o-mini",
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
    response_format: { type: "json_object" },
  });

  const result = JSON.parse(
    response.choices[0].message.content || '{"projectId": "unknown"}'
  );
  return candidates.find((p) => p.id === result.projectId);
}

const SYSTEM_PROMPT = `You are an expert technical evaluator and interviewer who reviews take-home assignments for data science, machine learning, deep learning, NLP, computer vision, and Gen AI projects.

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
4. The feedback should help the learner grow - be the mentor they need
5. If the submission is from a spreadsheet (approach summary only, no code), evaluate based on the described approach and methodology
6. Evaluate EACH criterion from the rubric individually with specific scores`;

function buildEvaluationPrompt(
  content: string,
  problemContext: string,
  criteria: CriterionData[]
): string {
  const maxPerCriterion = Math.max(5, Math.round(100 / Math.max(criteria.length, 1)));
  const criteriaList = criteria
    .map(
      (c) =>
        `- ${c.name} (max ${maxPerCriterion} points): ${c.description || "Evaluate quality and completeness"}`
    )
    .join("\n");

  const maxTotal = maxPerCriterion * criteria.length;

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
      "maxScore": ${maxPerCriterion},
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

You MUST return one section for EACH criterion listed above. Be thorough, fair, and constructive. Every shortcoming must have a paired suggestion.`;
}

function getGenericCriteria(): CriterionData[] {
  return [
    { name: "Problem Understanding & Dataset Overview", description: "Understanding of the problem, dataset exploration, feature documentation" },
    { name: "Data Preprocessing & Feature Engineering", description: "Data cleaning, missing values, encoding, scaling, feature creation" },
    { name: "Exploratory Data Analysis", description: "Visualizations, statistical analysis, pattern identification" },
    { name: "Model Implementation", description: "Algorithm selection, implementation quality, technical correctness" },
    { name: "Evaluation & Results", description: "Metrics selection, model comparison, interpretation of results" },
    { name: "Code Quality & Documentation", description: "Code organization, readability, comments, reproducibility" },
    { name: "Conclusions & Future Work", description: "Insights, recommendations, identified improvements" },
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
    score: Number((raw.bonusPoints as Record<string, unknown>)?.score) || 0,
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
    percentageScore: maxPossible > 0 ? Math.round((overallScore / maxPossible) * 100) : 0,
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
