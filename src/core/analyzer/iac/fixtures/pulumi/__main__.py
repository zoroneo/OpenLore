import pulumi_aws as aws

bucket = aws.s3.Bucket("data", acl="private")

policy = aws.s3.BucketPolicy("data-policy",
    bucket=bucket.id,
    policy=bucket.arn)
