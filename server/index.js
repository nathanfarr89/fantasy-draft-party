const { startServer } = require('./gameServer');

const port = parseInt(process.env.PORT) || 3000;

startServer(port)
  .then(() => console.log(`Fantasy Draft Party server running on port ${port}`))
  .catch(err => { console.error('Failed to start server:', err); process.exit(1); });
