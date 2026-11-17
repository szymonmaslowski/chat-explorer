const maxSummaryLength = 120;

const shortened = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > maxSummaryLength ? `${line.slice(0, maxSummaryLength - 1)}…` : line;
};

const fileName = (path: unknown) => (typeof path === 'string' ? path.split('/').at(-1)! : 'a file');

// The prefix Claude Code gives a tool from an MCP server, e.g. `mcp__chat__add_notes`.
const mcpToolName = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/;

// One line of activity per tool call, in words a reader follows.
export function toolSummary(name: string, input: Record<string, unknown> = {}) {
  switch (name) {
    case 'WebSearch':
      return shortened(`Searching the web for "${String(input.query ?? '')}"`);
    case 'WebFetch':
      return shortened(`Reading ${String(input.url ?? 'a web page')}`);
    case 'Read':
      return `Reading ${fileName(input.file_path)}`;
    case 'Bash':
      return shortened(`Running ${String(input.command ?? 'a command')}`);
    case 'Write':
    case 'Edit':
      return `Editing ${fileName(input.file_path)}`;
    case 'Task':
    case 'Agent':
      return shortened(`Starting a subagent: ${String(input.description ?? '')}`);
  }
  const mcpTool = name.match(mcpToolName)?.[1];
  return mcpTool ? `Using ${mcpTool.replaceAll('_', ' ')}` : `Using ${name}`;
}
