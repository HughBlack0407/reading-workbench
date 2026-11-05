// Shared hidden passphrase reader. The value is never printed, logged, or persisted.
import readline from 'node:readline';

export function readPassphrase(prompt = 'Passphrase: ') {
  return new Promise((resolve) => {
    if (process.env.VAULT_PASSPHRASE) { resolve(process.env.VAULT_PASSPHRASE); return; }
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      let line = '';
      rl.on('line', (l) => { line = l; rl.close(); });
      rl.on('close', () => resolve(line.trim()));
      return;
    }
    let value = '';
    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const finish = () => { cleanup(); process.stdout.write('\n'); resolve(value); };
    const onData = (chunk) => {
      const s = chunk.toString('utf8');
      if (s === '\r' || s === '\n' || s === '\u0004') return finish();
      if (s === '\u0003') { cleanup(); process.stdout.write('\n'); process.exit(130); }
      if (s === '\u007f' || s === '\b') { value = value.slice(0, -1); return; }
      value += s;
    };
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
