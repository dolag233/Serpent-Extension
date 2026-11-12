export default {
  alarms: { async create() {}, async clear() {} },
  storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
};
