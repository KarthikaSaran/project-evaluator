# Project Evaluator

AI-powered project submission evaluator that generates detailed PDF reports with scores, feedback, and actionable improvement suggestions.

**Live:** [project-evaluator-gold.vercel.app](https://project-evaluator-gold.vercel.app)

## Features

- **6 Project Categories**: ML Mini Project, DL Mini Project, Case Study 1, Case Study 2, Capstone, Bring Your Own Project
- **Multiple Input Formats**: Upload `.ipynb`, `.py`, `.zip` files individually or `.xlsx` spreadsheets for bulk evaluation
- **Auto-Detection**: AI identifies the project type from submission content
- **Detailed PDF Reports**: Professional reports with section-by-section scores, pros/cons, improvement suggestions, and interviewer-style feedback
- **Bonus Scoring**: Extra points for creativity, advanced techniques, clean code, and going beyond requirements
- **Pre-loaded Problem Statements**: Lending Club Loan Approval (ML) and IMDB CineBot (NLP/Chatbot)
- **Custom Projects**: "Bring Your Own Project" mode with problem statement upload

## How It Works

1. **Select Category** - Choose the project type being evaluated
2. **Upload Submissions** - Drag and drop code files or bulk spreadsheets
3. **AI Evaluation** - OpenAI GPT-4o analyzes code quality, methodology, and completeness
4. **Download Reports** - Get professional PDF reports for each submission

## Report Contents

Each PDF report includes:
- Overall score and rating
- Section-by-section evaluation with scores
- Strengths and areas for growth
- Every shortcoming paired with an actionable suggestion
- Scope for improvement
- Bonus points for creativity and extra features
- Interviewer-style feedback (as if reviewing a take-home assignment)

## Setup

```bash
npm install
cp .env.example .env.local
# Add your OpenAI API key to .env.local
npm run dev
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Your OpenAI API key (required) |

## Tech Stack

- **Frontend**: Next.js 16, React, TypeScript, Tailwind CSS
- **AI**: OpenAI GPT-4o
- **PDF**: PDFKit
- **File Parsing**: XLSX (SheetJS), JSZip
- **Deployment**: Vercel
