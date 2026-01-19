const admin = require('firebase-admin');
const config = require('../configs');

// Firebase Admin 초기화 (싱글톤)
if (!admin.apps.length) {
  try {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: config.FIREBASE.PROJECT_ID,
    });
  } catch (error) {
    console.error('Firebase Admin Init Failed:', error.message);
  }
}

const verifyIdToken = async (idToken) => {
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return decodedToken;
  } catch (error) {
    console.error('Token Verification Failed:', error.code);
    throw error;
  }
};

module.exports = {
  verifyIdToken,
  admin,
};