import * as aws from "@pulumi/aws";

const logs = new aws.s3.Bucket("logs", {
  acl: "private",
});

export const policy = new aws.s3.BucketPolicy("logs-policy", {
  bucket: logs.id,
  policy: logs.arn,
});
