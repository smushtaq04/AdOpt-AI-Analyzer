```markdown
# AdOpt-AI — Campaign Analyzer

This project provides a small web app (frontend + Node.js backend) that:
- Accepts ad campaign data (CSV file upload or pasted CSV/plain text).
- Computes core metrics (CTR, CPC, CPA, ROAS).
- Detects A/B tests and runs a two-proportion z-test for conversion rates.
- Builds a structured prompt and queries an LLM (OpenAI) for expert analysis and prioritized recommendations.

Important: keep your OpenAI API key on the server (environment variable OPENAI_API_KEY). Do NOT put your API key in client-side code.

## Input options
- Upload a CSV file (recommended).
- Or paste CSV / plain text into the textarea (first line must be headers).

Required CSV headers (case-sensitive):
- campaign_id
- platform (e.g., Meta, Google, TikTok)
- campaign_name
- impressions (numeric)
- clicks (numeric)
- conversions (numeric)
- spend (numeric)
- revenue (numeric)

Optional but recommended:
- variant — for A/B testing label (e.g., A, B)
- product — product name for cross-product comparisons
- ad_set, audience, start_date, end_date

## New UI controls
- Analysis Focus: choose one of:
  - Cross-Channel (e.g., Meta vs Google)
  - A/B Test Comparison
  - Same Platform (Different Products)
  - Same Platform (Same Product)
  - Custom / Mixed
- What do you want to analyze? — free text where you can be specific (e.g., "Which campaign has the best ROAS? Recommend reallocation and experiments.")

These values are included in the prompt sent to the LLM, and the LLM is asked to provide a concise executive summary, prioritized recommendations, KPI targets, and to ask follow-up questions if more details are required.

## Run locally
1. Install:
   npm install

2. Set your OpenAI API key:
   export OPENAI_API_KEY="sk-..."

3. Start server:
   npm start

4. Open http://localhost:5173 (or port printed in console). If you serve index.html from root, the Express static middleware will serve it (move index.html to a "public" directory or adjust server.js).

## Security & deployment
- Keep OPENAI_API_KEY secret on the server or platform secrets manager.
- Use HTTPS in production.
- Add authentication & rate-limiting for public endpoints.

## Next improvements
- Add automatic connectors to Google/Meta/TikTok Ads to fetch daily metrics.
- Add a dialog flow to collect additional optional inputs from the user when the LLM requests clarifying info.
- Add power/sample-size calculator in the UI.
- Persist analyses and allow time-series comparisons.

```