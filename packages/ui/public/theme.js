// Before the first paint, so a stored theme does not flash the system one.
try {
  document.documentElement.dataset.theme = localStorage.getItem('chat-explorer.theme') ?? '';
} catch {}
