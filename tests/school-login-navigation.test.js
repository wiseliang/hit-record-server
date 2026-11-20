const test = require('node:test')
const assert = require('node:assert/strict')
const { readAfterAuthSubmit } = require('../services/login')

test('reads the new school document after navigation destroys the context', async () => {
  const login = 'https://ids.hit.edu.cn/authserver/login'
  const mfa = 'https://ids.hit.edu.cn/authserver/reAuth'
  let reads = 0
  const page = {
    url: () => mfa,
    async evaluate() {
      reads++
      if (reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation')
      if (reads === 2) return { url: login, hasCodeField: false }
      return { url: mfa, hasCodeField: true, captchaVisible: false }
    }
  }
  assert.equal((await readAfterAuthSubmit(page)).hasCodeField, true)
  assert.equal(reads, 3)
})

test('unrelated browser errors are surfaced without retrying', async () => {
  let reads = 0
  const page = { async evaluate() { reads++; throw new Error('Target page has been closed') } }
  await assert.rejects(readAfterAuthSubmit(page), /Target page has been closed/)
  assert.equal(reads, 1)
})
