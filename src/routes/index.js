const express = require('express');
const router = express.Router();

const { firebaseAuth, firebaseAuthLight } = require('../middleware/authMiddleware');

const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const drawerRoutes = require('./drawerRoutes');
const eventRoutes = require('./eventRoutes');
const taskRoutes = require('./taskRoutes');
const seriesRoutes = require('./seriesRoutes');
const syncRoutes = require('./syncRoutes');
const billingRoutes = require('./billingRoutes');
const webhookRoutes = require('./webhookRoutes');
const calendarRoutes = require('./calendarRoutes');
const specialDayRoutes = require('./specialDayRoutes');
const notificationRoutes = require('./notificationRoutes');
const castRoutes = require('./castRoutes');
const castCommentRoutes = require('./castCommentRoutes');
const postCommentRoutes = require('./postCommentRoutes');
const postRoutes = require('./postRoutes');
const mediaRoutes = require('./mediaRoutes');
const attachmentRoutes = require('./attachmentRoutes');

// 웹훅: Firebase Auth 밖에 마운트 (외부 서비스가 고정 URL 사용 — 버전 비적용)
router.use('/webhooks', webhookRoutes);

// auth 라우트: Firebase 토큰 검증만 수행 (신규 가입자도 접근 가능)
// getMe → null 반환으로 신규 유저 감지, register → db_user_id 클레임 발급
const authRouter = express.Router();
authRouter.use(firebaseAuthLight);
authRouter.use('/auth', authRoutes);
router.use(authRouter);

// 나머지 모든 라우트: db_user_id custom claim 필수
const protectedRouter = express.Router();
protectedRouter.use(firebaseAuth);

protectedRouter.use('/users', userRoutes);
protectedRouter.use('/drawers', drawerRoutes);
protectedRouter.use('/events', eventRoutes);
protectedRouter.use('/tasks', taskRoutes);
protectedRouter.use('/series', seriesRoutes);
protectedRouter.use('/sync', syncRoutes);
protectedRouter.use('/billing', billingRoutes);
protectedRouter.use('/calendar', calendarRoutes);
protectedRouter.use('/calendars', calendarRoutes);
protectedRouter.use('/special-days', specialDayRoutes);
protectedRouter.use('/notifications', notificationRoutes);
protectedRouter.use('/casts', castRoutes);
protectedRouter.use('/cast-comments', castCommentRoutes);
protectedRouter.use('/post-comments', postCommentRoutes);
protectedRouter.use('/posts', postRoutes);
protectedRouter.use('/media', mediaRoutes);
protectedRouter.use('/attachments', attachmentRoutes);

router.use(protectedRouter);

module.exports = router;
