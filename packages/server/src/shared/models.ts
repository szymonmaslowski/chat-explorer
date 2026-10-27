export const claudeModels = ['sonnet', 'opus'] as const;

export type ClaudeModel = (typeof claudeModels)[number];
