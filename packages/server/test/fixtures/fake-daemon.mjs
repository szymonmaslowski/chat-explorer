import { createServer } from 'node:http';

const port = Number(process.env.CHAT_EXPLORER_PORT);
const health = {
  name: 'chat-explorer',
  version: process.env.FAKE_DAEMON_VERSION,
  apiVersion: Number(process.env.FAKE_DAEMON_API_VERSION ?? 1),
  pid: process.pid,
};

const server = createServer((request, response) => {
  if (request.url === '/api/shutdown') {
    response.end('{"ok":true}', () => process.exit(0));
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(health));
});
server.on('error', () => process.exit(3));
server.listen(port, '127.0.0.1');
