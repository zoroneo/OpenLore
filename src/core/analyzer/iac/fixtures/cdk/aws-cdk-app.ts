import * as s3 from 'aws-cdk-lib/aws-s3';
import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'LogsBucket', {
      versioned: true,
    });

    new s3.BucketPolicy(this, 'LogsPolicy', {
      bucket: bucket,
    });
  }
}
