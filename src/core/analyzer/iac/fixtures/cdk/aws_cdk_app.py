from aws_cdk import aws_s3 as s3
from constructs import Construct


class MyStack:
    def __init__(self, scope: Construct, id: str):
        bucket = s3.Bucket(self, "DataBucket", versioned=True)
        s3.BucketPolicy(self, "DataPolicy", bucket=bucket)
