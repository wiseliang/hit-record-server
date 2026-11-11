const crypto = require("crypto"),
  pool = require("../config/database"),
  rules = require("./academicRequirements");
const version = (data) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify(
        [data.scenes, data.companionTypes].map((list) =>
          list
            .map((o) => [String(o.value), String(o.label)])
            .sort((a, b) => a[0].localeCompare(b[0])),
        ),
      ),
    )
    .digest("hex")
    .slice(0, 16);
async function capture(openid, session) {
  if (!session?.page?.evaluate || !session.connectionId) return null;
  const lists = await session.page
    .evaluate(() => {
      const get = (id) => {
        const w = window.$?.("#" + id)?.data("kendoDropDownList");
        if (!w) return null;
        const t = w.options.dataTextField,
          v = w.options.dataValueField;
        return Array.from(w.dataSource.data())
          .filter((r) => r[t] !== undefined && r[v] !== undefined)
          .map((r) => ({ label: String(r[t]), value: String(r[v]) }))
          .filter((r) => r.label && r.value);
      };
      return { scenes: get("xsth_thcj"), companionTypes: get("pbjl_pblx") };
    })
    .catch(() => null);
  if (!lists) return null;
  const [rows] = await pool.query(
    "SELECT payload FROM school_form_options WHERE openid=? AND connection_id=?",
    [openid, session.connectionId],
  );
  const saved = rows[0]
    ? require("../models/tasksV12").parse(rows[0].payload)
    : {};
  const data = {
    scenes: lists.scenes || saved.scenes || rules.SCENES,
    companionTypes:
      lists.companionTypes || saved.companionTypes || rules.COMPANIONS,
  };
  if (!data.scenes?.length || !data.companionTypes?.length) return null;
  if (
    [...data.scenes, ...data.companionTypes].some(
      (r) => r.label.length > 80 || r.value.length > 40,
    )
  )
    return null;
  data.version = version(data);
  data.checkedAt = new Date().toISOString();
  data.source =
    lists.scenes && lists.companionTypes
      ? "school_live_controls"
      : "school_controls_with_snapshot";
  await pool.query(
    "INSERT INTO school_form_options(openid,connection_id,payload) VALUES (?,?,?) ON DUPLICATE KEY UPDATE connection_id=VALUES(connection_id),payload=VALUES(payload)",
    [openid, session.connectionId, JSON.stringify(data)],
  );
  return data;
}
async function get(openid, session) {
  if (session) {
    const live = await capture(openid, session);
    if (live) return live;
  }
  const [rows] = await pool.query(
    "SELECT payload FROM school_form_options WHERE openid=? AND connection_id=(SELECT connection_id FROM school_login_sessions WHERE openid=?)",
    [openid, openid],
  );
  if (rows[0]) {
    const saved = require("../models/tasksV12").parse(rows[0].payload);
    return { ...saved, version: version(saved) };
  }
  const data = {
    scenes: rules.SCENES,
    companionTypes: rules.COMPANIONS,
    source: "bundled_verified_snapshot",
    checkedAt: null,
  };
  return { ...data, version: version(data) };
}
module.exports = { get, capture, version };
