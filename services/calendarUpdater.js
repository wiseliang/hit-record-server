const { AppError } = require("../utils/errors");
async function updateCalendarIfNeeded() {
  throw new AppError(
    410,
    "USE_SCHOOL_CALENDAR",
    "请登录学校后同步实时学期；旧 PDF 写入入口已停用",
  );
}
module.exports = { updateCalendarIfNeeded };
