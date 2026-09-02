import express from 'express';
import path from 'node:path';
import { router as api } from './routes/api.js';
import { ROOT, PORT, hasApiKey, MODEL } from './config.js';
import { loadData } from './data.js';

const app = express();

app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/api', api);

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
});

export function start(port = PORT) {
  loadData({ reload: true });
  return app.listen(port, () => {
    console.log(`SOW builder listening on http://localhost:${port}`);
    console.log(`  Anthropic API: ${hasApiKey() ? `available (${MODEL})` : 'NOT configured - stages 0-3 and Word generation still work'}`);
  });
}

export { app };

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  start();
}
