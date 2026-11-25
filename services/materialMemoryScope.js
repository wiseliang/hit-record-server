const { decrypt } = require('../utils/crypto');

function getImportScopes(records, people) {
  const allowed = new Set(people.map(person => person.studentId));
  return records.map(row => {
    const payload = JSON.parse(decrypt(row.payload_encrypted));
    // Old automatic imports applied the entire proposed mapping in one transaction.
    const proposed = payload.suggestedMapping;
    const legacyAutomatic = payload.autoApply === true && Array.isArray(proposed)
      && payload.report?.imported != null && payload.report.imported === proposed.length;
    const ids = payload.importedStudentIds ?? (legacyAutomatic ? proposed.map(entry => entry.studentId) : null);
    return {
      id: row.id,
      filename: payload.filename || '导入的 PPT',
      ...(payload.studyBank?{studyBank:true}:{}),
      importedAt: row.updated_at,
      studentIds: ids === null ? null : [...new Set(ids.filter(id => allowed.has(id)))],
    };
  });
}

function getStudyAttributes(people, includePersonal) {
  const result = Object.create(null);
  const absent = /^(?:无(?:特殊情况|异常|相关情况)?|否|正常|不适用|暂无|待补充|未填写|[—-]+)[。.!！]?$/u;
  for (const person of people) {
    const attributes = {};
    const fields = includePersonal ? ['committee', 'political', 'focus', 'situation', 'other'] : ['committee'];
    for (const key of fields) {
      const field = person.fields?.[key];
      if (!field?.confirmed || !field.value) continue;
      const values = field.value.split(/[、，,；;\n]+/u).map(value => value.trim()).filter(Boolean);
      const present = values.filter(value => !absent.test(value));
      if (present.length) attributes[key] = key === 'other' ? ['有其他情况'] : [...new Set(present)];
    }
    if (Object.keys(attributes).length) result[person.studentId] = attributes;
  }
  return result;
}

module.exports = { getImportScopes, getStudyAttributes };
