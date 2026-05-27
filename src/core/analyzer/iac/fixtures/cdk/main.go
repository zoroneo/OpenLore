package main

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awss3"
	"github.com/aws/jsii-runtime-go"
)

func build(stack awscdk.Stack) {
	bucket := awss3.NewBucket(stack, jsii.String("Logs"), &awss3.BucketProps{})
	awss3.NewBucketPolicy(stack, jsii.String("LogsPolicy"), &awss3.BucketPolicyProps{
		Bucket: bucket,
	})
}
