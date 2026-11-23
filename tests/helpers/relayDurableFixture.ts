// Creates a paired durable relay database fixture for store behavior tests.
import { createRequire } from 'node:module';
import { migrate } from '../../relay/src/schema.mjs';
const require = createRequire(import.meta.url);
const { migrateDurable, DurableStore } = require('../../relay/src/durableStore.mjs');

export async function pairedDurableStore(db: any) {
  await migrate(db);
  await migrateDurable(db);
  await db.query(
    "INSERT INTO relay_pairs (pair_id,user_id,mac_device_id,phone_device_id,join_deadline,created_at) VALUES ('p_test0001','u','mac','phone',now(),now())",
  );
  return new DurableStore((fn: any) => db.transaction(fn));
}
