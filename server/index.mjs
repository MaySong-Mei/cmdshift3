import { createApp } from './app.mjs';
import { queueCommittedEvent } from './lib/keewano.mjs';

const port = Number(process.env.PORT ?? process.env.CMD3_PORT ?? 4317);
const publicMode = process.env.CMD3_MODE === 'public';
const host = process.env.CMD3_HOST ?? (publicMode ? '0.0.0.0' : '127.0.0.1');
const app = await createApp({ onCommit: queueCommittedEvent });
await app.listen(port, host);
console.log(`CmdShift3 running at http://${host}:${port}`);
console.log(publicMode ? 'Public registration uses independent accounts and private projects.' : 'Demo login codes: may-demo / gary-demo. Data is persisted separately from source.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
