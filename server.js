#!/usr/bin/env node
/**
 * Simple Express server for AdOpt-AI analysis.
 * - Expects POST /analyze with JSON body:
 *   { campaigns: [...], model?: "gpt-4o-mini", analysis_focus?: "...", analysis_question?: "..." }
 *
 * Environment:
 *   OPENAI_API_KEY - required to call the LLM.
 *
 * Start:
 *   npm install
 *   export OPENAI_API_KEY="sk-..."
 *   node server.js
 */
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = global.fetch || require('node-fetch');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '5mb' }));
app.use(express.static('public')); // optional, but serves index.html if you put it there

const PORT = process.env.PORT || 5173;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set. The server will return the prompt instead of calling the LLM.');
}

/** Helpers to coerce numeric columns */
function parseNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v || 0;
  const n = Number(String(v).replace(/[^0-9.\-eE]/g, ''));
  return isNaN(n) ? 0 : n;
}

/** Compute metrics for each campaign row */
function computeCampaignMetrics(rows) {
  return rows.map(r => {
    const impressions = parseNum(r.impressions);
    const clicks = parseNum(r.clicks);
    const conversions = parseNum(r.conversions);
    const spend = parseNum(r.spend);
    const revenue = parseNum(r.revenue);

    const CTR = impressions > 0 ? (clicks / impressions) : 0;
    const CPC = clicks > 0 ? (spend / clicks) : 0;
    const CPA = conversions > 0 ? (spend / conversions) : 0;
    const ROAS = spend > 0 ? (revenue / spend) : 0;

    return {
      ...r,
      impressions, clicks, conversions, spend, revenue,
      CTR, CPC, CPA, ROAS
    };
  });
}

/** Group helper */
function groupBy(arr, keyFn) {
  return arr.reduce((acc, cur) => {
    const k = keyFn(cur);
    acc[k] = acc[k] || [];
    acc[k].push(cur);
    return acc;
  }, {});
}

/** Two-proportion z-test (for A/B conversion rates) */
function twoPropZTest(convA, nA, convB, nB) {
  if (nA <= 0 || nB <= 0) return { z: 0, pValue: 1, significant: false, p1:0, p2:0 };
  const p1 = convA / nA;
  const p2 = convB / nB;
  const pPool = (convA + convB) / (nA + nB);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / nA + 1 / nB));
  if (se === 0) return { z: 0, pValue: 1, significant: false, p1, p2 };
  const z = (p1 - p2) / se;
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  const significant = pValue < 0.05;
  return { z, pValue, significant, p1, p2 };
}
function normalCdf(z) { return 0.5 * (1 + erf(z / Math.sqrt(2))); }
function erf(x) {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741, a4 = -1.453152027, a5 =  1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t*Math.exp(-x*x);
  return sign * y;
}

/** Builds a human prompt for LLM using computed summaries and user selections */
function buildPrompt(summaryByPlatform, overallTotals, abTests, sampleRows, analysis_focus, analysis_question) {
  let prompt = `You are an expert growth marketer and data scientist. A user has requested analysis with the following focus: "${analysis_focus}".\nUser question / request: "${analysis_question || 'None provided'}"\n\nYou will analyze ad campaign performance across channels (Meta, Google, TikTok and others), compare campaigns for the same product across channels, and evaluate A/B tests as relevant to the user's selected focus. Use the computed metrics and A/B test results provided. Produce:\n- A concise executive summary (3-6 bullets)\n- Prioritized recommendations (ranked by expected impact and ease of implementation)\n- Specific action items (tests to run next, budget shifts, creative changes, audience recommendations)\n- KPI targets and guardrails\n- Suggested experiment sample sizes or next steps when statistical power is insufficient\n- A short explanation of expected business impact with conservative estimates\nIf you need clarifying info from the user (time windows, desired KPI weighting, minimum ROAS, acceptable CPA), ask focused follow-up questions. Keep recommendations concise and actionable. Provide any assumptions you make.\n\nSummary of platform-level aggregates:\n\n`;

  Object.entries(summaryByPlatform).forEach(([platform, s]) => {
    prompt += `Platform: ${platform}\n  Impressions: ${s.totalImpr}\n  Clicks: ${s.totalClicks}\n  Conversions: ${s.totalConv}\n  Spend: ${s.totalSpend}\n  Revenue: ${s.totalRevenue}\n  CTR: ${(s.CTR*100).toFixed(2)}%\n  CPC: ${s.CPC.toFixed(2)}\n  CPA: ${s.CPA.toFixed(2)}\n  ROAS: ${s.ROAS.toFixed(2)}\n\n`;
  });

  prompt += `Overall totals:\n  Impressions: ${overallTotals.totalImpr}\n  Clicks: ${overallTotals.totalClicks}\n  Conversions: ${overallTotals.totalConv}\n  Spend: ${overallTotals.totalSpend}\n  Revenue: ${overallTotals.totalRevenue}\n  CTR: ${(overallTotals.CTR*100).toFixed(2)}%\n  CPC: ${overallTotals.CPC.toFixed(2)}\n  CPA: ${overallTotals.CPA.toFixed(2)}\n  ROAS: ${overallTotals.ROAS.toFixed(2)}\n\n`;

  if (abTests.length) {
    prompt += `A/B tests detected (summary):\n`;
    abTests.forEach(t=>{
      prompt += `Campaign: ${t.campaign_name} (platform: ${t.platform}, product: ${t.product||'N/A'})\n  Variant A: conv=${t.A.conv}/${t.A.n} rate=${(t.A.p*100).toFixed(2)}%\n  Variant B: conv=${t.B.conv}/${t.B.n} rate=${(t.B.p*100).toFixed(2)}%\n  z=${t.z.toFixed(3)} p=${t.pValue.toFixed(4)} significant=${t.significant}\n\n`;
    });
  } else {
    prompt += `No A/B tests with variant data were detected.\n\n`;
  }

  prompt += `Here are example campaign rows (first 6 rows):\n`;
  sampleRows.slice(0,6).forEach(r=>{
    prompt += JSON.stringify(r) + '\n';
  });

  prompt += `\nAnalysis expectations and constraints:
- Prioritize actions that increase sustainable growth and decrease CPA while maintaining or improving ROAS.
- Where decisions require statistical confidence, recommend sample sizes and targets for significance.
- Suggest concrete next experiments (creative, audience, bid strategy, funnel) with expected effect and timeline (1-4 weeks).
- Provide suggested KPI guardrails (target CTR, CPC, CPA, ROAS) per platform or product when relevant.
- If budget reallocation is recommended, specify amounts/percentages and rationale.
\nNow provide the analysis.`;

  return prompt;
}

app.post('/analyze', async (req, res) => {
  try {
    const body = req.body || {};
    const rawCampaigns = body.campaigns;
    const model = body.model || 'gpt-4o-mini';
    const analysis_focus = body.analysis_focus || 'unspecified';
    const analysis_question = body.analysis_question || '';

    if (!Array.isArray(rawCampaigns)) return res.status(400).send('body.campaigns must be an array (parsed CSV rows)');

    // Compute per-row metrics
    const computed = computeCampaignMetrics(rawCampaigns);

    // Summaries by platform
    const byPlatform = {};
    computed.forEach(r => {
      const p = (r.platform || 'unknown');
      byPlatform[p] = byPlatform[p] || { totalImpr:0, totalClicks:0, totalConv:0, totalSpend:0, totalRevenue:0 };
      byPlatform[p].totalImpr += r.impressions || 0;
      byPlatform[p].totalClicks += r.clicks || 0;
      byPlatform[p].totalConv += r.conversions || 0;
      byPlatform[p].totalSpend += r.spend || 0;
      byPlatform[p].totalRevenue += r.revenue || 0;
    });
    Object.entries(byPlatform).forEach(([k,v])=>{
      v.CTR = v.totalImpr>0? v.totalClicks / v.totalImpr : 0;
      v.CPC = v.totalClicks>0? v.totalSpend / v.totalClicks : 0;
      v.CPA = v.totalConv>0? v.totalSpend / v.totalConv : 0;
      v.ROAS = v.totalSpend>0? v.totalRevenue / v.totalSpend : 0;
    });

    const overall = { totalImpr:0, totalClicks:0, totalConv:0, totalSpend:0, totalRevenue:0 };
    computed.forEach(r=>{
      overall.totalImpr += r.impressions;
      overall.totalClicks += r.clicks;
      overall.totalConv += r.conversions;
      overall.totalSpend += r.spend;
      overall.totalRevenue += r.revenue;
    });
    overall.CTR = overall.totalImpr>0? overall.totalClicks / overall.totalImpr : 0;
    overall.CPC = overall.totalClicks>0? overall.totalSpend / overall.totalClicks : 0;
    overall.CPA = overall.totalConv>0? overall.totalSpend / overall.totalConv : 0;
    overall.ROAS = overall.totalSpend>0? overall.totalRevenue / overall.totalSpend : 0;

    // Detect A/B tests
    const groupedCampaign = groupBy(computed, r=>`${r.platform||'unknown'}|${r.campaign_name||'unknown'}|${r.product||''}`);
    const abTests = [];
    Object.values(groupedCampaign).forEach(group=>{
      const variants = group.reduce((acc,c)=>{
        const v = (c.variant || 'default');
        acc[v] = acc[v] || { conversions:0, denom:0, rows:[] };
        acc[v].conversions += parseNum(c.conversions);
        acc[v].denom += (c.clicks>0? c.clicks : c.impressions);
        acc[v].rows.push(c);
        return acc;
      }, {});
      const variantNames = Object.keys(variants);
      if (variantNames.length >= 2) {
        const Aname = variantNames[0], Bname = variantNames[1];
        const A = variants[Aname], B = variants[Bname];
        const Aconv = A.conversions, An = A.denom;
        const Bconv = B.conversions, Bn = B.denom;
        const test = twoPropZTest(Aconv, An, Bconv, Bn);
        abTests.push({
          campaign_name: group[0].campaign_name,
          platform: group[0].platform,
          product: group[0].product,
          A: { name: Aname, conv: Aconv, n: An, p: An>0? Aconv/An:0 },
          B: { name: Bname, conv: Bconv, n: Bn, p: Bn>0? Bconv/Bn:0 },
          z: test.z, pValue: test.pValue, significant: test.significant
        });
      }
    });

    // Build prompt using the analysis focus & question
    const prompt = buildPrompt(byPlatform, overall, abTests, computed.slice(0,6), analysis_focus, analysis_question);

    // If no API key, skip call
    let llmResponse = null;
    if (!OPENAI_KEY) {
      llmResponse = "OPENAI_API_KEY not set on server. The prompt below is ready to be sent to an LLM:\n\n" + prompt;
    } else {
      const pbody = {
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 1000
      };

      const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_KEY}`
        },
        body: JSON.stringify(pbody)
      });
      if (!openaiResp.ok) {
        const errText = await openaiResp.text();
        return res.status(500).send('OpenAI error: ' + errText);
      }
      const openaiJson = await openaiResp.json();
      llmResponse = openaiJson.choices.map(c => c.message?.content).join('\n\n');
    }

    res.json({
      computed_campaigns: computed,
      platform_summary: byPlatform,
      overall_summary: overall,
      ab_tests: abTests,
      llm_response: llmResponse
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server error: ' + (err.message || String(err)));
  }
});

app.listen(PORT, () => {
  console.log(`AdOpt-AI server running on port ${PORT}`);
});