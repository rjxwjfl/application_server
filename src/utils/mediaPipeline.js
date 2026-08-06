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
 * 그래서 sharp 대신 포맷별 "세그먼트/청크 제거" 도구를 쓴다 — 셋 다 픽셀 데이터를
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
 *   - WebP(RLY-20260806-056): RIFF는 청크끼리 서로의 파일 오프셋을 참조하지 않는
 *     평면 구조라(JPEG·PNG와 같은 이유로 안전) `EXIF` 청크만 얕게 잘라낸다 —
 *     새 라이브러리 없이 손으로 RIFF를 훑는다(PNG의 chunk 분해·재조립과 동일 규모).
 *     libvips/sharp가 쓰는 WebP EXIF 청크 payload를 실측하니 `"Exif\x00\x00"` 접두사
 *     + TIFF 헤더로 **JPEG APP1 payload와 완전히 같은 포맷**이었다 — 그래서 새 TIFF
 *     파서를 짜지 않고 위 JPEG 스텝과 **같은 `piexifjs` 호출**을 그대로 재사용한다
 *     (`piexif.load()`가 `"Exif"`로 시작하는 문자열을 JPEG 래핑 없이 직접 받는 분기가
 *     있다 — 소스 확인). 픽셀 청크(`VP8`/`VP8L`/`ALPH`)는 전혀 읽지도 쓰지도 않는다.
 *     EXIF 청크는 완전히 지우지 않고 항상 남긴다(JPEG 스텝과 동일 이유 — Orientation만
 *     있는 최소 청크라도 유지) — 그래서 `VP8X` 청크의 "Exif 있음" 플래그를 건드릴
 *     필요가 없다(청크가 사라지는 경우가 없으므로).
 * 실측(node -e 스모크 테스트, 보고서 참조): 세 도구 전부 처리 전/후 raw 픽셀
 * 버퍼가 완전히 동일함을 확인했다(sharp().raw().toBuffer() 비교, WebP는 VP8/VP8L
 * 청크 바이트 자체가 손대지 않으므로 raw 비교보다 더 강한 보장 — 청크 단위 동일성).
 *
 * **처리 못 하는 이미지 포맷**(HEIC/HEIF·TIFF·BMP 등)은 재인코딩하지 않고
 * 원본 그대로 둔다(EXIF 미제거) — team-lead 지시("화질을 깎느니 그 포맷의 EXIF를
 * 남기는 편이 낫다"). 호출부가 이 사실을 반드시 로그로 남긴다. 다만 RLY-20260806-056
 * 판정으로 HEIC/HEIF는 애초에 `ALLOWED_IMAGE_MIME_TYPES`에 없어 presign 단계에서
 * 거부되므로(안드로이드 미지원 포맷), 이 파일까지 도달하는 경우가 사실상 없다.
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
const EXIF_STRIPPABLE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// RLY-20260806-056 — presign에서 대조하는 이미지 허용 목록. 문서(media.md §3-3)에 세부
// MIME 목록이 없어 User 판정 기준으로 정했다: "안드로이드가 네이티브로 여는 포맷을
// 허용한다 — 그 집합은 애플에서도 열린다(역은 성립하지 않는다)". JPEG·PNG·WebP·GIF는
// 안드로이드 BitmapFactory가 기본 지원하는 포맷이라 허용. HEIC/HEIF는 애플 전용
// 포맷(안드로이드 미지원)이라 거부 — "검증 불가능해서"가 아니라 "안드로이드가 못 열어서"가
// 근거다(검증 가능해져도 받을 이유가 없다). BMP는 안드로이드가 열지만, 클라가 이미
// presign 이전에 항상 WebP로 변환해 보내(media_compression_service.dart:67 — bmp도
// _isImagePath에 포함돼 compress() 대상) 서버가 image/bmp를 정상 경로로 받을 일이
// 없어 목록에 넣지 않았다 — 판단이 안 서면 넣지 않는다(team-lead 지시), 필요해지면 별도 판정.
// WebP는 059(클라 출력 JPEG/PNG 전환) 병합 이후에도 남긴다 — "059 병합 전 클라가 그것을
// 보내서"만이 아니라 "안드로이드 네이티브라 규칙상 정당"하다는 것이 근거다(team-lead 확인).
//
// ⚠️ GIF는 목록에 있지만(team-lead 최종 지시로 포함) 별도 클라 버그를 보고서(RLY-20260806-056)에
// 남겨뒀다 — 클라가 GIF만 압축 대상에서 빠뜨려(`_isImagePath`에 'gif' 없음) 실제로는 원본 GIF
// 바이트를 보내면서 content_type은 무조건 'image/webp'로 잘못 선언한다(storage_repository.dart:
// 107-116) — 그래서 지금은 이 목록에 gif가 있어도 정상 경로로 image/gif가 오지 않을 수 있다
// (Worker의 MIME 위변조 검사가 비동기로 거부한다). 서버 목록은 정책대로 넣었고, 클라 버그
// 자체는 클라이언트 코드라 여기서 고치지 않는다 — 별건.
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

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
 * WebP(RIFF)를 청크 단위로 훑는다. FourCC(4B) + size(4B LE) + payload(size B) + 홀수면
 * 패딩 1B. RIFF는 청크끼리 서로의 파일 오프셋을 참조하지 않는 평면 구조라(HEIC의 `iloc`처럼
 * 남이 가리키는 절대 오프셋이 없다) 순서대로 훑기만 하면 된다 — PNG 청크 훑기와 같은 이유로
 * 안전하다.
 * @param {Buffer} buffer - `RIFF....WEBP` 로 시작하는 전체 파일 버퍼.
 * @returns {{ fourCC: string, data: Buffer }[]}
 */
function parseWebpChunks(buffer) {
  const chunks = [];
  let offset = 12; // 'RIFF'(4) + size(4) + 'WEBP'(4) 다음부터.
  while (offset + 8 <= buffer.length) {
    const fourCC = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.length) break; // 잘렸거나 손상된 파일 — 남은 바이트는 무시하고 훑기 종료.
    chunks.push({ fourCC, data: buffer.slice(dataStart, dataEnd) });
    offset = dataEnd + (size % 2); // 청크 payload는 짝수 바이트로 패딩된다.
  }
  return chunks;
}

/**
 * `parseWebpChunks`가 훑은 청크 목록을 다시 유효한 WebP 파일 버퍼로 조립한다.
 * @param {{ fourCC: string, data: Buffer }[]} chunks
 * @returns {Buffer}
 */
function buildWebpBuffer(chunks) {
  const parts = [];
  for (const { fourCC, data } of chunks) {
    const header = Buffer.alloc(8);
    header.write(fourCC, 0, 4, 'ascii');
    header.writeUInt32LE(data.length, 4);
    parts.push(header, data);
    if (data.length % 2 === 1) parts.push(Buffer.from([0]));
  }
  const body = Buffer.concat(parts);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0, 4, 'ascii');
  riffHeader.writeUInt32LE(body.length + 4, 4); // RIFF size = 이후 전체 바이트('WEBP' 4B 포함).
  riffHeader.write('WEBP', 8, 4, 'ascii');
  return Buffer.concat([riffHeader, body]);
}

/**
 * Step3 — WebP의 EXIF 청크를 선택적으로 제거한다(RLY-20260806-056). VP8/VP8L/ALPH(픽셀) 청크는
 * 읽지도 쓰지도 않는다 — EXIF 청크만 찾아 교체하고 나머지 청크는 훑은 그대로 재조립한다.
 *
 * libvips/sharp가 쓰는 WebP EXIF payload를 실측하니 `"Exif\x00\x00"` + TIFF 헤더로 JPEG APP1
 * payload와 완전히 같은 포맷이었다 — `stripJpegExif`와 동일한 piexifjs 호출(Orientation만
 * 남기고 GPS·Make·Model·DateTimeOriginal·DateTimeDigitized·임베디드 썸네일 제거)을 그대로
 * 재사용한다. EXIF 청크는 완전히 지우지 않고 항상 남긴다(Orientation만 있어도) — 그래서
 * `VP8X`의 "Exif 있음" 플래그를 건드릴 필요가 없다.
 *
 * `"Exif\x00\x00"` 접두사가 없는(TIFF 헤더로 바로 시작하는) 인코더의 산출물도 있을 수 있어
 * 접두사 유무를 감지해 없으면 붙였다가 dump 후 다시 뗀다 — 원래 형태를 보존한다.
 * @param {Buffer} buffer - 전체 WebP 파일 버퍼.
 * @returns {{ buffer: Buffer, applied: boolean, reason?: string }}
 */
function stripWebpExif(buffer) {
  const chunks = parseWebpChunks(buffer);
  const exifIndex = chunks.findIndex((c) => c.fourCC === 'EXIF');
  if (exifIndex === -1) {
    return { buffer, applied: true }; // 지울 EXIF 청크가 없다 — 이미 깨끗함.
  }

  const raw = chunks[exifIndex].data;
  const hasPrefix = raw.length >= 6 && raw.toString('binary', 0, 6) === 'Exif\x00\x00';
  const loadInput = hasPrefix ? raw.toString('binary') : 'Exif\x00\x00' + raw.toString('binary');

  let exifDict;
  try {
    exifDict = piexif.load(loadInput);
  } catch (err) {
    // 파싱 불가한 EXIF 청크 — 재인코딩·손상 위험을 감수하지 않고 원본을 그대로 둔다
    // (047의 "처리 못 하면 원본 유지" 원칙과 동일).
    return { buffer, applied: false, reason: `webp_exif_unparseable:${err.message}` };
  }

  const orientation = exifDict['0th'] ? exifDict['0th'][piexif.ImageIFD.Orientation] : undefined;
  const newZeroth = {};
  if (orientation !== undefined) newZeroth[piexif.ImageIFD.Orientation] = orientation;

  const sanitizedDict = { '0th': newZeroth, Exif: {}, GPS: {}, Interop: {}, '1st': {}, thumbnail: null };
  const dumpedBinary = piexif.dump(sanitizedDict); // 항상 "Exif\x00\x00" + TIFF로 시작(piexifjs 고정 헤더).
  const newPayload = Buffer.from(hasPrefix ? dumpedBinary : dumpedBinary.slice(6), 'binary');

  const newChunks = chunks.slice();
  newChunks[exifIndex] = { fourCC: 'EXIF', data: newPayload };
  return { buffer: buildWebpBuffer(newChunks), applied: true };
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
  if (detectedMime === 'image/webp') {
    return stripWebpExif(buffer);
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
  stripWebpExif,
  parseWebpChunks,
  buildWebpBuffer,
  generateImageThumbnail,
  generateVideoPoster,
  EXIF_STRIPPABLE_MIME_TYPES,
  PNG_METADATA_CHUNK_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
};
