const { test } = require('node:test');
const assert = require('node:assert/strict');
const { suggestMatches } = require('../services/materialMatches');

test('all pages are proposed together while different classes, duplicate names and duplicate rows require review', () => {
  const people = Array.from({ length: 14 }, (_, index) => ({
    studentId: 's' + index, name: '合成' + index, className: '自动化01班',
  }));
  people.push({ studentId: 'ambiguous', name: people[1].name, className: people[1].className });
  const rows = people.slice(0, 14).map((person, index) => ({ ...person, index }));
  rows[0].className = ' 自动化０１ 班 ';
  rows[2].className = '其他班';
  rows.push({ ...rows[3], index: 14 });
  const result = suggestMatches(rows, people);
  assert.deepEqual(result.map(match => match.index), [0,4,5,6,7,8,9,10,11,12,13]);
  assert.equal(result.at(-1).studentId, 's13');
});
