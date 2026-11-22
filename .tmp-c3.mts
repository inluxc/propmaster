import cassandra from 'cassandra-driver';
const d = new cassandra.Client({ contactPoints: ['localhost:9042'], localDataCenter: 'dc9' });
await d.connect().catch((e) => console.log('connect failed', e.message.slice(0, 80)));
await d.shutdown();
setTimeout(() => { console.log((process as any)._getActiveHandles().map((h: any) => `${h.constructor.name} ${h.remoteAddress ?? ''}:${h.remotePort ?? ''} destroyed=${h.destroyed}`)); console.log((process as any)._getActiveRequests().length); }, 1000).unref();
