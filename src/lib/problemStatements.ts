import { ProblemStatement } from "./types";

export const PROBLEM_STATEMENTS: ProblemStatement[] = [
  {
    id: "lending-club",
    category: "ml-mini-project",
    title: "Lending Club Loan Approval System",
    description: `Lending Club faces a critical challenge: assessing loan applications accurately to avoid defaults and missed opportunities with credit-worthy borrowers. The objective is to build a machine learning model that predicts whether a borrower will default on their loan. This involves analyzing historical data and various features like borrower credit scores, debt-to-income ratios, loan purposes, and other financial metrics. The solution should classify loan applications into two categories: "likely to default" or "likely to be repaid." The model should be able to make the prediction before the loan is approved.`,
    deliverables: [
      "Dataset Overview with key features, target variables, and data types",
      "Exploratory Data Analysis (EDA) with visualizations and statistical summaries",
      "Data Processing and Feature Engineering",
      "Model Training and Hyperparameter Tuning",
      "Model Evaluation with appropriate metrics",
      "Result Analysis and Future Work",
    ],
    evaluationCriteria: [
      {
        name: "Dataset Overview",
        description:
          "Detailed explanation of the dataset including key features, target variables, data types, and scope of the problem",
        maxScore: 15,
      },
      {
        name: "Data Loading & Preprocessing",
        description:
          "Handling missing values, outlier detection, encoding categorical features, scaling numerical variables",
        maxScore: 15,
      },
      {
        name: "Exploratory Data Analysis (EDA)",
        description:
          "Univariate and multivariate analysis, visualizations, pattern identification, documented observations",
        maxScore: 15,
      },
      {
        name: "Model Selection",
        description:
          "Multiple algorithm evaluation (logistic regression, decision trees, random forests, gradient boosting), justification for choices",
        maxScore: 15,
      },
      {
        name: "Hyperparameter Tuning",
        description:
          "Grid search, random search, or advanced optimization; cross-validation; parameter documentation",
        maxScore: 15,
      },
      {
        name: "Model Evaluation",
        description:
          "Precision, recall, F1-score, ROC-AUC, confusion matrix analysis, comparison across models",
        maxScore: 15,
      },
      {
        name: "Result Analysis & Future Work",
        description:
          "Insightful conclusions, actionable recommendations, identified areas for improvement, future enhancement proposals",
        maxScore: 10,
      },
    ],
  },
  {
    id: "imdb-cinebot",
    category: "case-study-2",
    title: "CineBot - An IMDB Movie Chatbot",
    description: `Build a chatbot that understands natural language queries and retrieves relevant movie information from an IMDb dataset. The chatbot should process user inputs conversationally, retrieve and display relevant movie details, and handle follow-up questions dynamically. The solution should leverage NLP and LLMs with retrieval-based approaches like FAISS for fast movie matching. Deploy via Gradio/Streamlit for user interaction.`,
    deliverables: [
      "Dataset Overview with summary of features and key insights",
      "Exploratory Data Analysis with distribution of genres, ratings, trends",
      "Data Preprocessing & Feature Engineering",
      "Model Implementation using GPT API and FAISS/Vector Search",
      "Chatbot Interface with interactive UI",
      "Evaluation & Future Work including agentic AI architecture",
    ],
    evaluationCriteria: [
      {
        name: "Dataset Overview",
        description:
          "Summary of IMDb dataset features, key insights, data quality assessment",
        maxScore: 10,
      },
      {
        name: "Data Preprocessing & Feature Engineering",
        description:
          "Missing value handling, text vectorization, embedding generation",
        maxScore: 15,
      },
      {
        name: "Exploratory Data Analysis (EDA)",
        description:
          "Genre distributions, rating analysis, keyword trends, meaningful visualizations",
        maxScore: 10,
      },
      {
        name: "RAG / Retrieval Implementation",
        description:
          "FAISS/vector search setup, embedding quality, retrieval accuracy, context window management",
        maxScore: 20,
      },
      {
        name: "LLM Integration & Chatbot Logic",
        description:
          "GPT API integration, prompt engineering, conversation handling, follow-up support",
        maxScore: 20,
      },
      {
        name: "User Interface & Deployment",
        description:
          "Gradio/Streamlit UI quality, usability, deployment readiness",
        maxScore: 15,
      },
      {
        name: "Result Analysis & Future Work",
        description:
          "Performance analysis, improvement proposals, agentic AI architecture discussion",
        maxScore: 10,
      },
    ],
  },
];

export function findProblemStatement(
  id: string
): ProblemStatement | undefined {
  return PROBLEM_STATEMENTS.find((ps) => ps.id === id);
}

export function getProblemStatementsByCategory(
  category: string
): ProblemStatement[] {
  return PROBLEM_STATEMENTS.filter((ps) => ps.category === category);
}
