const crypto = require("crypto");
const pool = require("../config/database");
const { AppError } = require("../utils/errors");
const DEFAULTS = [
  [
    "学习情况",
    "了解近期课程学习进展、学习方法及遇到的困难，交流后续学习安排。",
    "talk",
  ],
  [
    "室友相处",
    "了解与室友的日常相处、沟通及作息协调情况，交流需要支持的事项。",
    "talk",
  ],
  [
    "职业规划",
    "了解职业兴趣、升学或就业意向，讨论现阶段准备方向与后续计划。",
    "talk",
  ],
  [
    "实验室参与",
    "了解是否参加实验室、科研训练或项目实践，交流参与意愿、学习收获及困难。",
    "talk",
  ],
  [
    "生活适应",
    "了解近期校园生活与适应情况，交流时间管理、生活安排及需要帮助的问题。",
    "both",
  ],
  [
    "学习与生活交流",
    "围绕近期学习与校园生活开展交流，了解近况及需要支持的事项。",
    "both",
  ],
  [
    "陪伴活动交流",
    "在陪伴活动中交流近期学习生活情况，关注学生表达的需求并讨论后续安排。",
    "companion",
  ],
].map(([title, content, scope], i) => ({
  id: "default-" + i,
  title,
  content,
  scope,
  enabled: true,
}));
function validateItem(item) {
  if (
    !item ||
    typeof item.title !== "string" ||
    !item.title.trim() ||
    item.title.trim().length > 40 ||
    typeof item.content !== "string" ||
    !item.content.trim() ||
    item.content.trim().length > 250 ||
    !["talk", "companion", "both"].includes(item.scope) ||
    typeof item.enabled !== "boolean"
  )
    throw new AppError(
      400,
      "INVALID_TEMPLATE",
      "模板标题为1–40字，内容为1–250字，请选择适用类型",
    );
  return {
    title: item.title.trim(),
    content: item.content.trim(),
    scope: item.scope,
    enabled: item.enabled,
  };
}
async function get(openid, db = pool) {
  await db.query(
    "INSERT IGNORE INTO content_template_libraries(openid,revision,payload) VALUES (?,1,?)",
    [openid, JSON.stringify(DEFAULTS)],
  );
  const [rows] = await db.query(
    "SELECT revision,payload FROM content_template_libraries WHERE openid=?",
    [openid],
  );
  const row = rows[0];
  return {
    revision: Number(row.revision),
    items: require("../models/tasksV12").parse(row.payload),
  };
}
async function change(openid, body) {
  if (
    !body ||
    !["create", "update", "delete"].includes(body.action) ||
    !Number.isSafeInteger(body.revision)
  )
    throw new AppError(400, "INVALID_TEMPLATE_CHANGE", "模板修改请求无效");
  await get(openid);
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    const [rows] = await c.query(
      "SELECT revision,payload FROM content_template_libraries WHERE openid=? FOR UPDATE",
      [openid],
    );
    const row = rows[0],
      items = require("../models/tasksV12").parse(row.payload);
    if (Number(row.revision) !== body.revision)
      throw new AppError(
        409,
        "TEMPLATES_CHANGED",
        "模板库已在其他页面修改，请刷新后重试",
      );
    if (body.action === "create") {
      if (items.length >= 100)
        throw new AppError(
          400,
          "TOO_MANY_TEMPLATES",
          "模板库最多100条，请先删除不用的模板",
        );
      items.push({ id: crypto.randomUUID(), ...validateItem(body.item) });
    } else {
      const index = items.findIndex((t) => t.id === body.id);
      if (index < 0)
        throw new AppError(404, "TEMPLATE_NOT_FOUND", "模板不存在");
      if (body.action === "delete") items.splice(index, 1);
      else items[index] = { id: body.id, ...validateItem(body.item) };
    }
    const revision = Number(row.revision) + 1;
    await c.query(
      "UPDATE content_template_libraries SET revision=?,payload=? WHERE openid=?",
      [revision, JSON.stringify(items), openid],
    );
    await c.commit();
    return { revision, items };
  } catch (e) {
    await c.rollback();
    throw e;
  } finally {
    c.release();
  }
}
async function prepare(openid, request, entry) {
  if (request.contentMode !== "random") return request;
  const library = await get(openid);
  const types =
    entry === "automatic"
      ? ["talk", "companion"]
      : [entry === "companion" ? "companion" : "talk"];
  const items = library.items.filter(
    (t) => t.enabled && (t.scope === "both" || types.includes(t.scope)),
  );
  if (
    types.some(
      (type) => !items.some((t) => t.scope === "both" || t.scope === type),
    )
  )
    throw new AppError(
      400,
      "NO_CONTENT_TEMPLATES",
      "没有适用的启用模板，请先维护模板库或改为手动填写",
    );
  return {
    ...request,
    contentTemplates: items,
    templateRevision: library.revision,
  };
}
function resolve(request, type, randomInt = crypto.randomInt) {
  if (request.contentMode !== "random")
    return { content: request.content || "" };
  const items = (request.contentTemplates || []).filter(
    (t) =>
      t.enabled &&
      (t.scope === "both" ||
        t.scope === (type === "companion" ? "companion" : "talk")),
  );
  if (!items.length)
    throw new AppError(
      400,
      "NO_CONTENT_TEMPLATES",
      "没有适用的启用模板，请维护模板库",
    );
  const t = items[randomInt(items.length)];
  return {
    content: t.content,
    contentTemplateId: t.id,
    contentTemplateTitle: t.title,
  };
}
module.exports = { DEFAULTS, get, change, prepare, resolve, validateItem };
