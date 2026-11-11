const { AppError } = require("../utils/errors");
async function collect(fetchPage, { maxPages = 30, pageSize = 500 } = {}) {
  const rows = [],
    seen = new Set();
  let expected = null;
  for (let page = 1; page <= maxPages; page++) {
    const raw = await fetchPage({
      page,
      pageSize,
      take: pageSize,
      skip: rows.length,
    });
    const list = Array.isArray(raw) ? raw : raw?.data;
    if (!Array.isArray(list))
      throw new AppError(
        502,
        "SCHOOL_DATA_INVALID",
        "学校分页数据无效，未按空记录处理",
      );
    const value = Array.isArray(raw) ? null : raw.total;
    if (value !== undefined && value !== null && value !== "") {
      const total = Number(value);
      if (
        !Number.isInteger(total) ||
        total < 0 ||
        total > 15000 ||
        (expected !== null && total !== expected)
      )
        throw new AppError(
          409,
          "SCHOOL_DATA_CHANGED",
          "学校分页总数变化，请重新读取",
        );
      expected = total;
    }
    for (const r of list) {
      const id = String(r.id || "");
      if (!id || seen.has(id))
        throw new AppError(
          502,
          "SCHOOL_DATA_INVALID",
          "学校分页记录标识缺失或重复，读取未完成",
        );
      seen.add(id);
      rows.push(r);
    }
    if (expected !== null) {
      if (rows.length > expected || (!list.length && rows.length < expected))
        throw new AppError(
          502,
          "SCHOOL_DATA_INVALID",
          "学校分页缺失，不能可靠核对",
        );
      if (rows.length === expected) return rows;
    } else if (list.length < pageSize) return rows;
  }
  throw new AppError(
    502,
    "SCHOOL_DATA_INVALID",
    "学校分页达到读取上限，未使用截断结果",
  );
}
module.exports = { collect };
