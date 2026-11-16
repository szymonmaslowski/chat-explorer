// After this many tool calls without a line from the terminal session about what it is doing,
// the hook reminds it to write one, so the user following the steps knows where it is.
export const callsBeforeReminder = 5;

export class ProgressLines {
  private readonly calls = new Map<string, number>();

  // Counts one hook call of the session; true when it is time for a reminder.
  count(shimId: string, wroteText: boolean, calledTool: boolean) {
    const calls = (wroteText ? 0 : (this.calls.get(shimId) ?? 0)) + (calledTool ? 1 : 0);
    const remind = calls >= callsBeforeReminder;
    this.calls.set(shimId, remind ? 0 : calls);
    return remind;
  }
}
