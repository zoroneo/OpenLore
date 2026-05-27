import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { S3BucketPolicy } from '@cdktf/provider-aws/lib/s3-bucket-policy';

export function build(scope: Construct) {
  const bucket = new S3Bucket(scope, 'logs', {
    bucket: 'my-logs',
  });

  new S3BucketPolicy(scope, 'logs-policy', {
    bucket: bucket.id,
    policy: '{}',
  });
}
