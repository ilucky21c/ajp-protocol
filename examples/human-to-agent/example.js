// Example 1: Human hiring an agent
// A user on ClawMarket hires a research agent.
// The platform wraps their request in a JobOffer and sends it.

// ── What the platform sends ───────────────────────────────────────────────

const jobOffer = {
  ajp: "0.1",
  job_id: "job_01J8X2K9M3N4P5Q6R7S8T9U0V1",
  parent_job_id: null,

  from: {
    type: "human",
    id: "user_alice_123",       // ClawMarket user ID
    provenance_id: null,        // humans don't have Provenance IDs
  },

  to: {
    provenance_id: "provenance:github:bob/research-assistant",
  },

  task: {
    type: "research",
    instruction: "Find the three most cited papers on transformer attention mechanisms published in 2024. Return titles, authors, citation counts, and a 2-sentence summary of each.",
    input: {},
    output_format: "json",
  },

  context: {
    credentials: {},
    memory: [],
    constraints: [],
  },

  budget: {
    max_usd: 0.50,
    max_seconds: 120,
    max_llm_tokens: 10000,
  },

  callback: {
    url: "https://clawmarket.com/api/jobs/job_01J8X2K9M3N4P5Q6R7S8T9U0V1/result",
    headers: { "Authorization": "Bearer clawmarket_token_xyz" },
  },

  issued_at: "2026-03-05T10:00:00Z",
  expires_at: "2026-03-05T10:02:00Z",
  signature: "sha256:a1b2c3d4e5f6...",
};

// ── What the agent returns ────────────────────────────────────────────────

const jobResult = {
  ajp: "0.1",
  job_id: "job_01J8X2K9M3N4P5Q6R7S8T9U0V1",
  status: "completed",

  output: {
    papers: [
      {
        title: "FlashAttention-3: Fast and Accurate Attention with Asynchrony and Low-precision",
        authors: ["Jay Shah", "Ganesh Bikshandi", "Ying Zhang", "Vijay Thakkar", "Pradeep Ramani", "Tri Dao"],
        citations: 412,
        summary: "Introduces hardware-aware optimizations for H100 GPUs achieving 1.5-2x speedup over FlashAttention-2. Combines asynchronous execution with low-precision arithmetic while maintaining numerical accuracy.",
      },
    ],
  },

  usage: {
    llm_tokens: 4821,
    duration_seconds: 18,
    cost_usd: 0.12,
  },

  agent: {
    provenance_id: "provenance:github:bob/research-assistant",
    version: "1.2.0",
    model: { provider: "anthropic", model_id: "claude-sonnet-4-5" },
  },

  completed_at: "2026-03-05T10:00:19Z",
  signature: "sha256:e5f6g7h8...",
};
