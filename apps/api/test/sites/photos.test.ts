import { describe, expect, it } from 'vitest';
import { verhoeffCheckDigit } from '@solar/shared';
import { IDS, T0 } from '../helpers/env';
import { API, makeEnv, scheduleSurvey, seedLead } from './fixtures';
import { jpegWithExif, plainJpeg } from './jpeg';

const jpg = (name = 'roof.jpg') => ({ filename: name, contentType: 'image/jpeg' });

async function setup() {
  const env = await makeEnv();
  const lead = await seedLead(env);
  const survey = await scheduleSurvey(env, lead);
  return { env, lead, survey, url: `${API}/surveys/${survey.id}/photos` };
}

describe('POST /surveys/:id/photos', () => {
  it('reads GPS and capture time from the JPEG EXIF block', async () => {
    const { env, survey, url } = await setup();
    const r = await env.as('dsm').post(url).attach('photos', jpegWithExif({ lat: 23.0225, lng: 72.5714, takenAt: '2026:10:26 10:30:00' }), jpg()).field('caption', 'North roof');
    expect(r.status).toBe(201);
    const p = r.body.data.uploaded[0];
    expect(p.geo_source).toBe('exif');
    expect(p.lat).toBeCloseTo(23.0225, 3);
    expect(p.lng).toBeCloseTo(72.5714, 3);
    expect(p.taken_at).toBe(T0.toISOString()); // 10:30 IST
    expect(p).toMatchObject({ index: 0, caption: 'North roof' });
    expect(r.body.data).toMatchObject({ photo_count: 1, max_photos: 10 });

    const row = (await env.db.table('site_surveys').get(survey.id))!;
    expect(row.photos).toHaveLength(1);
    expect(row.photos[0]!.path.startsWith(`${IDS.org}/survey/${survey.id}/`)).toBe(true);
    expect(env.providers.files.has(`site-photos/${row.photos[0]!.path}`)).toBe(true);
    const docs = await env.db.table('documents').all({ entity_id: survey.id });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ bucket: 'site-photos', doc_type: 'site_photo', entity_type: 'survey' });

    const signed = await env.as('dsm').get(`${API}/surveys/${survey.id}/photos/0/url`);
    expect(signed.status).toBe(200);
    expect(signed.body.data.url).toContain('https://fake.storage/site-photos/');
    expect(signed.body.data.photo.lat).toBeCloseTo(23.0225, 3);
    expect((await env.as('dsm').get(`${API}/surveys/${survey.id}/photos/5/url`)).status).toBe(404);
    expect((await env.as('dsm').get(`${API}/surveys/${survey.id}/photos/abc/url`)).status).toBe(404);
    expect((await env.as(IDS.distributorUserB).get(`${API}/surveys/${survey.id}/photos/0/url`)).status).toBe(403);
  });

  it('falls back to the lat/lng the browser sends when the image has no EXIF', async () => {
    const { env, url } = await setup();
    const client = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('a.jpg')).field('lat', '21.1702').field('lng', '72.8311').field('taken_at', '2026-10-26T09:00:00+05:30');
    expect(client.status).toBe(201);
    expect(client.body.data.uploaded[0]).toMatchObject({ geo_source: 'client', lat: 21.1702, lng: 72.8311, taken_at: '2026-10-26T03:30:00.000Z' });
    const none = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('b.jpg'));
    expect(none.body.data.uploaded[0]).toMatchObject({ geo_source: 'none', lat: null, lng: null, taken_at: null });
    // EXIF wins over client values
    const both = await env.as('dsm').post(url).attach('photos', jpegWithExif({ lat: 22.3, lng: 73.18 }), jpg('c.jpg')).field('lat', '1').field('lng', '1');
    expect(both.body.data.uploaded[0].geo_source).toBe('exif');
    expect(both.body.data.uploaded[0].lat).toBeCloseTo(22.3, 3);
    expect(both.body.data.uploaded[0].index).toBe(2);
  });

  it('takes one caption / position per file when the fields are repeated', async () => {
    const { env, survey, url } = await setup();
    const r = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('1.jpg')).attach('photos', plainJpeg(), jpg('2.png')).field('caption', 'First').field('caption', 'Second').field('lat', '23.1').field('lat', '23.2').field('lng', '72.1').field('lng', '72.2');
    expect(r.status).toBe(201);
    expect(r.body.data.uploaded.map((p: { caption: string; lat: number }) => [p.caption, p.lat])).toEqual([['First', 23.1], ['Second', 23.2]]);
    expect((await env.db.table('site_surveys').get(survey.id))!.photos).toHaveLength(2);
    expect((await env.as('dsm').get(`${API}/surveys/${survey.id}`)).body.data.photo_count).toBe(2);
  });

  it('rejects non-images, oversize files and Aadhaar-named files', async () => {
    const { env, survey, url } = await setup();
    const txt = await env.as('dsm').post(url).attach('photos', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(txt.status).toBe(415);
    const pdf = await env.as('dsm').post(url).attach('photos', Buffer.from('%PDF-1.4'), { filename: 'plan.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(415); // a PDF is a valid document upload elsewhere, but not a survey photo
    const big = await env.as('dsm').post(url).attach('photos', Buffer.alloc(10 * 1024 * 1024 + 1, 1), jpg('huge.jpg'));
    expect(big.status).toBe(413);
    const aad = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('aadhaar_front.jpg'));
    expect(aad.status).toBe(422);
    expect(aad.body.error.code).toBe('AADHAAR_BLOCKED');
    expect(await env.db.table('documents').count()).toBe(0);
    expect((await env.db.table('site_surveys').get(survey.id))!.photos).toEqual([]);
  });

  it('validates the whole batch before storing any of it', async () => {
    const { env, survey, url } = await setup();
    const mixed = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('good.jpg')).attach('photos', plainJpeg(), jpg('aadhaar_back.jpg'));
    expect(mixed.status).toBe(422);
    expect(await env.db.table('documents').count()).toBe(0);
    expect(env.providers.files.size).toBe(0);
    expect((await env.db.table('site_surveys').get(survey.id))!.photos).toEqual([]);

    const n = '23456789012' + verhoeffCheckDigit('23456789012');
    const cap = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg()).field('caption', `card ${n}`);
    expect(cap.body.error.code).toBe('AADHAAR_BLOCKED');
    const halfGeo = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg()).field('lat', '23.1');
    expect(halfGeo.status).toBe(422);
    const badLat = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg()).field('lat', '123').field('lng', '72');
    expect(badLat.status).toBe(422);
    const badTaken = await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg()).field('taken_at', 'yesterday');
    expect(badTaken.status).toBe(422);
    expect(await env.db.table('documents').count()).toBe(0);
  });

  it('caps a survey at 10 photos', async () => {
    const { env, survey, url } = await setup();
    const batch = async (n: number) => {
      let req = env.as('dsm').post(url);
      for (let i = 0; i < n; i++) req = req.attach('photos', plainJpeg(), jpg(`p${i}.jpg`));
      return req;
    };
    expect((await batch(5)).status).toBe(201);
    expect((await batch(5)).status).toBe(201);
    const over = await batch(1);
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/10 photos/);
    expect((await env.db.table('site_surveys').get(survey.id))!.photos).toHaveLength(10);
    expect((await batch(11)).status).toBe(422); // more files than one request may carry
  });

  it('needs the "photos" field, an open survey and access to the lead', async () => {
    const { env, survey, url } = await setup();
    expect((await env.as('dsm').post(url).attach('file', plainJpeg(), jpg())).status).toBe(400);
    expect((await env.as('dsm').post(url).send({})).status).toBe(400);
    expect((await env.as(IDS.distributorUserB).post(url).attach('photos', plainJpeg(), jpg())).status).toBe(403);
    expect((await env.as('viewer').post(url).attach('photos', plainJpeg(), jpg())).status).toBe(403);
    expect((await env.as('dealer_user').post(url).attach('photos', plainJpeg(), jpg())).status).toBe(201);
    await env.as('dsm').patch(`${API}/surveys/${survey.id}`).send({ status: 'cancelled', cancel_reason: 'Rain' });
    expect((await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg())).status).toBe(409);
  });

  it('honours the max-photos rule', async () => {
    const { env, url } = await setup();
    await env.rule('survey.max_photos', 2);
    expect((await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('1.jpg')).attach('photos', plainJpeg(), jpg('2.jpg'))).status).toBe(201);
    expect((await env.as('dsm').post(url).attach('photos', plainJpeg(), jpg('3.jpg'))).status).toBe(422);
  });
});
