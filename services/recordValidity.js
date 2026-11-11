const schedule = require("./worklogSchedule");
function inspect(record, now = Date.now()) {
  const time = schedule.stamp(record.thsj || record.recordedAt || record.cysj);
  const talk = !!record.thsj || record.type === "talk";
  const duration = Number(record.thsc ?? record.duration);
  const invalid =
    !Number.isFinite(time) ||
    (talk && (!Number.isFinite(duration) || duration <= 0 || duration > 1440));
  const future = !invalid && time + (talk ? duration * schedule.MIN : 0) > now;
  return {
    valid: !invalid && !future,
    invalid,
    future,
    time,
    reason: invalid
      ? "学校记录时间或时长无效，请先核实"
      : future
        ? "学校有未来时间记录，请先核实"
        : null,
  };
}
module.exports = { inspect };
