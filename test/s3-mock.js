// S3Client.send 를 메모리로 바꾼다. IfMatch / IfNoneMatch 도 S3 처럼 412 로 거절한다.
import { S3Client } from '@aws-sdk/client-s3';

export const objects = new Map();
let version = 0;

const failure = (name, code) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });

S3Client.prototype.send = async function (cmd) {
  const { Key, Body, IfMatch, IfNoneMatch } = cmd.input;
  const found = objects.get(Key);
  if (cmd.constructor.name === 'GetObjectCommand') {
    if (!found) throw failure('NoSuchKey', 404);
    return {
      ETag: found.etag,
      Body: { transformToString: async () => found.body.toString(), transformToByteArray: async () => new Uint8Array(found.body) },
    };
  }
  if (IfMatch && found?.etag !== IfMatch) throw failure('PreconditionFailed', 412);
  if (IfNoneMatch === '*' && found) throw failure('PreconditionFailed', 412);
  const etag = `"${++version}"`;
  objects.set(Key, { body: Buffer.from(Body), etag });
  return { ETag: etag };
};
