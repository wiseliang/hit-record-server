const { AppError } = require("../utils/errors");
const SCENES = [
  ["99", "其他"],
  ["1", "走访寝室"],
  ["2", "走访自习室"],
  ["3", "走访课堂"],
  ["4", "走访班级"],
  ["5", "走访团党支部"],
  ["6", "走访实验室"],
  ["7", "陪伴运动"],
  ["8", "陪伴进餐"],
  ["9", "陪伴自习"],
  ["10", "陪伴上课"],
].map(([value, label]) => ({ value, label }));
const COMPANIONS = [
  ["1", "共同进餐"],
  ["2", "共上自习"],
  ["3", "共同运动"],
  ["4", "共同上课"],
].map(([value, label]) => ({ value, label }));
const VERSION = 2;
function normalize(row) {
  const number = (key) => {
    const v = row[key];
    if (
      v === null ||
      v === undefined ||
      v === "" ||
      !Number.isInteger(Number(v)) ||
      Number(v) < 0 ||
      Number(v) > 100000
    )
      throw new AppError(
        502,
        "ACADEMIC_RULES_UNKNOWN",
        "学校次数或轮次要求读取不完整，不能按每人一次处理",
      );
    return Number(v);
  };
  const required = number("pc"),
    completed = number("gzcs"),
    talk = number("gzlcth"),
    visit = number("gzlczf"),
    companion = number("gzlcpb");
  return {
    version: VERSION,
    required,
    completed,
    countExempt: String(row.sfjjxs) === "1",
    remaining:
      String(row.sfjjxs) === "1" ? 0 : Math.max(0, required - completed),
    round: { talk, visit, companion },
    roundMissing: ["talk", "visit", "companion"].filter(
      (k) => ({ talk, visit, companion })[k] === 0,
    ),
    schoolCycle: row.lc ?? null,
    schoolCycleSpan: row.lczs ?? null,
  };
}
function sceneKind(scene) {
  const value = SCENES.find((s) => s.label === scene)?.value;
  return ["1", "2", "3", "4", "5", "6"].includes(value)
    ? "visit"
    : ["7", "8", "9", "10"].includes(value)
      ? "companion"
      : null;
}
function validateOptions(options) {
  if (
    !SCENES.some((s) => s.label === options.scene) ||
    !COMPANIONS.some((s) => s.label === options.pbType)
  )
    throw new AppError(
      400,
      "INVALID_FORM_OPTION",
      "请选择学校列表中的谈话场景和陪伴类型",
    );
}
function goals(requirements, entry, week, options) {
  const r = requirements;
  if (!r || r.version !== VERSION)
    throw new AppError(
      409,
      "ACADEMIC_RULES_UNKNOWN",
      "请重新读取学校次数和轮次要求",
    );
  validateOptions(options);
  const ops = [],
    covered = new Set(),
    allowed = entry === "automatic" ? ["talk", "companion"] : [entry];
  const add = (type, purpose, scene = options.scene) => {
    const extra = type === "talk" ? sceneKind(scene) : null;
    ops.push({ type, purpose, scene, credits: 1 + (extra ? 1 : 0) });
    covered.add(type);
    if (extra) covered.add(extra);
  };
  if (r.roundMissing.includes("visit") && allowed.includes("talk"))
    add(
      "talk",
      "visit",
      sceneKind(options.scene) === "visit" ? options.scene : "走访寝室",
    );
  if (
    r.roundMissing.includes("talk") &&
    !covered.has("talk") &&
    allowed.includes("talk")
  )
    add("talk", "talk");
  if (
    r.roundMissing.includes("companion") &&
    !covered.has("companion") &&
    allowed.includes("companion")
  )
    add("companion", "companion");
  let remaining = r.remaining - ops.reduce((n, o) => n + o.credits, 0),
    preferred =
      entry === "automatic" ? (week % 2 ? "companion" : "talk") : entry;
  while (remaining > 0) {
    add(preferred, "count");
    remaining -= ops.at(-1).credits;
    if (ops.length > 1500)
      throw new AppError(
        400,
        "TOO_MANY_OPERATIONS",
        "学校要求超过单批上限，请缩小周次和人数",
      );
  }
  return {
    operations: ops,
    unhandled: r.roundMissing.filter((k) => !covered.has(k)),
  };
}
function needed(r, purpose) {
  if (!r || r.version !== VERSION)
    throw new AppError(
      409,
      "ACADEMIC_RULES_UNKNOWN",
      "学校要求未核实，请重新读取",
    );
  return (
    r.remaining > 0 || (purpose !== "count" && r.roundMissing.includes(purpose))
  );
}
module.exports = {
  VERSION,
  SCENES,
  COMPANIONS,
  normalize,
  goals,
  needed,
  sceneKind,
  validateOptions,
};
