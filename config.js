// Set SERVER_URL to your deployed Fly.io URL after running `flyctl deploy`.
// Leave as localhost for local development — main.js will auto-start a local server.
module.exports = {
  SERVER_URL: process.env.SERVER_URL || 'https://fantasy-draft-party.fly.dev',
};
