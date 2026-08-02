# Margin

A handwritten journal that reads your photos and turns them into structured
Cornell notes, then helps you find the thread connecting them.

## Local setup

    npm install
    cp .env.example .env      # then paste your real Gemini API key into .env
    npm start

Visit http://localhost:3000

## Getting a free Gemini API key

1. Go to https://aistudio.google.com
2. Sign in with a Google account (no credit card needed)
3. Click "Get API key" -> "Create API key"
4. Paste it into your .env file as GEMINI_API_KEY

This uses Gemini's free tier (~1,500 requests/day, no expiration, no card).
Note: on the free tier, Google may use submitted prompts/images to improve
their models -- worth knowing since this app captures personal handwriting.

## Environment variables

- GEMINI_API_KEY (required) — your Google AI Studio API key. Never commit this.
- DAILY_CAP (optional, default 200) — max AI calls (transcribe + thread combined) per day, across all visitors. Keeps you safely under Gemini's free-tier daily quota.

## What this is

- Each visitor gets a private board, tied to a random ID stored in their
  browser (no login). Notes don't mix between visitors.
- All AI calls happen server-side — the API key never reaches the browser.
- Boards are stored in a local SQLite file (margin.db), created automatically.
