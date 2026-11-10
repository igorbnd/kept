// The model behind the Kept agent. Haiku 4.5 keeps a public demo cheap: every call here is a small,
// structured task (compile a rule, suggest three promises, classify a scan, write a 255-char note).
// Override with KEPT_MODEL (e.g. claude-opus-5-5) to trade cost for quality.
export const MODEL = process.env.KEPT_MODEL ?? "claude-haiku-4-5-20251001";
