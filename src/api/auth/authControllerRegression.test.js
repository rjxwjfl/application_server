const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../services/authService');
const authController = require('./authController');

test('register 응답은 서비스가 생성한 기본 binder를 API data에 보존한다', async (t) => {
  const originalRegister = authService.register;
  const expected = {
    user: { id: 'user-1' },
    settings: { language_code: 'ko' },
    binder: {
      binder: { id: 'binder-1' },
      settings: {},
      calendar: {},
      section: {},
      members: [{}],
      preferences: {},
    },
  };

  let receivedUser;
  let receivedBody;
  authService.register = async (user, body) => {
    receivedUser = user;
    receivedBody = body;
    return expected;
  };
  t.after(() => {
    authService.register = originalRegister;
  });

  let statusCode;
  let responseBody;
  let nextError;
  const req = { user: { uid: 'firebase-uid' }, body: { device_info: { device_uuid: 'device-1' } } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  await authController.register(req, res, (error) => {
    nextError = error;
  });

  assert.equal(nextError, undefined);
  assert.equal(statusCode, 201);
  assert.equal(receivedUser, req.user);
  assert.equal(receivedBody, req.body);
  assert.deepEqual(responseBody.data, expected);
  assert.equal(responseBody.data.binder.binder.id, 'binder-1');
});
