// Imported first by the CLI: Node 22-24 print "SQLite is an experimental feature" on every run, which is noise
// in a human's terminal and in `sy up` logs. Every other warning is still printed.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/.test(w.message)) return;
  process.stderr.write(`(node:${process.pid}) ${w.name}: ${w.message}\n`);
});
