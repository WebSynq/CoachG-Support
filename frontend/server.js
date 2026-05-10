// Preview-only static server for /app/public/index.html
// Kubernetes ingress routes /api/* -> backend:8001 directly, so this server
// only needs to serve the static portal HTML on port 3000.
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[coachg-preview] serving ${PUBLIC_DIR} on http://0.0.0.0:${PORT}`);
});
