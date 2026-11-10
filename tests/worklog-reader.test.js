const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  school = require("../services/worklogSchool");
test("school pagination loads every page rather than treating the first 50 rows as complete roster", async () => {
  const all = Array.from({ length: 1201 }, (_, i) => ({
      xh: String(2025000000 + i),
      thcs: String(i % 4),
    })),
    calls = [],
    page = {
      request: {
        post: async (url, options) => {
          const p = JSON.parse(options.form.info);
          calls.push(p);
          return {
            ok: () => true,
            json: async () => ({
              isSuccess: true,
              module: {
                data: all.slice(p.skip, p.skip + p.take),
                total: all.length,
              },
            }),
          };
        },
      },
    };
  const rows = await school.pages(page, "xg_fdygzrz/rzgl/getXsmdList", {
    xmxh: "",
    bs: "",
  });
  assert.equal(rows.length, 1201);
  assert.deepEqual(
    calls.map((p) => p.skip),
    [0, 500, 1000],
  );
  assert.equal(rows.at(-1).xh, all.at(-1).xh);
});
test("missing pages, invalid counters and expired school HTML are never treated as zero records", async () => {
  for (const body of [
    { isSuccess: true, module: { data: [], total: 2 } },
    { isSuccess: true, module: { data: [], total: "bad" } },
  ])
    await assert.rejects(
      school.pages(
        {
          request: {
            post: async () => ({ ok: () => true, json: async () => body }),
          },
        },
        "xg_fdygzrz/rzgl/getXsmdList",
      ),
      (e) => e.code === "SCHOOL_DATA_INVALID",
    );
  await assert.rejects(
    school.json(
      {
        request: {
          post: async () => ({
            ok: () => true,
            json: async () => {
              throw Error("HTML");
            },
          }),
        },
      },
      "xg_fdygzrz/rzgl/getXsList",
    ),
    (e) => e.code === "SCHOOL_AUTH_REQUIRED",
  );
});
