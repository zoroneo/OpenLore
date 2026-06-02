// Spec-17 cross-domain fixture: an HTTP-style handler that calls a deploy
// function which provisions Pulumi resources. Demonstrates a code→infra blast
// radius: handleProvisionRequest → deployBucket → (Bucket:logs, BucketPolicy).
import * as aws from "@pulumi/aws";

export function handleProvisionRequest() {
  return deployBucket();
}

function deployBucket() {
  const logs = new aws.s3.Bucket("logs", { acl: "private" });
  const policy = new aws.s3.BucketPolicy("logs-policy", {
    bucket: logs.id,
    policy: logs.arn,
  });
  return policy;
}
