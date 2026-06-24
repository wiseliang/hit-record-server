const express = require('express')
const router = express.Router()
const { getHistory } = require('../models/history')

router.get('/', async (req, res, next) => {
  try {
    const openid = req.query.openid || req.headers['x-openid']
    if (!openid) {
      return res.status(400).json({ error: '缺少openid' })
    }
    const page = parseInt(req.query.page) || 1
    const pageSize = Math.min(parseInt(req.query.pageSize) || 20, 100)

    const result = await getHistory(openid, page, pageSize)
    res.json(result)
  } catch (e) {
    next(e)
  }
})

module.exports = router
