const assert = require("node:assert/strict");
const pool = require("../services/browser");
(async () => {
  const held = [];
  try {
    const alice = await pool.acquireContext();
    held.push(alice.slot);
    await alice.page
      .context()
      .addCookies([
        {
          name: "session_probe",
          value: "alice",
          domain: "example.invalid",
          path: "/",
        },
      ]);
    await pool.releaseContext(alice.slot);
    const bob = await pool.acquireContext();
    held.push(bob.slot);
    assert.equal((await bob.page.context().cookies()).length, 0);
    assert.notEqual(alice.slot.context, bob.slot.context);
    await pool.releaseContext(bob.slot);
    const concurrent = await Promise.all([
      pool.acquireContext(),
      pool.acquireContext(),
      pool.acquireContext(),
    ]);
    held.push(...concurrent.map((s) => s.slot));
    assert.equal(new Set(concurrent.map((s) => s.slot.context)).size, 3);
    for (const { page } of concurrent)
      await page.setContent("<p>isolated session</p>");
    console.log(
      "REAL_CHROMIUM_ISOLATION_PASS: sequential reuse and three concurrent sessions",
    );
  } finally {
    await Promise.all(held.map((slot) => pool.releaseContext(slot)));
    await pool.shutdown();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
