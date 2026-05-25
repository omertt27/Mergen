/**
 * token-budget.ts — Soft token-limit helpers for MCP tool responses
 *
 * Prevents context window saturation by truncating responses when they exceed
 * a budget. Uses rough estimation (1 token ≈ 4 chars) for speed.
 */

/** Estimate tokens from text length (rough: 1 token ≈ 4 characters) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface TruncationResult {
  result: string;
  truncated: boolean;
  omitted: number;
  estimatedTokens: number;
}

/**
 * Truncates an array of strings to fit within a token budget.
 * Returns the combined result, truncation status, and count of omitted items.
 */
export function truncateToTokenBudget(
  items: string[],
  maxTokens?: number,
  separator = '\n'
): TruncationResult {
  if (!maxTokens || items.length === 0) {
    const result = items.join(separator);
    return {
      result,
      truncated: false,
      omitted: 0,
      estimatedTokens: estimateTokens(result),
    };
  }

  let totalTokens = 0;
  let included = 0;

  for (let i = 0; i < items.length; i++) {
    const itemTokens = estimateTokens(items[i]) + estimateTokens(separator);
    if (totalTokens + itemTokens <= maxTokens) {
      totalTokens += itemTokens;
      included = i + 1;
    } else {
      break;
    }
  }

  const omitted = items.length - included;
  let result = items.slice(0, included).join(separator);

  if (omitted > 0) {
    const footer = `\n\n[...truncated, +${omitted} more items not shown due to token budget. Call again with higher max_tokens or add filters to reduce noise.]`;
    result += footer;
    totalTokens += estimateTokens(footer);
  }

  return {
    result,
    truncated: omitted > 0,
    omitted,
    estimatedTokens: totalTokens,
  };
}

/**
 * Truncates a single text block to fit within a token budget.
 * Useful for long strings like stack traces or response bodies.
 */
export function truncateText(text: string, maxTokens: number): TruncationResult {
  const tokens = estimateTokens(text);

  if (tokens <= maxTokens) {
    return {
      result: text,
      truncated: false,
      omitted: 0,
      estimatedTokens: tokens,
    };
  }

  // Truncate to approximate character count
  const maxChars = maxTokens * 4;
  const truncated = text.slice(0, maxChars);
  const omittedChars = text.length - maxChars;
  const footer = `\n[...truncated, +${omittedChars} more characters]`;

  return {
    result: truncated + footer,
    truncated: true,
    omitted: 1,
    estimatedTokens: estimateTokens(truncated + footer),
  };
}
