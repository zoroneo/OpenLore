/**
 * IaC graph builder (spec-07).
 *
 * Dispatches files by language to the per-ecosystem parsers, merges their
 * normalized resource graphs, and projects the result onto the existing
 * FunctionNode/CallEdge/ClassNode primitives. Kept thin on purpose: all
 * parsing lives in the sibling ecosystem modules, mirroring src/core/scip/.
 */

import { extractTerraform } from './terraform.js';
import { extractKubernetes } from './kubernetes.js';
import { extractHelm } from './helm.js';
import { extractCloudFormation } from './cloudformation.js';
import { extractAnsible } from './ansible.js';
import { extractPulumi } from './pulumi.js';
import { extractCdk } from './cdk.js';
import { projectIacGraph, type ProjectedIac } from './project.js';
import { mergeIacGraphs, type IacGraph } from './types.js';

export { isIacLanguage, IAC_LANGUAGES } from './types.js';
export { classifyYaml } from './classify-yaml.js';
export type { ProjectedIac } from './project.js';

interface InFile { path: string; content: string; language: string }

/** Build the normalized IaC graph from a mixed file set (no projection). */
export function buildIacGraph(files: InFile[]): IacGraph {
  const byLang = (lang: string) => files.filter((f) => f.language === lang);
  const generalPurpose = files.filter(
    (f) => f.language === 'TypeScript' || f.language === 'JavaScript' || f.language === 'Python' || f.language === 'Go',
  );
  const graphs: IacGraph[] = [
    extractTerraform(byLang('Terraform')),
    extractKubernetes(byLang('Kubernetes')),
    extractHelm(byLang('Helm')),
    extractCloudFormation(byLang('CloudFormation')),
    extractAnsible(byLang('Ansible')),
    // Pulumi, CDK, and CDKTF ride on existing general-purpose languages, not an IaC tag.
    extractPulumi(generalPurpose),
    extractCdk(generalPurpose),
  ];
  return mergeIacGraphs(graphs);
}

/** Build and project the IaC graph onto existing graph primitives. */
export function buildProjectedIac(files: InFile[]): ProjectedIac {
  return projectIacGraph(buildIacGraph(files));
}
