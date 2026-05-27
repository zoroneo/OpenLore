package main

import (
	"github.com/pulumi/pulumi-aws/sdk/v6/go/aws/s3"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		bucket, err := s3.NewBucket(ctx, "logs", &s3.BucketArgs{})
		if err != nil {
			return err
		}
		_, err = s3.NewBucketPolicy(ctx, "logs-policy", &s3.BucketPolicyArgs{
			Bucket: bucket.ID(),
		})
		return err
	})
}
