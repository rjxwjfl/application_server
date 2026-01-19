/**
 * src/routes/index.js
 * =========================================
 * 전체 라우트를 중앙 집중식으로 관리
 * 
 * 역할:
 * - 모든 라우트 등록
 * - 라우트별 미들웨어 적용
 * - 라우트 보호 로직 일원화
 * =========================================
 */

const express = require('express');
const router = express.Router();

// 미들웨어
const { firebaseAuth } = require('../utils/authMiddleware');

// 라우트 임포트
const userRoutes = require('./userRoutes');
const drawerRoutes = require('./drawerRoutes');

/**
 * Public 라우트 (인증 없음)
 */
router.use('/users/public', userRoutes.public);

/**
 * Protected 라우트 (인증 필요)
 * firebaseAuth 미들웨어 적용
 */
router.use('/users', firebaseAuth, userRoutes.protected);
router.use('/drawers', firebaseAuth, drawerRoutes);

module.exports = router;
