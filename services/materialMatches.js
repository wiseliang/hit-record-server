function normalize(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF]/gu, '');
}
function identityKey(person) {
  const name = normalize(person.name);
  const className = normalize(person.className);
  return name && className ? JSON.stringify([name, className]) : null;
}

function suggestMatches(rows, people) {
  const byIdentity = new Map();
  for (const person of people) {
    const key = identityKey(person);
    if (!key) continue;
    byIdentity.set(key, byIdentity.has(key) ? null : person.studentId);
  }
  const matches = rows.map(row => ({
    index: row.index,
    studentId: byIdentity.get(identityKey(row)) || null,
  }));
  const counts = new Map();
  for (const match of matches) {
    if (match.studentId) counts.set(match.studentId, (counts.get(match.studentId) || 0) + 1);
  }
  return matches.filter(match => match.studentId && counts.get(match.studentId) === 1);
}

module.exports = { suggestMatches };
