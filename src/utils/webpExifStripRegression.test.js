/**
 * src/utils/webpExifStripRegression.test.js
 * =========================================
 * RLY-20260806-056 — WebP EXIF 파기(재인코딩 없음) 회귀.
 *
 * 이 저장소엔 테스트 프레임워크가 없다(047 선례와 동일 관행) — plain assert + `node <file>.js`
 * 직접 실행. 진짜 `sharp`로 GPS·기기 모델·Orientation이 든 WebP를 만들어 실제 stripWebpExif를
 * 구동한다(가짜 DB 불필요 — 이 파일은 순수 함수만 테스트한다).
 *
 * 실행: node src/utils/webpExifStripRegression.test.js
 */

const assert = require('assert');
const sharp = require('sharp');
const piexif = require('piexifjs');
const {
  stripExif, stripWebpExif, parseWebpChunks, EXIF_STRIPPABLE_MIME_TYPES,
} = require('./mediaPipeline');

let pass = 0;
let fail = 0;
const failures = [];

async function check(desc, fn) {
  try {
    await fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${desc}: ${err.message}`);
  }
}

async function makeWebpWithGpsAndOrientation() {
  return sharp({ create: { width: 12, height: 20, channels: 3, background: { r: 10, g: 200, b: 30 } } })
    .webp({ quality: 90 })
    .withMetadata({
      orientation: 6,
      exif: { IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' } },
    })
    .toBuffer();
}

async function run() {
  // ============ ① GPS·기기 모델 제거 ============
  await check('WebP GPS·Make·Model 제거', async () => {
    const src = await makeWebpWithGpsAndOrientation();
    const result = stripWebpExif(src);
    assert.strictEqual(result.applied, true);
    const exifChunk = parseWebpChunks(result.buffer).find((c) => c.fourCC === 'EXIF');
    assert.ok(exifChunk, 'EXIF 청크는 완전히 지우지 않고 남겨야 한다(Orientation 보존을 위해)');
    const dict = piexif.load(exifChunk.data.toString('binary'));
    assert.strictEqual(dict['0th'][piexif.ImageIFD.Make], undefined, 'Make가 남아있으면 안 된다');
    assert.strictEqual(dict['0th'][piexif.ImageIFD.Model], undefined, 'Model이 남아있으면 안 된다');
    assert.deepStrictEqual(dict['GPS'], {}, 'GPS IFD가 비어 있어야 한다');
  });

  // ============ ② Orientation 보존 ============
  await check('WebP Orientation 보존', async () => {
    const src = await makeWebpWithGpsAndOrientation();
    const result = stripWebpExif(src);
    const metaBefore = await sharp(src).metadata();
    const metaAfter = await sharp(result.buffer).metadata();
    assert.strictEqual(metaAfter.orientation, metaBefore.orientation);
    assert.strictEqual(metaAfter.orientation, 6);
  });

  // ============ ③ 재인코딩 없음 — 픽셀 청크 바이트 완전 동일(raw 디코드보다 강한 보장) ============
  await check('WebP 픽셀 청크(VP8/VP8L) 바이트 완전 동일 — 재인코딩 안 함', async () => {
    const src = await makeWebpWithGpsAndOrientation();
    const result = stripWebpExif(src);
    const pixelBefore = parseWebpChunks(src).find((c) => c.fourCC === 'VP8 ' || c.fourCC === 'VP8L');
    const pixelAfter = parseWebpChunks(result.buffer).find((c) => c.fourCC === 'VP8 ' || c.fourCC === 'VP8L');
    assert.ok(pixelBefore && pixelAfter);
    assert.ok(pixelBefore.data.equals(pixelAfter.data), '픽셀 청크 바이트가 달라지면 재인코딩된 것이다');

    const rawBefore = await sharp(src).raw().toBuffer();
    const rawAfter = await sharp(result.buffer).raw().toBuffer();
    assert.ok(rawBefore.equals(rawAfter), 'raw 디코드 결과도 동일해야 한다(047과 동일 검증 방식)');
  });

  // ============ ④ ICCP 등 다른 청크는 건드리지 않는다 ============
  await check('WebP ICCP 청크 불변', async () => {
    const src = await makeWebpWithGpsAndOrientation();
    const iccpBefore = parseWebpChunks(src).find((c) => c.fourCC === 'ICCP');
    const result = stripWebpExif(src);
    const iccpAfter = parseWebpChunks(result.buffer).find((c) => c.fourCC === 'ICCP');
    assert.ok(iccpBefore && iccpAfter);
    assert.ok(iccpBefore.data.equals(iccpAfter.data));
  });

  // ============ ⑤ EXIF 청크가 없는 WebP — 통과, 무변경 ============
  await check('EXIF 청크 없는 WebP — 이미 깨끗하면 무변경 통과', async () => {
    const noExif = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp()
      .toBuffer();
    const result = stripWebpExif(noExif);
    assert.strictEqual(result.applied, true);
    assert.ok(result.buffer.equals(noExif));
  });

  // ============ ⑥ 재조립된 파일이 유효한 WebP로 디코드된다(구조 손상 없음) ============
  await check('재조립 결과가 유효한 WebP로 디코드된다', async () => {
    const src = await makeWebpWithGpsAndOrientation();
    const result = stripWebpExif(src);
    const meta = await sharp(result.buffer).metadata();
    assert.strictEqual(meta.format, 'webp');
    assert.strictEqual(meta.width, 12);
    assert.strictEqual(meta.height, 20);
  });

  // ============ ⑦ stripExif 디스패처가 webp를 webp 전용 경로로 보낸다 ============
  await check('stripExif 디스패처 — image/webp는 stripWebpExif로 분기', async () => {
    assert.ok(EXIF_STRIPPABLE_MIME_TYPES.has('image/webp'));
    const src = await makeWebpWithGpsAndOrientation();
    const result = stripExif(src, 'image/webp');
    assert.strictEqual(result.applied, true);
    const exifChunk = parseWebpChunks(result.buffer).find((c) => c.fourCC === 'EXIF');
    const dict = piexif.load(exifChunk.data.toString('binary'));
    assert.deepStrictEqual(dict['GPS'], {});
  });

  // ============ ⑧ 기존 JPEG·PNG 처리 불변(047 회귀와 같은 결론을 여기서도 확인) ============
  await check('stripExif 디스패처 — JPEG·PNG는 기존과 동일하게 unsupported가 아니다', async () => {
    const jpegBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Make: 'Apple' } } })
      .toBuffer();
    const jpegResult = stripExif(jpegBytes, 'image/jpeg');
    assert.strictEqual(jpegResult.applied, true);

    const pngBytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const pngResult = stripExif(pngBytes, 'image/png');
    assert.strictEqual(pngResult.applied, true);
  });
  await check('stripExif 디스패처 — 여전히 지원하지 않는 포맷(예: HEIC)은 applied:false', () => {
    const heicResult = stripExif(Buffer.from('fake'), 'image/heic');
    assert.strictEqual(heicResult.applied, false);
    assert.ok(heicResult.reason.startsWith('unsupported_format'));
  });

  console.log(`\n[webpExifStripRegression] PASS=${pass} FAIL=${fail} (총 ${pass + fail}건)`);
  if (failures.length) {
    console.log('--- 실패 목록 ---');
    failures.forEach((f) => console.log(' - ' + f));
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('[webpExifStripRegression] 실행 실패:', error);
  process.exitCode = 1;
});
