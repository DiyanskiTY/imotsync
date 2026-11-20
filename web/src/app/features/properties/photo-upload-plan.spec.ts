import { DEFAULT_UPLOAD_LIMITS } from '../../core/client-config/client-config';
import { formatMegabytes, planPhotoUpload } from './photo-upload-plan';

function file(name: string, type = 'image/jpeg', size = 1_000): File {
  const blob = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(blob, 'size', { value: size });
  return blob;
}

describe('planPhotoUpload', () => {
  it('accepts JPEG, PNG, WebP and AVIF and splits them into batches of 20', () => {
    const files = Array.from({ length: 25 }, (_, i) => file(`p${i}.jpg`));
    const plan = planPhotoUpload([...files, file('a.png', 'image/png')], 0);

    expect(plan.rejected).toEqual([]);
    expect(plan.batches.map((batch) => batch.length)).toEqual([20, 6]);
    expect(plan.totalBytes).toBe(26_000);
  });

  it('accepts a known extension when the browser reports no type', () => {
    const plan = planPhotoUpload([file('phone.AVIF', ''), file('scan.webp', '')], 0);
    expect(plan.rejected).toEqual([]);
  });

  it('rejects other formats and files over 15 MB, with a reason', () => {
    const big = file('huge.jpg', 'image/jpeg', DEFAULT_UPLOAD_LIMITS.maxFileBytes + 1);
    const plan = planPhotoUpload([file('a.gif', 'image/gif'), big, file('ok.jpg')], 0);

    expect(plan.batches).toEqual([[expect.objectContaining({ name: 'ok.jpg' })]]);
    expect(plan.rejected).toEqual([
      { name: 'a.gif', reason: 'not a JPEG, PNG, WebP or AVIF image' },
      { name: 'huge.jpg', reason: 'larger than 15 MB' },
    ]);
  });

  it('keeps the property within 40 photos', () => {
    const plan = planPhotoUpload([file('1.jpg'), file('2.jpg'), file('3.jpg')], 38);
    expect(plan.batches.flat().map((f) => f.name)).toEqual(['1.jpg', '2.jpg']);
    expect(plan.rejected).toEqual([{ name: '3.jpg', reason: 'a property has at most 40 photos' }]);
  });

  it('applies the limits the API reports, such as the lower ones of the public demo', () => {
    const demo = { maxFileBytes: 5 * 1024 * 1024, maxFilesPerRequest: 2, maxPerProperty: 4 };
    const big = file('big.jpg', 'image/jpeg', demo.maxFileBytes + 1);
    const plan = planPhotoUpload([file('1.jpg'), big, file('2.jpg'), file('3.jpg')], 1, demo);

    expect(plan.batches.map((batch) => batch.map((f) => f.name))).toEqual([
      ['1.jpg', '2.jpg'],
      ['3.jpg'],
    ]);
    expect(plan.rejected).toEqual([{ name: 'big.jpg', reason: 'larger than 5 MB' }]);
  });

  it('formats sizes in megabytes', () => {
    expect([15, 5, 2.5].map((mb) => formatMegabytes(mb * 1024 * 1024))).toEqual([
      '15 MB',
      '5 MB',
      '2.5 MB',
    ]);
  });
});
