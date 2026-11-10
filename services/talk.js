async function recordTalk(page, index, week, opts = {}) {
  if (!opts.studentId || !opts.recordedAt)
    return { result: "error", reason: "请先按学号和实际时间生成录入预览" };
  const result = await require("./recordDriver").saveOperation(page, {
    studentId: opts.studentId,
    week,
    type: "talk",
    payload: opts,
  });
  return {
    ...result,
    result:
      result.status === "succeeded"
        ? "success"
        : result.status === "skipped"
          ? "skipped"
          : "error",
  };
}
module.exports = { recordTalk };
