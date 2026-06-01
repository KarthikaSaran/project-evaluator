export interface ProjectData {
  id: string;
  category: ProjectCategory;
  title: string;
  description: string;
  fullContent: string;
  criteria: CriterionData[];
}

export interface CriterionData {
  name: string;
  description: string;
}

export type ProjectCategory =
  | "ml-mini-project"
  | "dl-mini-project"
  | "case-study-1"
  | "case-study-2"
  | "capstone-flagship"
  | "capstone-advanced"
  | "bring-your-own";

export const CATEGORY_LABELS: Record<ProjectCategory, string> = {
  "ml-mini-project": "ML Mini Project",
  "dl-mini-project": "DL Mini Project",
  "case-study-1": "Case Study 1",
  "case-study-2": "Case Study 2",
  "capstone-flagship": "Capstone - Flagship ML",
  "capstone-advanced": "Capstone - Advanced ML",
  "bring-your-own": "Bring Your Own Project",
};

export interface SubmissionFile {
  name: string;
  type: string;
  content: string;
  size: number;
}

export interface EvaluationSection {
  criterionName: string;
  score: number;
  maxScore: number;
  rating: "Excellent" | "Good" | "Fair" | "Poor";
  feedback: string;
  strengths: string[];
  shortcomings: ShortcomingWithSuggestion[];
  /** Specific concrete things found in the submission that fulfill this criterion. */
  evidence?: string[];
  /** Specific concrete things missing from the submission per this criterion. */
  gaps?: string[];
}

export interface ShortcomingWithSuggestion {
  issue: string;
  suggestion: string;
}

export interface EvaluationResult {
  id: string;
  submissionName: string;
  detectedProject: string;
  category: ProjectCategory;
  timestamp: string;
  overallScore: number;
  maxPossibleScore: number;
  percentageScore: number;
  overallRating: string;
  sections: EvaluationSection[];
  pros: string[];
  cons: ShortcomingWithSuggestion[];
  scopeForImprovement: string[];
  bonusPoints: BonusPoints;
  interviewerFeedback: string;
  summary: string;
}

export interface BonusPoints {
  score: number;
  maxScore: number;
  details: BonusDetail[];
}

export interface BonusDetail {
  feature: string;
  points: number;
  comment: string;
}

export interface SpreadsheetSubmission {
  email: string;
  fileLink: string;
  approachSummary: string;
  challenges: string;
  additionalComments: string;
  timeSpent: number | null;
  rating: number | null;
  caseStudyType?: string;
}
