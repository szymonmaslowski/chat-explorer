// A date and a time in the reader's own format, e.g. "29 Oct 2026, 15:24".
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const formatDateTime = (timestamp: number) => dateTimeFormat.format(timestamp);
