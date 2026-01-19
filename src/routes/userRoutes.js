/**
 * src/routes/userRoutes.js
 * =========================================
 * 사용자 관련 라우트 정의
 * 
 * 라우트는 다음과 같이 분리됨:
 * - public: 인증 없이 접근 가능
 * - protected: 인증 필요 (index.js에서 firebaseAuth 미들웨어 적용)
 * =========================================
 */

const express = require('express');
const userController = require('../api/users/userController');

/**
 * Public 라우트 (인증 불필요)
 */
const publicRouter = express.Router();
publicRouter.post('/auth', userController.authenticate);
publicRouter.get('/:userCode', userController.getPublicProfile);

/**
 * Protected 라우트 (인증 필요 - index.js에서 미들웨어 적용)
 */
const protectedRouter = express.Router();
protectedRouter.get('/me', userController.getCurrentUser);
protectedRouter.put('/me', userController.updateCurrentUser);
protectedRouter.delete('/me', userController.deleteCurrentUser);
protectedRouter.post('/devices', userController.registerDevice);

module.exports = {
  public: publicRouter,
  protected: protectedRouter,
};
