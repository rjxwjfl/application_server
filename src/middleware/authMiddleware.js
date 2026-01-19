const admin = require('firebase-admin'); 

const firebaseAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        success: false,
        message: '인증 토큰이 제공되지 않았습니다.' 
      });
    }

    const idToken = authHeader.split('Bearer ')[1];

    // 토큰 검증 (여기서 실패하면 catch 블록으로 이동)
    // 리턴값을 변수에 할당하지 않고 검증 통과 여부만 확인합니다.
    await admin.auth().verifyIdToken(idToken);

    // 검증 성공 시 바로 다음 미들웨어/컨트롤러로 이동
    next();
  } catch (error) {
    console.error('Firebase Auth Error:', error.code, error.message);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({ success: false, message: '토큰이 만료되었습니다.' });
    }
    
    return res.status(401).json({ 
      success: false,
      message: '유효하지 않은 토큰입니다.' 
    });
  }
};

module.exports = { firebaseAuth };