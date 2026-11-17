// CommonMark lets only a list that starts at 1 interrupt a paragraph, so "**Data**" followed by
// "4. Stored…" renders as one run-on paragraph. Claude often writes headings and lists that way,
// so its answers get the missing blank lines when they are saved.

const fence = /^ {0,3}(```|~~~)/;
const orderedItem = /^\d{1,9}[.)][ \t]/;
const listItem = /^(?:[-*+]|\d{1,9}[.)])[ \t]/;
const boldHeading = /^\*\*[^*].*\*\*:?[ \t]*$/;

const isBlank = (line: string) => line.trim() === '';
const isIndented = (line: string) => /^[ \t]/.test(line);

export function repairMarkdown(source: string) {
  const repaired: string[] = [];
  let inFence = false;
  let previous = '';
  for (const line of source.split('\n')) {
    if (fence.test(line)) inFence = !inFence;
    const previousIsParagraph =
      !inFence && !isBlank(previous) && !isIndented(previous) && !listItem.test(previous);
    const startsList = orderedItem.test(line);
    const followsHeading = boldHeading.test(previous) && !isBlank(line) && !fence.test(line);
    if (previousIsParagraph && (startsList || followsHeading)) repaired.push('');
    repaired.push(line);
    previous = line;
  }
  return repaired.join('\n');
}
