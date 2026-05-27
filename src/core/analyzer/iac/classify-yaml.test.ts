import { describe, it, expect } from 'vitest';
import { classifyYaml } from './classify-yaml.js';

describe('classifyYaml', () => {
  const cases: Array<[string, string, string, ReturnType<typeof classifyYaml>]> = [
    ['k8s deployment', 'deploy.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n', 'Kubernetes'],
    ['cfn header', 'tpl.yaml', "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}\n", 'CloudFormation'],
    ['sam transform', 'tpl.yaml', 'Transform: AWS::Serverless-2016-10-31\nResources: {}\n', 'CloudFormation'],
    ['cfn resources type', 'tpl.yaml', 'Resources:\n  Bucket:\n    Type: AWS::S3::Bucket\n', 'CloudFormation'],
    ['helm chart', 'mychart/Chart.yaml', 'name: mychart\nversion: 1.0.0\n', 'Helm'],
    ['helm template', 'mychart/templates/svc.yaml', 'kind: Service\nmetadata:\n  name: {{ .Release.Name }}\n', 'Helm'],
    ['ansible playbook', 'site.yml', '- name: play\n  hosts: all\n  tasks: []\n', 'Ansible'],
    ['ansible role tasks', 'roles/web/tasks/main.yml', '- name: install\n  ansible.builtin.package:\n    name: nginx\n', 'Ansible'],
    ['generic ci config', '.github/workflows/ci.yml', 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n', null],
    ['docker compose', 'docker-compose.yml', 'version: "3"\nservices:\n  web:\n    image: nginx\n', null],
    ['plain app config', 'config.yaml', 'database:\n  host: localhost\n  port: 5432\n', null],
  ];

  for (const [label, path, content, expected] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(classifyYaml(path, content)).toBe(expected);
    });
  }
});
