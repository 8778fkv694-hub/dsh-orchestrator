/** Decode the Harness tool result independently of its human-facing renderer. */
function parseHarnessResult(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  for (const block of [...(result.content ?? [])].reverse()) {
    if (block.type !== 'text') continue;
    const raw = block.text.trim();
    const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(raw);
    try { return JSON.parse(fenced ? fenced[1] : raw); } catch { /* Human-facing summary; try the next block. */ }
  }
  throw new Error('Harness result has no structured object or JSON payload');
}
module.exports = { parseHarnessResult };
