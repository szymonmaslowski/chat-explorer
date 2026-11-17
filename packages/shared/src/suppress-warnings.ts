// Must be imported before anything that loads `node:sqlite`, which emits an ExperimentalWarning.
const isSqliteWarning = (warning: Error) =>
  warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite');

process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (!isSqliteWarning(warning)) console.warn(warning);
});
