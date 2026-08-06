/**
 * src/utils/mediaPipeline.js
 * =========================================
 * RLY-20260806-047 — media.md §4-4 Worker 파이프라인의 순수 처리 함수들.
 * DB·GCS 접근은 여기서 하지 않는다(순수 함수 — 파일 경로/버퍼를 받아 파일 경로/버퍼를 낸다).
 * 호출부(mediaWorkerJobs.js)가 GCS 다운로드/업로드와 DB 갱신을 담당한다.
 *
 * ── EXIF 파기 도구 선택 (문서 지정 없음 — team-lead 요청대로 여기 근거를 남긴다) ──
 * media.md Step3은 "sharp 라이브러리로 이미지 리드"라고 쓰여 있지만, 실측 확인 결과
 * sharp는 읽기→변환→쓰기 파이프라인이라 메타데이터만 남기고 픽셀 데이터를 원본과
 * 바이트 단위로 동일하게 유지할 방법이 없다(항상 재인코딩) — "원본 보존·압축·인코딩
 * 없음"(CHANGELOG:278)과 정면 충돌한다(진단 및 판정: 047 투자 보고서, 팀리드 승인).
 * 그래서 sharp 대신 포맷별 "세그먼트/청크 제거" 도구를 쓴다 — 둘 다 픽셀 데이터를
 * 감싸는 봉투만 열어 메타데이터 블록을 도려내고 나머지 바이트는 그대로 둔다:
 *   - JPEG: `piexifjs`(Python piexif 포트, 순수 JS) — EXIF APP1 세그먼트 전체를
 *     찾아 제거한다. GPS·기기 모델·촬영 시각·임베디드 썸네일이 전부 이 APP1
 *     세그먼트 안에 있으므로 한 번에 다 지워진다(media.md:241 "GPS, 기기 모델,
 *     촬영 시각, 썸네일 EXIF 제거"를 통째로 만족).
 *   - PNG: `png-chunks-extract`/`png-chunks-encode`(순수 JS, 청크 분해·재조립만
 *     한다) — `eXIf`·`tEXt`·`zTXt`·`iTXt`·`tIME` 청크(전부 메타데이터 전용 청크
 *     타입, PNG 스펙상 픽셀 데이터가 아니다)만 걸러내고 `IHDR`·`IDAT`·`IEND`
 *     등은 그대로 둔다. `iCCP`(색상 프로파일)는 프라이버시 데이터가 아니라
 *     제거 목록에서 뺐다 — 지우면 색이 달라져 보일 수 있다.
 * 실측(node -e 스모크 테스트, 보고서 참조): 두 도구 모두 처리 전/후 raw 픽셀
 * 버퍼가 완전히 동일함을 확인했다(sharp().raw().toBuffer() 비교).
 *
 * **처리 못 하는 이미지 포맷**(WebP·HEIC/HEIF·TIFF·BMP 등)은 재인코딩하지 않고
 * 원본 그대로 둔다(EXIF 미제거) — team-lead 지시("화질을 깎느니 그 포맷의 EXIF를
 * 남기는 편이 낫다"). 호출부가 이 사실을 반드시 로그로 남긴다.
 * =========================================
 */

const { execFile } = require('child_process');
const fileType = require('file-type');
const sharp = require('sharp');
const piexif = require('piexifjs');
const extractPngChunks = require('png-chunks-extract');
const encodePngChunks = require('png-chunks-encode');
const ffmpegPath = require('ffmpeg-static');

// PNG 메타데이터 전용 청크 타입(PNG 스펙 ancillary chunk) — 픽셀 데이터(IHDR·PLTE·IDAT)나
// 구조 필수 청크(IEND)는 포함하지 않는다.
const PNG_METADATA_CHUNK_TYPES = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

// Step3이 세그먼트/청크 단위로 EXIF를 제거할 수 있는 이미지 포맷 — 나머지는 미지원(원본 유지).
const EXIF_STRIPPABLE_MIME_TYPES = new Set(['image/jpeg', 'image/png']);

/**
 * Step1 — 매직 바이트로 실제 MIME을 감지한다(media.md:221-223, 문서 예시 지정: file-type).
 * @param {Buffer} buffer - 파일의 선두 바이트(전체를 줘도 되지만 file-type은 앞부분만 본다).
 * @returns {Promise<string|null>} 감지된 MIME. 감지 불가(매직 바이트가 없는 포맷 — 예: 일부
 *   텍스트·문서)면 null — 이 경우 "위조"라고 단정할 근거가 없으므로 호출부는 거부하지 않는다
 *   (판단 근거: 047 구현 보고서 "MIME 미감지" 절 참조 — 문서에 명시가 없어 직접 정한 해석).
 */
async function detectActualMimeType(buffer) {
  const detected = await fileType.fromBuffer(buffer);
  return detected ? detected.mime : null;
}

/**
 * Step3 — JPEG의 EXIF를 선택적으로 제거한다. 픽셀 데이터(스캔 바이트)는 건드리지 않는다.
 *
 * 문서(media.md:241)가 지운다고 명시한 건 "GPS, 기기 모델, 촬영 시각, 썸네일" 넷뿐이다 —
 * `Orientation`(회전 방향 태그)은 그 목록에 없다. 그런데 세로로 찍은 사진 상당수는 픽셀
 * 자체가 회전돼 있지 않고 이 태그로만 "90도 돌려서 보여줘"라고 지시한다 — EXIF 전체를
 * 지우면(구 구현에서 `piexif.remove()`로 시도했던 방식) 뷰어가 회전 지시를 잃어 그 사진들이
 * 옆으로 눕는다. 그래서 GPS·Make·Model·DateTimeOriginal·DateTimeDigitized·임베디드 썸네일만
 * 지우고 `Orientation`은 남긴다 — 문서가 지운다고 한 것만 정확히 지운다.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function stripJpegExif(buffer) {
  const binary = buffer.toString('binary');
  const loaded = piexif.load(binary);

  const orientation = loaded['0th'] ? loaded['0th'][piexif.ImageIFD.Orientation] : undefined;
  const newZeroth = {};
  if (orientation !== undefined) newZeroth[piexif.ImageIFD.Orientation] = orientation;

  const newExifObj = { '0th': newZeroth, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  const newExifBytes = piexif.dump(newExifObj);
  const strippedBinary = piexif.insert(newExifBytes, binary);
  return Buffer.from(strippedBinary, 'binary');
}

/**
 * Step3 — PNG의 메타데이터 전용 청크(eXIf·tEXt·zTXt·iTXt·tIME)를 제거한다. IDAT(픽셀 데이터)는
 * 건드리지 않는다.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
function stripPngExif(buffer) {
  const chunks = extractPngChunks(buffer);
  const filtered = chunks.filter((chunk) => !PNG_METADATA_CHUNK_TYPES.has(chunk.name));
  return Buffer.from(encodePngChunks(filtered));
}

/**
 * Step3 디스패처 — 지원 포맷이면 세그먼트/청크 단위로 제거, 아니면 원본을 그대로 반환한다
 * (재인코딩 안 함 — team-lead 지시).
 * @param {Buffer} buffer
 * @param {string} detectedMime - Step1이 실제로 감지한 MIME(클라 선언값이 아니다).
 * @returns {{ buffer: Buffer, applied: boolean, reason?: string }}
 */
function stripExif(buffer, detectedMime) {
  if (detectedMime === 'image/jpeg') {
    return { buffer: stripJpegExif(buffer), applied: true };
  }
  if (detectedMime === 'image/png') {
    return { buffer: stripPngExif(buffer), applied: true };
  }
  return { buffer, applied: false, reason: `unsupported_format:${detectedMime || 'unknown'}` };
}

/**
 * Step4 — 이미지 파생 썸네일(WebP, 720px 이내, quality 80). sharp는 여기(파생 미디어)에서만
 * 쓴다 — 원본 파일에는 절대 쓰지 않는다(team-lead 지시, 2c 판정).
 * 720px 해석: 문서가 "가로냐 최대변이냐"를 명시하지 않아, 가로·세로 어느 쪽도 720을 넘지 않게
 * (fit: 'inside', 업스케일 안 함)로 해석했다 — 세로로 긴 사진이 원본보다 커지는 걸 막는다.
 * @param {Buffer} buffer - 원본(EXIF 제거 적용 후, 적용됐다면) 이미지 버퍼.
 * @returns {Promise<Buffer>} WebP 버퍼.
 */
async function generateImageThumbnail(buffer) {
  return sharp(buffer)
    .rotate() // EXIF Orientation 제거 전 회전 정보를 픽셀에 반영 — 스트립 후엔 방향 태그가 없다.
    .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Step4 — 비디오 포스터(WebP, 1초 지점 프레임, scale=720:-1). media.md:250 명령을 그대로
 * 옮긴다. `ffmpeg-static`(정적 바이너리 번들 — 시스템 ffmpeg 불필요, 로컬 검증 가능)을 쓴다.
 * @param {string} inputFilePath - GCS에서 내려받은 임시 파일 경로.
 * @param {string} outputFilePath - 포스터를 쓸 임시 파일 경로(.webp).
 * @returns {Promise<void>}
 */
function generateVideoPoster(inputFilePath, outputFilePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-y', '-ss', '00:00:01', '-i', inputFilePath, '-frames:v', '1', '-vf', 'scale=720:-1', outputFilePath],
      { timeout: 60 * 1000 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`ffmpeg poster generation failed: ${error.message} — ${stderr?.slice(0, 500)}`));
          return;
        }
        resolve();
      }
    );
  });
}

module.exports = {
  detectActualMimeType,
  stripExif,
  stripJpegExif,
  stripPngExif,
  generateImageThumbnail,
  generateVideoPoster,
  EXIF_STRIPPABLE_MIME_TYPES,
  PNG_METADATA_CHUNK_TYPES,
};
