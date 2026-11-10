const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  { mapRead } = require("../utils/readLimit"),
  school = require("../services/worklogSchool"),
  driver = require("../services/worklogDriver");
test("bounded reads keep result order, cap concurrency and drain in-flight failures", async () => {
  let live = 0,
    max = 0,
    finished = 0;
  const results = await mapRead([3, 1, 2], async (n) => {
    live++;
    max = Math.max(max, live);
    await new Promise((r) => setTimeout(r, n * 4));
    live--;
    return n * 2;
  });
  assert.deepEqual(results, [6, 2, 4]);
  assert.equal(max, 2);
  await assert.rejects(
    () =>
      mapRead([0, 1, 2, 3], async (n) => {
        if (n === 0) {
          await new Promise((r) => setTimeout(r, 1));
          throw Error("read failure");
        }
        await new Promise((r) => setTimeout(r, 15));
        finished++;
      }),
    /read failure/,
  );
  assert.equal(finished, 1);
});
test("completed read freshness is independent of business-time snapshot timestamp", () => {
  const state = {
    checkedAt: new Date(Date.now() - 120000).toISOString(),
    readCompletedAt: new Date().toISOString(),
  };
  assert(driver.snapshotAge(state) < 1000);
  assert(driver.snapshotAge({ checkedAt: state.checkedAt }) > 60000);
});
