const crypto = require("crypto"),
  { AppError } = require("../utils/errors");
const METHODS = Object.freeze(["面对面", "电话", "网络"]);
const OPTIONS = Object.freeze([...METHODS, "随机"]);
function validate(value, { allowRandom = false } = {}) {
  if (!(allowRandom ? OPTIONS : METHODS).includes(value))
    throw new AppError(
      400,
      "INVALID_TALK_METHOD",
      "请选择面对面、电话、网络" + (allowRandom ? "或随机" : ""),
    );
  return value;
}
function resolve(value, randomInt = crypto.randomInt) {
  validate(value, { allowRandom: true });
  return value === "随机" ? METHODS[randomInt(METHODS.length)] : value;
}
module.exports = { METHODS, OPTIONS, validate, resolve };
