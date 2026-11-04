// Usage: npm run hash-password -- organizer@example.org
// Reads the password from a hidden prompt so it stays out of shell history.
import { createInterface } from 'node:readline/promises';
import { hashPassword } from '../src/auth.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run hash-password -- organizer@example.org');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const prompt = 'Password: ';
const question = rl.question(prompt);
rl._writeToOutput = () => {};
const password = await question;
rl.close();
console.log(`\n${email.toLowerCase()}=${await hashPassword(password)}`);
