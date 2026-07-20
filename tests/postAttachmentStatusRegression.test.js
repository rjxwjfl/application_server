const assert = require('assert');
const Module = require('module');

const attachmentRows = [
  'pending',
  'processing',
  'ready',
  'hidden',
  'deleted',
  'rejected',
  'error',
].map((status) => ({ id: `attachment-${status}`, status }));

const stubs = {
  '../daos/postDAO': { PostDAO: {} },
  '../daos/attachmentDAO': {
    AttachmentDAO: {
      async findByContext(_conn, contextType, contextId) {
        assert.strictEqual(contextType, 'POST');
        assert.strictEqual(contextId, 'post-1');
        return attachmentRows;
      },
    },
  },
  '../daos/drawerDAO': { DrawerDAO: {} },
  '../utils/uuid': { generateUUID: () => 'generated-id' },
  '../events/eventBus': { emit() {} },
  '../../config/db': {},
  '../core/errors': {
    NotFoundError: class NotFoundError extends Error {},
    ForbiddenError: class ForbiddenError extends Error {},
  },
  '../utils/typeDefinitions': { TargetType: {}, ActionType: {} },
};

const originalLoad = Module._load;
Module._load = function loadWithStubs(request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};

async function run() {
  try {
    const { PostService } = require('../src/services/postService');
    const rendered = await PostService.withAttachments({ id: 'post-1' });

    assert.deepStrictEqual(rendered.attachments, [
      { id: 'attachment-ready', status: 'ready' },
    ]);
  } finally {
    Module._load = originalLoad;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
