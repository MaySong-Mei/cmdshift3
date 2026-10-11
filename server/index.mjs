import { createApp } from './app.mjs';
import { queueCommittedEvent } from './lib/keewano.mjs';

const port = Number(process.env.PORT ?? process.env.CMD3_PORT ?? 4317);
const host = process.env.CMD3_HOST ?? '127.0.0.1';
const app = await createApp({ onCommit: queueCommittedEvent });
await app.listen(port, host);
console.log(`CmdShift3 demo running at http://${host}:${port}`);
console.log('Demo login codes: may-demo / gary-demo. Data is persisted separately from source.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
