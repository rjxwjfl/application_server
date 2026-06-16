const express = require('express');
const router = express.Router();
const specialDayController = require('../api/specialDays/specialDayController');

// 공휴일 목록 (/:id 보다 앞에 등록)
router.get('/holidays', specialDayController.getHolidays);

router.post('/', specialDayController.create);
router.get('/:id', specialDayController.getById);
router.patch('/:id', specialDayController.update);
router.delete('/:id', specialDayController.delete);

module.exports = router;
