// S3 JSON 저장소. Lambda 와 러너가 같이 쓴다.
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const Bucket = () => process.env.QA_BUCKET;
export const SCENARIOS = 'scenarios.json';
export const runsKey = id => `runs/${id}.json`;

const notFound = e => e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404;
const conflict = e => [409, 412].includes(e.$metadata?.httpStatusCode);

export async function getBytes(Key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: Bucket(), Key }));
  return Buffer.from(await res.Body.transformToByteArray());
}

export async function putBytes(Key, Body, ContentType) {
  await s3.send(new PutObjectCommand({ Bucket: Bucket(), Key, Body, ContentType }));
}

export async function getJson(Key, fallback) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: Bucket(), Key }));
    return { data: JSON.parse(await res.Body.transformToString()), etag: res.ETag };
  } catch (e) {
    if (notFound(e)) return { data: fallback, etag: null };
    throw e;
  }
}

// ponytail: 파일 전체 read-modify-write. 시나리오가 수백 개를 넘거나 쓰기가 잦아지면 DB 로 옮긴다.
export async function updateJson(Key, fallback, fn, tries = 5) {
  for (let i = 0; ; i++) {
    const { data, etag } = await getJson(Key, fallback);
    const next = await fn(data);
    try {
      await s3.send(new PutObjectCommand({
        Bucket: Bucket(), Key, Body: JSON.stringify(next, null, 2), ContentType: 'application/json',
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' }),
      }));
      return next;
    } catch (e) {
      if (!conflict(e) || i + 1 >= tries) throw e;
    }
  }
}
