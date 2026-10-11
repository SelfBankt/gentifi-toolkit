import { ERRORS, RpcError, errorResponse } from './protocol.js';

/**
 * Newline-delimited JSON-RPC over stdin and stdout. Messages are handled one at
 * a time, so responses come back in request order. Nothing else is written to
 * stdout; diagnostics go to stderr.
 */
export function serveStdio(protocol, { input = process.stdin, output = process.stdout } = {}) {
  let buffer = '';
  let queue = Promise.resolve();
  const write = (message) => output.write(JSON.stringify(message) + '\n');

  const handleLine = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(errorResponse(null, new RpcError(ERRORS.parse, 'Parse error')));
      return;
    }
    const { response } = await protocol.handle(message);
    if (response) write(response);
  };

  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) queue = queue.then(() => handleLine(line));
    }
  });

  return new Promise((resolve) => {
    input.on('end', () => {
      if (buffer.trim()) queue = queue.then(() => handleLine(buffer.trim()));
      queue.then(resolve);
    });
  });
}
