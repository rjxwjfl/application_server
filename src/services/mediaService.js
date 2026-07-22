const { Storage } = require('@google-cloud/storage');
const { generateUUID } = require('../utils/uuid');
const pool = require('../../config/db');
const { NotFoundError, ForbiddenError } = require('../core/errors');
const { SectionDAO } = require('../daos/sectionDAO');

const storage = new Storage();

const SIGNED_URL_TTL = {
  image: 60 * 60,       // 1h
  video: 4 * 60 * 60,   // 4h
  document: 15 * 60,    // 15m
  default: 60 * 60,
};

function getTTL(contentType) {
  if (!contentType) return SIGNED_URL_TTL.default;
  if (contentType.startsWith('image/')) return SIGNED_URL_TTL.image;
  if (contentType.startsWith('video/')) return SIGNED_URL_TTL.video;
  return SIGNED_URL_TTL.document;
}

function getMediaBucket() {
  return process.env.GCS_BUCKET_MEDIA || 'rally-media';
}

function buildStorageKey(binderId, attachmentId, filename) {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const ext = filename ? filename.split('.').pop() : '';
  return `attachments/${binderId}/${yyyy}/${mm}/${attachmentId}${ext ? '.' + ext : ''}`;
}

class MediaService {
  /**
   * context_type: SECTION_MESSAGE | EVENT | TASK | POST | CAST | avatar | cover
   * context_id: UUID of the context entity
   * binder_id: UUID — required for non-avatar/cover contexts
   */
  async presign(data, context) {
    const { filename, content_type, file_size, context_type, context_id, binder_id } = data;
    const id = generateUUID();

    if (context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, context.sender_id))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
    }

    let storage_key;
    if (context_type === 'avatar' || context_type === 'cover') {
      // Avatar/cover use entity-centric path
      storage_key = `${context_type}s/${context_id}/${id}${filename ? '.' + filename.split('.').pop() : ''}`;
    } else {
      if (!binder_id) throw new Error('binder_id required for attachment contexts');
      storage_key = buildStorageKey(binder_id, id, filename);
    }

    const bucket = storage.bucket(getMediaBucket());
    const file = bucket.file(storage_key);

    const [uploadUrl] = await file.generateSignedPostPolicyV4({
      expires: Date.now() + 15 * 60 * 1000,
      conditions: [
        ['content-length-range', 1, 5 * 1024 * 1024 * 1024], // max 5GB
        ['starts-with', '$Content-Type', ''],
      ],
      fields: { 'Content-Type': content_type },
    });

    if (context_type !== 'avatar' && context_type !== 'cover') {
      await pool.query(
        `INSERT INTO attachments
           (id, binder_id, context_type, context_id, storage_key, filename,
            file_size, content_type, status, storage_class, uploader_id,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','standard',$9,now(),now())`,
        [id, binder_id, context_type, context_id || null,
         storage_key, filename || null, file_size || null,
         content_type || null, context.sender_id]
      );
    }

    return { id, upload_url: uploadUrl, storage_key };
  }

  async confirm(attachmentId, context) {
    const result = await pool.query(
      `UPDATE attachments
       SET status = 'ready', updated_at = now()
       WHERE id = $1 AND uploader_id = $2 AND status = 'pending'
       RETURNING *`,
      [attachmentId, context.sender_id]
    );

    if (!result.rows[0]) throw new NotFoundError('첨부 파일을 찾을 수 없거나 이미 처리되었습니다');
    return result.rows[0];
  }

  async getSignedUrl(attachmentId, userId) {
    const result = await pool.query(
      `SELECT id, storage_key, content_type, status, context_type, context_id FROM attachments WHERE id = $1`,
      [attachmentId]
    );
    const attachment = result.rows[0];
    if (!attachment) throw new NotFoundError('첨부 파일을 찾을 수 없습니다');
    if (attachment.context_type === 'SECTION_MESSAGE') {
      const sectionId = await SectionDAO.findSectionIdByMessage(pool, attachment.context_id);
      if (!sectionId || !(await SectionDAO.hasAccess(pool, sectionId, userId))) {
        throw new ForbiddenError('섹션 첨부 접근 권한이 없습니다', 'SECTION_ACCESS_DENIED');
      }
    }
    if (attachment.status === 'hidden') throw new ForbiddenError('잠긴 파일입니다. Boost로 복원하세요.');
    if (attachment.status === 'rejected') throw new ForbiddenError('접근할 수 없는 파일입니다');

    const ttl = getTTL(attachment.content_type);
    const bucket = storage.bucket(getMediaBucket());
    const file = bucket.file(attachment.storage_key);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + ttl * 1000,
    });

    return { url, expires_in: ttl };
  }

  async deleteAttachment(attachmentId, userId) {
    const result = await pool.query(
      `UPDATE attachments
       SET deleted_at = now(), updated_at = now()
       WHERE id = $1 AND uploader_id = $2 AND deleted_at IS NULL
       RETURNING storage_key`,
      [attachmentId, userId]
    );
    if (!result.rows[0]) throw new NotFoundError('첨부 파일을 찾을 수 없거나 권한이 없습니다');

    const { storage_key } = result.rows[0];
    try {
      const bucket = storage.bucket(getMediaBucket());
      await bucket.file(storage_key).delete({ ignoreNotFound: true });
    } catch {
      // GCS 삭제 실패는 로그만 남기고 200 반환 (DB 레코드는 이미 soft-delete)
    }
  }

  /**
   * Restore all hidden attachments for a binder after Boost purchase.
   * Called by webhook after payment confirmation.
   */
  async restoreBinderAttachments(binderId) {
    const result = await pool.query(
      `SELECT id, storage_key, storage_class FROM attachments
       WHERE binder_id = $1 AND status = 'hidden' AND deleted_at IS NULL`,
      [binderId]
    );
    const rows = result.rows;
    if (rows.length === 0) return 0;

    const bucket = storage.bucket(getMediaBucket());

    await Promise.allSettled(
      rows.map(async (att) => {
        const file = bucket.file(att.storage_key);
        if (att.storage_class === 'archive') {
          // GCS Archive restore requires a rewrite to Standard
          await file.copy(file, { storageClass: 'STANDARD' });
        } else if (att.storage_class !== 'standard') {
          await file.copy(file, { storageClass: 'STANDARD' });
        }
      })
    );

    const ids = rows.map((r) => r.id);
    await pool.query(
      `UPDATE attachments
       SET status = 'ready', storage_class = 'standard', hidden_at = NULL, updated_at = now()
       WHERE id = ANY($1)`,
      [ids]
    );

    return ids.length;
  }
}

module.exports = { MediaService: new MediaService() };
